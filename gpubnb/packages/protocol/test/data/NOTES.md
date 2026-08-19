# Test data provenance

All files here are real (hardware-produced or live-service-fetched) unless
stated otherwise. Fetched 2026-08-19.

## AMD SEV-SNP

### Set A: Milan, report version 2 (from google/go-sev-guest)

| file | bytes | what |
|---|---|---|
| `report.bin` | 1184 | raw SNP attestation report, version 2 (LE u32 at offset 0 = 2) |
| `vcek.pem` | 1899 | VCEK for that chip, PEM (converted from DER `vcek.testcer`) |
| `vcek_kds_live.pem` | 1883 | same VCEK re-fetched live from AMD KDS on 2026-08-19 (same key, new validity window, see below) |
| `cert_chain_milan.pem` | 4602 | ASK then ARK, fetched from `https://kdsintf.amd.com/vcek/v1/Milan/cert_chain` |

Source: https://github.com/google/go-sev-guest, commit
`c930ed67bebfe7245c0309888ec185bd9ad35899`, directory `verify/testdata/`:
`attestation.bin` (= `report.bin`), `vcek.testcer` (DER, = `vcek.pem`),
`milan.testcer` (byte-identical to the live `cert_chain_milan.pem`).
The Go comment describes it as "an example attestation report from a VM that
was launched without an ID_BLOCK".

Report fields (decoded):
- version 2, guest_svn 0, policy 0x0000000000b0000, vmpl 0, sig_algo 1 (ECDSA P-384 / SHA-384)
- CURRENT_TCB = REPORTED_TCB = COMMITTED_TCB = LAUNCH_TCB = `0200000000000544`
  (bootloader 2, tee 0, snp 5, microcode 0x44=68)
- platform_info 0x1 (SMT enabled), flags 0x0
- REPORT_DATA = `0102030405` + zeros
- MEASUREMENT = `b07af9620f3b839b47996422ddec6058338951d984e312115131ea82705eaf5b6bdf8a9ece31a5a608eb0cf2e4872b01`
- CHIP_ID (offset 0x1A0, 64 B) = `3ac3fe21e13fb0990eb28a802e3fb6a29483a6b0753590c951bdd3b8e53786184ca39e359669a2b76a1936776b564ea464cdce40c05f63c9b610c5068b006b5d`
- current/committed version 1.49.3
- everything after signature (0x2a0 + 144 .. 1184) is zero

VCEK: subject `CN=SEV-VCEK`, issuer `CN=SEV-Milan`, P-384, RSA-PSS/SHA-384
signed, validity 2022-09-24 .. 2029-09-24, extension `1.3.6.1.4.1.3704.1.2`
= "Milan-B0".

What was verified (openssl 3.6.3):
- `openssl verify -CAfile ark.pem -untrusted ask.pem vcek.pem` -> OK
  (ask/ark split out of `cert_chain_milan.pem`; first cert = ASK `CN=SEV-Milan`,
  second = ARK `CN=ARK-Milan`, self-signed, valid 2020-10-22 .. 2045-10-22)
- hwID extension `1.3.6.1.4.1.3704.1.4` (64-byte OCTET STRING) == report CHIP_ID: MATCH
- Report ECDSA signature: r,s are 72-byte little-endian at 0x2a0/0x2e8; converted to
  DER and checked with `openssl dgst -sha384 -verify <vcek pubkey> -signature sig.der tbs.bin`
  where tbs = report[0:0x2a0] -> **Verified OK**
- Live KDS fetch
  `https://kdsintf.amd.com/vcek/v1/Milan/<chip_id>?blSPL=2&teeSPL=0&snpSPL=5&ucodeSPL=68`
  returns a VCEK with the identical public key but a fresh validity window
  (2026-08-18 .. 2033-08-18); AMD re-issues VCEKs with rolling dates, so a
  verifier must not pin the VCEK cert bytes, only the key / chain. Saved as
  `vcek_kds_live.pem` (also chains OK to the Milan ARK).

### Set B: Genoa, report version 3 (captured from a live Tinfoil SEV-SNP enclave)

| file | bytes | what |
|---|---|---|
| `report_genoa_v3.bin` | 1184 | raw SNP report, version 3 |
| `vcek_genoa.pem` | 1879 | matching VCEK (KDS response captured at the same time, DER -> PEM) |
| `cert_chain_genoa.pem` | 4602 | ASK+ARK for Genoa (capture is byte-identical to live `https://kdsintf.amd.com/vcek/v1/Genoa/cert_chain` fetched 2026-08-19) |

Source: https://github.com/13rac1/teep, commit
`6225560378de8425f652c554bcb68f4b6e2bdefe`,
`internal/integration/testdata/tinfoil_v3_cloud_llama3-3-70b_20260629_021249/responses/`:
- `0001_inference.tinfoil.sh_.well-known_tinfoil-attestation.body` -> JSON with
  `cpu.report` (base64 of the 1184-byte report; `cpu.platform` = "sev-snp")
- `0003_kdsintf.amd.com_vcek_v1_genoa_1af1aa6c...body` -> the VCEK DER; the
  recorded request URL was
  `https://kdsintf.amd.com/vcek/v1/Genoa/1af1aa6c1f56037a05849a59b8815cf909583f9ba9ef2f053218c437f33ba183e4e415b039b37f8205250ad15f8b88a0a3add9f4c081c0779a48ed2214378e44?blSPL=10&teeSPL=0&snpSPL=23&ucodeSPL=84`
- `0002_kdsintf.amd.com_vcek_v1_genoa_cert_chain.body` -> ASK+ARK

Report fields: version 3, policy 0x30000, vmpl 0, sig_algo 1,
TCB (all four) = `0a00000000001754` (bl 10, tee 0, snp 23, ucode 84),
platform_info 0x27, CPUID family/model/stepping bytes at 0x188 = 25/17/1
(v3-only fields), REPORT_DATA = `2133557c6bf8b68d0d542bb771fba885ee097b5930ec0880168d56a18e1d7b7d` + 32 zero bytes,
MEASUREMENT = `7adcb574b1e22ab579f3c883da3e5b6e632ef06775dd13fdb16850640135a5f63c7eb8741fe340c672edaf241bd1ed7c`,
CHIP_ID = `1af1aa6c...378e44` (the hwID in the KDS URL).

Verified: hwID ext == CHIP_ID (MATCH); report signature `Verified OK` against
`vcek_genoa.pem`; `openssl verify -CAfile ark -untrusted ask vcek_genoa.pem` -> OK
(ASK `CN=SEV-Genoa`, ARK `CN=ARK-Genoa`). VCEK validity 2026-06-28 .. 2033-06-28.

Turin: not collected (no need; the Turin chain is at
`https://kdsintf.amd.com/vcek/v1/Turin/cert_chain` if wanted).

## NVIDIA NRAS

### JWKS / issuer (confirmed from live service + official SDK source)

- JWKS URL: `https://nras.attestation.nvidia.com/.well-known/jwks.json`
  (HTTP 200, `application/json`). Derivation in nvtrust
  `guest_tools/attestation_sdk/src/nv_attestation_sdk/utils/nras_utils.py::create_jwks_url`
  = `{scheme}://{netloc}/.well-known/jwks.json` of the verifier URL; in
  NVIDIA/attestation-sdk (commit `73efa3ac1bec28ed7d7f0c0811a6c993e722dbd4`)
  `nv-attestation-sdk-cpp/src/gpu/verify.cpp`: `jwks_url = nras_url + "/.well-known/jwks.json"`,
  `m_eat_issuer = nras_url`, `DEFAULT_BASE_URL = "https://nras.attestation.nvidia.com"`
  (`include/nv_attestation/gpu/verify.h`). Attest endpoints: `/v3/attest/gpu`
  (nvtrust python SDK, returns `x-nvidia-ver` "2.0" claims) and `/v4/attest/gpu`
  (new C++/Rust SDK, granular `x-nvidia-ver` "3.0" claims); `/v3/attest/switch`, `/v4/attest/switch`.
- `https://nras.attestation.nvidia.com/.well-known/openid-configuration` -> 403 (does not exist).
  `/v1/jwks`, `/v3/.well-known/jwks.json`, `/v4/.well-known/jwks.json` -> 403.
- Issuer (`iss`): `https://nras.attestation.nvidia.com` exactly (staging:
  `https://nras.attestation-stg.nvidia.com`). Both SDKs compare `iss` to the NRAS base URL.
- `alg`: **ES384** only (python: `algorithms=["ES384"]`; C++: `jwt::algorithm::es384`).
  JWT header is `{"kid": "...", "alg": "ES384"}` (no `typ`).
- `kid` format: `nv-eat-kid-prod-<17-digit timestamp>-<uuid>`.
- JWKS shape (`nras-jwks.json`, 80970 bytes, 32 keys at fetch time): every key is
  `{"kty":"EC","crv":"P-384","kid":...,"x5c":[leaf, intermediate],"x":...,"y":...}`;
  no `alg`, no `use`. x5c leaf: `CN=NVIDIA Attestation Service GPU GH100, O=NVIDIA Corporation, C=US`,
  ECDSA, **valid only ~2 days** (e.g. 2026-08-18 09:36:55 .. 2026-08-20 09:37:25);
  issuer `CN=NVIDIA Attestation Service GPU Intermediate 004` (valid 2025-12-08 .. 2029-12-08),
  which chains to `CN=NVIDIA Attestation Service CA 001` (root is not in x5c).
  Keys rotate constantly, so a verifier must fetch JWKS by `kid` at verification time
  and cannot pin keys. The python SDK uses `x5c[0]`'s public key, the C++ SDK the JWK itself.

### Sample EAT (real, NRAS-signed)

`nras-sample-eat.json` (2767 bytes) is the verbatim HTTP body of a
`POST https://nras.attestation.nvidia.com/v3/attest/gpu` captured 2026-06-29
02:08:03 GMT (H100 / HOPPER, driver 595.71.05, VBIOS 96.00.D9.00.02) from
https://github.com/13rac1/teep commit `6225560378de8425f652c554bcb68f4b6e2bdefe`,
`internal/integration/testdata/tinfoil_v3_direct_gemma4-31b_20260629_020805/responses/0007_nras.attestation.nvidia.com_v3_attest_gpu.body`.
`nras-sample-request.json` (12103 bytes) is the decoded request body of that call:
`{"arch":"HOPPER","nonce":"<64 hex>","evidence_list":[{"arch":6,"certificate":"<b64 PEM chain>","evidence":"<b64, 4129 bytes SPDM measurement response>"}]}`.
`nras-jwks-at-capture.json` (80970 bytes) is the JWKS body the same client fetched right
after (`0008_..._jwks.json.body`); it contains the signing `kid`, so the sample verifies offline.

Format (Detached EAT, exactly what both SDKs parse):
```
[ ["JWT", "<overall JWT>"], { "GPU-0": "<device JWT>", ... } ]
```
- overall JWT header: `{"kid":"nv-eat-kid-prod-20260628170000087-6f27a971-6e29-42d6-afb9-8e3fbb17fa25","alg":"ES384"}`
- overall claims: `sub`="NVIDIA-PLATFORM-ATTESTATION", `x-nvidia-ver`="2.0", `iss`,
  `x-nvidia-overall-att-result`=true, `submods`={"GPU-0":["DIGEST",["SHA-256","<hex>"]]},
  `eat_nonce` (64 hex), `nbf`, `iat`, `exp` (= iat + 3600), `jti`.
- **Yes, `submods` carries per-device digests**: SHA-256 over the ASCII of the device's
  compact JWT string (all three b64url segments incl. dots) -> `219c9748...9fd7`, which
  matches `sha256(bundle[1]["GPU-0"])`. The C++ SDK also requires the submods count to
  equal the number of device JWTs.
- device JWT header: same kid / ES384. Device claims: `iss`, `eat_nonce`, `nbf`, `iat`,
  `exp`, `jti`, `ueid` (decimal string), `oemid`="5703", `hwmodel`="GH100",
  `secboot`=true, `dbgstat`="disabled", `measres`="success",
  `x-nvidia-gpu-driver-version`, `x-nvidia-gpu-vbios-version`,
  `x-nvidia-attestation-warning` (null), and the boolean checks
  `x-nvidia-gpu-arch-check`, `x-nvidia-gpu-attestation-report-parsed`,
  `x-nvidia-gpu-attestation-report-nonce-match`,
  `x-nvidia-gpu-attestation-report-signature-verified`,
  `x-nvidia-gpu-attestation-report-cert-chain-validated`,
  `x-nvidia-gpu-driver-rim-fetched|-schema-validated|-cert-validated|-signature-verified|-measurements-available`,
  `x-nvidia-gpu-vbios-rim-fetched|-schema-validated|-cert-validated|-signature-verified|-measurements-available`,
  `x-nvidia-gpu-vbios-index-no-conflict`.
  (v4 / `x-nvidia-ver` "3.0" replaces `*-cert-chain-validated` with objects
  `x-nvidia-gpu-attestation-report-cert-chain`/`...-driver-rim-cert-chain`/`...-vbios-rim-cert-chain`
  = `{x-nvidia-cert-status, x-nvidia-cert-ocsp-status, x-nvidia-cert-expiration-date, x-nvidia-cert-revocation-reason}`
  and adds `*-cert-chain-fwid-match`, `*-rim-version-match`; see nvtrust
  `guest_tools/attestation_sdk/tests/pytests/data/gpu/*granular*` and policies/remote/v4.)
- Signature check performed here: JWS signature is raw r||s (96 bytes), converted to DER,
  `openssl dgst -sha384 -verify <x5c[0] pubkey>` over `header.payload` ->
  overall **Verified OK**, GPU-0 **Verified OK** using the key with that kid from
  `nras-jwks-at-capture.json`.
- Against the **live** JWKS (2026-08-19): the kid is **absent** (rotated out), and the
  tokens are expired (`exp` 1782702483 = 2026-06-29T03:08:03Z), so a live-JWKS verifier
  must fail this sample on kid lookup; use `nras-jwks-at-capture.json` + a clock
  override (iat 1782698883) for an end-to-end positive test.

nvtrust itself (https://github.com/NVIDIA/nvtrust, commit
`0c5d627313037c1e577d05a232e79394a41b2c21`) ships no NRAS-signed JWTs: its tests
self-sign the decoded claim JSON in `guest_tools/attestation_sdk/tests/pytests/data/{gpu,switch}/`
with a throwaway ES384 key and a mocked JWKS `{"keys":[{"kid":"nv-eat-kid-test-1234","x5c":[...]}]}`.

## Not collected
- Turin SNP material (not needed; same KDS layout).
- NRAS root CA `NVIDIA Attestation Service CA 001` (not present in JWKS x5c; the SDKs
  do not chain-validate the JWKS certs, they trust the JWKS endpoint over TLS).
