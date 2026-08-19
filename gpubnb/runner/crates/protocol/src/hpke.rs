//! §5 HPKE: request envelope (base mode for session open, PSK mode after) and
//! response frames (exporter-derived ChaCha20-Poly1305 stream).
//!
//! Suite: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305
//! (RFC 9180 ids 0x0020 / 0x0001 / 0x0003).

use crate::enc::{b64u, b64u_decode, b64u_decode_n};
use crate::{Error, Result};
use chacha20poly1305::aead::{Aead as _, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit};
use hpke::aead::ChaCha20Poly1305 as HpkeChaCha;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem as KemTrait, OpModeR, OpModeS, PskBundle, Serializable};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

type Kem = X25519HkdfSha256;
type Kdf = HkdfSha256;
type AeadS = HpkeChaCha;

pub const INFO_OPEN: &[u8] = b"gpubnb-open-v1";
pub const AAD_OPEN: &[u8] = b"gpubnb-open-v1";
pub const INFO_REQ: &[u8] = b"gpubnb-req-v1";
pub const AAD_REQ_PREFIX: &[u8] = b"gpubnb-req-v1";
pub const EXPORT_RESP_KEY: &[u8] = b"gpubnb-resp-key-v1";
pub const EXPORT_RESP_NONCE: &[u8] = b"gpubnb-resp-nonce-v1";

/// §5.1 request envelope: JSON body of every renter → runner POST.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Envelope {
    pub session_id: Option<String>,
    pub ctr: u64,
    pub enc: String,
    pub ct: String,
}

/// Which HPKE mode an envelope uses.
#[derive(Debug, Clone, Copy)]
pub enum HpkeMode<'a> {
    /// Session open: base mode, `info = aad = "gpubnb-open-v1"`.
    Open,
    /// All other calls: PSK mode, `psk = session_key`, `psk_id = session_id bytes`,
    /// `info = "gpubnb-req-v1"`, `aad = "gpubnb-req-v1" || session_id || ctr u64 BE`.
    Psk { session_key: &'a [u8; 32], session_id: &'a [u8; 16] },
}

/// Keys derived from one HPKE context for the sealed response stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseKeys {
    pub resp_key: [u8; 32],
    pub resp_base: [u8; 12],
    /// `SHA256(enc || ct)` over the raw bytes.
    pub req_hash: [u8; 32],
}

/// Result of opening a request envelope.
#[derive(Debug, Clone)]
pub struct OpenedRequest {
    pub plaintext: Vec<u8>,
    pub keys: ResponseKeys,
}

/// Generate an X25519 keypair `(sk, pk)` as raw 32-byte arrays.
pub fn gen_hpke_keypair() -> ([u8; 32], [u8; 32]) {
    let (sk, pk) = Kem::gen_keypair();
    (arr32(&sk.to_bytes()), arr32(&pk.to_bytes()))
}

/// Derive an X25519 keypair deterministically from IKM (tests / fixtures only).
pub fn derive_hpke_keypair(ikm: &[u8]) -> ([u8; 32], [u8; 32]) {
    let (sk, pk) = Kem::derive_keypair(ikm);
    (arr32(&sk.to_bytes()), arr32(&pk.to_bytes()))
}

/// Public key for an X25519 secret.
pub fn hpke_pub_from_sk(sk: &[u8; 32]) -> Result<[u8; 32]> {
    let sk = <Kem as KemTrait>::PrivateKey::from_bytes(sk).map_err(|e| Error::Hpke(e.to_string()))?;
    Ok(arr32(&Kem::sk_to_pk(&sk).to_bytes()))
}

fn arr32(a: &[u8]) -> [u8; 32] {
    let mut o = [0u8; 32];
    o.copy_from_slice(&a[..32]);
    o
}

fn req_aad(mode: &HpkeMode, ctr: u64) -> Vec<u8> {
    match mode {
        HpkeMode::Open => AAD_OPEN.to_vec(),
        HpkeMode::Psk { session_id, .. } => {
            let mut a = Vec::with_capacity(AAD_REQ_PREFIX.len() + 16 + 8);
            a.extend_from_slice(AAD_REQ_PREFIX);
            a.extend_from_slice(&session_id[..]);
            a.extend_from_slice(&ctr.to_be_bytes());
            a
        }
    }
}

fn info(mode: &HpkeMode) -> &'static [u8] {
    match mode {
        HpkeMode::Open => INFO_OPEN,
        HpkeMode::Psk { .. } => INFO_REQ,
    }
}

/// `req_hash = SHA256(enc || ct)` over raw bytes.
pub fn request_hash(enc: &[u8], ct: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(enc);
    h.update(ct);
    h.finalize().into()
}

fn export_keys<F: Fn(&[u8], &mut [u8]) -> std::result::Result<(), hpke::HpkeError>>(
    export: F,
    enc: &[u8],
    ct: &[u8],
) -> Result<ResponseKeys> {
    let mut resp_key = [0u8; 32];
    let mut resp_base = [0u8; 12];
    export(EXPORT_RESP_KEY, &mut resp_key).map_err(|e| Error::Hpke(e.to_string()))?;
    export(EXPORT_RESP_NONCE, &mut resp_base).map_err(|e| Error::Hpke(e.to_string()))?;
    Ok(ResponseKeys { resp_key, resp_base, req_hash: request_hash(enc, ct) })
}

/// Runner side: open an envelope with the runner's HPKE secret key.
pub fn open_envelope(hpke_sk: &[u8; 32], env: &Envelope, mode: HpkeMode) -> Result<OpenedRequest> {
    let sk = <Kem as KemTrait>::PrivateKey::from_bytes(hpke_sk).map_err(|e| Error::Hpke(e.to_string()))?;
    let enc_bytes: [u8; 32] = b64u_decode_n(&env.enc)?;
    let ct = b64u_decode(&env.ct)?;
    let encapped =
        <Kem as KemTrait>::EncappedKey::from_bytes(&enc_bytes).map_err(|e| Error::Hpke(e.to_string()))?;
    let aad = req_aad(&mode, env.ctr);
    let (plaintext, keys) = match mode {
        HpkeMode::Open => {
            let mut ctx = hpke::setup_receiver::<AeadS, Kdf, Kem>(&OpModeR::Base, &sk, &encapped, info(&mode))
                .map_err(|e| Error::Hpke(e.to_string()))?;
            let pt = ctx.open(&ct, &aad).map_err(|_| Error::Aead)?;
            let keys = export_keys(|i, o| ctx.export(i, o), &enc_bytes, &ct)?;
            (pt, keys)
        }
        HpkeMode::Psk { session_key, session_id } => {
            let bundle = PskBundle::new(&session_key[..], &session_id[..]).map_err(|e| Error::Hpke(e.to_string()))?;
            let mut ctx =
                hpke::setup_receiver::<AeadS, Kdf, Kem>(&OpModeR::Psk(bundle), &sk, &encapped, info(&mode))
                    .map_err(|e| Error::Hpke(e.to_string()))?;
            let pt = ctx.open(&ct, &aad).map_err(|_| Error::Aead)?;
            let keys = export_keys(|i, o| ctx.export(i, o), &enc_bytes, &ct)?;
            (pt, keys)
        }
    };
    Ok(OpenedRequest { plaintext, keys })
}

/// Renter side: seal a request to the runner's HPKE public key. Returns the
/// envelope and the response keys needed to decode the sealed reply.
pub fn seal_envelope(
    hpke_pub: &[u8; 32],
    plaintext: &[u8],
    mode: HpkeMode,
    ctr: u64,
) -> Result<(Envelope, ResponseKeys)> {
    let pk = <Kem as KemTrait>::PublicKey::from_bytes(hpke_pub).map_err(|e| Error::Hpke(e.to_string()))?;
    let aad = req_aad(&mode, ctr);
    let (enc, ct, keys, session_id) = match mode {
        HpkeMode::Open => {
            let (enc, mut ctx) = hpke::setup_sender::<AeadS, Kdf, Kem>(&OpModeS::Base, &pk, info(&mode))
                .map_err(|e| Error::Hpke(e.to_string()))?;
            let ct = ctx.seal(plaintext, &aad).map_err(|e| Error::Hpke(e.to_string()))?;
            let enc = enc.to_bytes().to_vec();
            let keys = export_keys(|i, o| ctx.export(i, o), &enc, &ct)?;
            (enc, ct, keys, None)
        }
        HpkeMode::Psk { session_key, session_id } => {
            let bundle = PskBundle::new(&session_key[..], &session_id[..]).map_err(|e| Error::Hpke(e.to_string()))?;
            let (enc, mut ctx) = hpke::setup_sender::<AeadS, Kdf, Kem>(&OpModeS::Psk(bundle), &pk, info(&mode))
                .map_err(|e| Error::Hpke(e.to_string()))?;
            let ct = ctx.seal(plaintext, &aad).map_err(|e| Error::Hpke(e.to_string()))?;
            let enc = enc.to_bytes().to_vec();
            let keys = export_keys(|i, o| ctx.export(i, o), &enc, &ct)?;
            (enc, ct, keys, Some(b64u(session_id)))
        }
    };
    Ok((Envelope { session_id, ctr, enc: b64u(&enc), ct: b64u(&ct) }, keys))
}

fn frame_nonce(base: &[u8; 12], i: u32) -> [u8; 12] {
    let mut n = *base;
    let ib = i.to_be_bytes();
    // u96_be(i): the counter occupies the low-order (last) 4 bytes of the 12-byte nonce.
    for k in 0..4 {
        n[8 + k] ^= ib[k];
    }
    n
}

/// §5.2 frame encoder: `frame_i = u32_be(len) || seal(resp_key, resp_base XOR u96_be(i), aad = req_hash, flags || payload)`.
pub struct FrameEncoder {
    cipher: ChaCha20Poly1305,
    base: [u8; 12],
    aad: [u8; 32],
    next: u32,
    finished: bool,
}

pub const FLAG_FINAL: u8 = 0x01;

impl FrameEncoder {
    pub fn new(keys: &ResponseKeys) -> Self {
        FrameEncoder {
            cipher: ChaCha20Poly1305::new(&keys.resp_key.into()),
            base: keys.resp_base,
            aad: keys.req_hash,
            next: 0,
            finished: false,
        }
    }

    /// Counter of the next frame.
    pub fn next_index(&self) -> u32 {
        self.next
    }

    pub fn finished(&self) -> bool {
        self.finished
    }

    /// Encode one frame. Panics if called after a final frame (programming error).
    pub fn frame(&mut self, is_final: bool, payload: &[u8]) -> Vec<u8> {
        assert!(!self.finished, "frame after final");
        let mut pt = Vec::with_capacity(1 + payload.len());
        pt.push(if is_final { FLAG_FINAL } else { 0 });
        pt.extend_from_slice(payload);
        let nonce = frame_nonce(&self.base, self.next);
        let ct = self
            .cipher
            .encrypt(&nonce.into(), Payload { msg: &pt, aad: &self.aad })
            .expect("chacha20poly1305 encrypt");
        self.next += 1;
        if is_final {
            self.finished = true;
        }
        let mut out = Vec::with_capacity(4 + ct.len());
        out.extend_from_slice(&(ct.len() as u32).to_be_bytes());
        out.extend_from_slice(&ct);
        out
    }
}

/// §5.2 frame decoder (renter side; also used in tests). Feed bytes as they
/// arrive; yields `(is_final, payload)` pairs. Rejects out-of-order frames
/// (the nonce makes them fail to open) and data after the final frame.
pub struct FrameDecoder {
    cipher: ChaCha20Poly1305,
    base: [u8; 12],
    aad: [u8; 32],
    next: u32,
    buf: Vec<u8>,
    done: bool,
}

impl FrameDecoder {
    pub fn new(keys: &ResponseKeys) -> Self {
        FrameDecoder {
            cipher: ChaCha20Poly1305::new(&keys.resp_key.into()),
            base: keys.resp_base,
            aad: keys.req_hash,
            next: 0,
            buf: Vec::new(),
            done: false,
        }
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<(bool, Vec<u8>)>> {
        if self.done && !bytes.is_empty() {
            return Err(Error::Frame("data after final frame".into()));
        }
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            if self.buf.len() < 4 {
                break;
            }
            let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            if self.buf.len() < 4 + len {
                break;
            }
            if self.done {
                return Err(Error::Frame("frame after final".into()));
            }
            let ct = self.buf[4..4 + len].to_vec();
            self.buf.drain(..4 + len);
            let nonce = frame_nonce(&self.base, self.next);
            let pt = self
                .cipher
                .decrypt(&nonce.into(), Payload { msg: &ct, aad: &self.aad })
                .map_err(|_| Error::Aead)?;
            if pt.is_empty() {
                return Err(Error::Frame("empty plaintext".into()));
            }
            self.next += 1;
            let is_final = pt[0] & FLAG_FINAL != 0;
            if is_final {
                self.done = true;
            }
            out.push((is_final, pt[1..].to_vec()));
        }
        Ok(out)
    }

    /// Call at end of stream: an error if no final frame was seen.
    pub fn finish(&self) -> Result<()> {
        if !self.done {
            return Err(Error::Frame("stream ended without final frame".into()));
        }
        if !self.buf.is_empty() {
            return Err(Error::Frame("trailing bytes".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_mode_roundtrip_and_keys_agree() {
        let (sk, pk) = gen_hpke_keypair();
        let (env, ckeys) = seal_envelope(&pk, br#"{"client_nonce":"x"}"#, HpkeMode::Open, 0).unwrap();
        assert!(env.session_id.is_none());
        let opened = open_envelope(&sk, &env, HpkeMode::Open).unwrap();
        assert_eq!(opened.plaintext, br#"{"client_nonce":"x"}"#);
        assert_eq!(opened.keys, ckeys);
    }

    #[test]
    fn psk_mode_binds_session_and_ctr() {
        let (sk, pk) = gen_hpke_keypair();
        let key = [9u8; 32];
        let sid = [5u8; 16];
        let mode = HpkeMode::Psk { session_key: &key, session_id: &sid };
        let (env, _) = seal_envelope(&pk, b"hello", mode, 7).unwrap();
        assert_eq!(env.ctr, 7);
        assert_eq!(open_envelope(&sk, &env, mode).unwrap().plaintext, b"hello");
        // wrong ctr in AAD
        let mut bad = env.clone();
        bad.ctr = 8;
        assert!(open_envelope(&sk, &bad, mode).is_err());
        // wrong psk
        let key2 = [1u8; 32];
        assert!(open_envelope(&sk, &env, HpkeMode::Psk { session_key: &key2, session_id: &sid }).is_err());
        // wrong mode
        assert!(open_envelope(&sk, &env, HpkeMode::Open).is_err());
    }

    #[test]
    fn frames_roundtrip_and_reject_reorder() {
        let keys = ResponseKeys { resp_key: [1; 32], resp_base: [2; 12], req_hash: [3; 32] };
        let mut enc = FrameEncoder::new(&keys);
        let f0 = enc.frame(false, b"a");
        let f1 = enc.frame(false, b"bb");
        let f2 = enc.frame(true, b"ccc");
        let mut dec = FrameDecoder::new(&keys);
        let mut all = Vec::new();
        all.extend_from_slice(&f0);
        all.extend_from_slice(&f1);
        all.extend_from_slice(&f2);
        // feed byte by byte
        let mut got = Vec::new();
        for b in &all {
            got.extend(dec.push(&[*b]).unwrap());
        }
        assert_eq!(got, vec![(false, b"a".to_vec()), (false, b"bb".to_vec()), (true, b"ccc".to_vec())]);
        dec.finish().unwrap();
        // reorder
        let mut dec2 = FrameDecoder::new(&keys);
        assert!(dec2.push(&f1).is_err());
        // missing final
        let mut dec3 = FrameDecoder::new(&keys);
        dec3.push(&f0).unwrap();
        assert!(dec3.finish().is_err());
        // wrong aad
        let keys2 = ResponseKeys { req_hash: [4; 32], ..keys.clone() };
        let mut dec4 = FrameDecoder::new(&keys2);
        assert!(dec4.push(&f0).is_err());
    }

    #[test]
    fn nonce_xor_low_order() {
        let n = frame_nonce(&[0; 12], 1);
        assert_eq!(n, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let n = frame_nonce(&[0xff; 12], 0x0102_0304);
        assert_eq!(&n[8..], &[0xfe, 0xfd, 0xfc, 0xfb]);
    }
}
