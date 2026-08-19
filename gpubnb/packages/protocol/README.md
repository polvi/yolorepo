# @gpubnb/protocol

Wire formats and verifiers for gpubnb, shared by the marketplace worker, the
renter SDK (`@gpubnb/client`) and, via JSON fixtures, the Rust runner. The
normative text is [`../../PROTOCOL.md`](../../PROTOCOL.md); this package
implements §1–5, §8 and §10. Raw-TS package (`exports: ./src/index.ts`), runs
in bun, browsers and Cloudflare Workers (WebCrypto + pure-TS crypto only).

```
bun install            # at gpubnb/ (workspace root)
bun test               # 48 tests, real AMD + NVIDIA material included
bunx tsc --noEmit
bun scripts/sign-golden.ts     # re-sign golden/*.src.json with ~/.gpubnb/root-signing.json
bun scripts/gen-fixtures.ts    # regenerate ../../fixtures/protocol/*.json
bun scripts/gen-roots.ts       # regenerate src/roots/amd/index.ts from the .pem files
```

## Modules

| file | what |
|---|---|
| `encoding.ts` | `b64u`, `hex`, `concat`, `utf8`, `sha256/384/512`, `u64be`, `randomBytes` |
| `signed.ts` | §1 signed blobs: `signBlob`, `verifyBlob`, `peekBlob`, `DOMAINS`, `ROOTS` (pinned offline + dev roots). Ed25519 via `@noble/curves` (not WebCrypto: identical behaviour everywhere, deterministic signatures). |
| `binding.ts` | §2 `computeBinding`, `reportData` (64 B), `gpuNonce` (32 B), `ZERO_CHALLENGE` |
| `schemas.ts` | zod schemas + types: `AttestationDoc`, `Offer`, `Receipt`, `GoldenSet`, `ModelCatalog`, `ListingInfo`, `SimulatedReport`, `OpenRequest`. Passthrough on unknown keys. |
| `hpke.ts` | §5 `sealOpen`/`sealRequest` (client), `unsealOpen`/`unsealRequest` (server), `frameEncoder`, `readFrames`/`readRawFrames`, `encodeEvents`, `requestAad`, `frameNonce`, event types. HPKE via hpke-js (`@hpke/core` + `dhkem-x25519` + `chacha20poly1305`), frames via `@noble/ciphers` ChaCha20-Poly1305 (WebCrypto has no ChaCha). |
| `modelDigest.ts` | §8 `modelDigestFromEntries` |
| `simulated.ts` | `generateRunnerKeys`, `hpkePublicKey`, `makeSimulatedDoc`, `simulatedMeasurement` (the TS twin of `gpubnbd --simulate`) |
| `verify.ts` | §4 `verifyAttestationDoc`, `verifyGolden`, `verifyModels`, `DEFAULT_MIN_TCB`, `VerifyOptions` |
| `snp/report.ts` | 1184-byte SEV-SNP report parser (v2 + v3), TCB layouts (Milan/Genoa vs Turin), policy bits |
| `snp/chain.ts` | VCEK → ASK → ARK with `@peculiar/x509`; VCEK extension cross-checks; ECDSA P-384 report signature (WebCrypto) |
| `gpu/nras.ts` | NRAS detached-EAT: `verifyEs384Jwt`, `fetchNrasJwks`, `NRAS_JWKS_URL`, `NRAS_ISSUER`, `checkDeviceClaims`, `DEFAULT_HWMODEL_ALLOW` |
| `roots/amd/` | pinned AMD KDS `cert_chain` PEMs (ASK+ARK) for **Genoa, Turin** and **Milan** (Milan only so the public go-sev-guest vector exercises the full chain) + generated `index.ts` |
| `golden.ts` | generated: `GOLDEN_BLOB`, `MODELS_BLOB` (signed by the offline root) |

## Verification semantics (what `verifyAttestationDoc` does)

Checks run in PROTOCOL §4 order and every check is reported, pass or fail
(`Verdict.checks`), so a dashboard can show exactly what broke:

- `doc.sig` covers both the Ed25519 signature under the payload's own
  `sign_pub` and schema validity. `doc.binding`, `doc.fresh` (±10 min;
  `expectedChallenge` must match when supplied).
- Real docs: `snp.parse`, `snp.chain` (VCEK under the **pinned** ASK/ARK for
  its product line, whatever intermediates the doc carried; validity window;
  hwID == CHIP_ID; every SPL extension == the matching `REPORTED_TCB`
  component, Turin layout incl. fmc), `snp.sig` (bytes 0..0x2A0, r‖s
  little-endian → P1363), `snp.policy` (DEBUG=0, MIGRATE_MA=0, VMPL=0),
  `snp.tcb` (≥ `minTcb` per product, default `DEFAULT_MIN_TCB`: the lowest
  values in the public vectors, raise in production), `snp.measurement`,
  `snp.report_data`, then `gpu.jwt` (overall + every device JWT ES384 against
  the JWKS, `exp`/`nbf`, `iss == NRAS_ISSUER`, and the detached-EAT binding:
  `overall.submods[GPU-n] = ["DIGEST",["SHA-256", sha256(deviceJwtAscii)]]`
  must match every carried device JWT and vice versa), `gpu.nonce`
  (`eat_nonce` on overall and every device == `gpu_nonce` hex), `gpu.claims`
  (`x-nvidia-overall-att-result === true`, per device `measres == "success"`,
  `dbgstat == "disabled"`, `secboot === true`, `hwmodel` contains an
  allowlisted token — NRAS reports silicon names like `GH100`, so the default
  list has marketing names *and* chip codes: `RTX PRO 6000 Blackwell Server
  Edition`/`GB202`, `H100`/`GH100`, `H200`, `B200`/`GB100`/`GB200`,
  `B300`/`GB300`; override with `hwmodelAllow`).
- Simulated docs: `sim.sig` (dev root), `sim.report_data`, `sim.gpu_nonce`,
  `sim.measurement` (golden entry with `simulated: true`), and `sim.allowed`
  (fails unless `allowSimulated`). Status is `simulated`, never `verified`.
- Optional `models` catalog → extra `doc.model` check (digest catalogued, or
  simulated doc under `simulated_any`).
- When the chain fails, the untrusted VCEK is still used for `snp.sig`/`snp.tcb`
  so the verdict says whether the rest is at least self-consistent; the chain
  check itself stays failed and the status is `failed`.

## Golden set and model catalog

`golden/golden.src.json` and `golden/models.src.json` are the human-edited
sources; `scripts/sign-golden.ts` validates them, strips `_`-prefixed keys,
stamps `issued_at`, signs with the offline root
(`~/.gpubnb/root-signing.json`, kid `gpubnb-root-2026`, never in the repo),
writes `golden/golden.json`, `golden/models.json` and `src/golden.ts`.

Current content: one **simulated** golden entry for runner `0.1.0`; the
catalog has no real models (`entries: []`) and `simulated_any: true`.

**Simulated measurement convention** (the Rust simulated attester must match):
`measurement = SHA384("gpubnb-simulated-" || runner_version)`, hex48. For
`0.1.0` that is
`d5edc940f681d3472552312378a512410dc0032b8cff4fbc63eb08c6180bd804cd9df6a7c963ed42c574accb2accd829`.
The signer refuses a simulated entry whose measurement deviates.

## Test data: real vs synthetic

Real (fetched 2026-08-19, provenance in `test/data/NOTES.md`):

- `test/data/report.bin` + `vcek.pem`: Milan v2 report + VCEK from
  google/go-sev-guest testdata; `vcek_kds_live.pem`: the same chip's VCEK
  re-issued by AMD KDS (same key, new validity: VCEK bytes must never be
  pinned). Note this report has `POLICY.DEBUG = 1` (a debug guest), which the
  policy check correctly flags.
- `test/data/report_genoa_v3.bin` + `vcek_genoa.pem`: Genoa v3 report +
  VCEK captured from a live Tinfoil SEV-SNP enclave. Policy clean.
- `src/roots/amd/*.pem` and `test/data/cert_chain_*.pem`: live AMD KDS chains.
- `test/data/nras-sample-eat.json`: a real NRAS `/v3/attest/gpu` response
  (H100, 2026-06-29) plus `nras-jwks-at-capture.json` (the JWKS holding its
  kid) and `nras-jwks.json` (live JWKS). Both JWTs verify against the captured
  JWKS at capture time; against the live JWKS the kid is gone and `exp` has
  passed (NRAS keys rotate every couple of days), which the tests assert too.

Synthetic (`test/synth.ts`): an AMD-shaped chain (RSA-PSS ARK/ASK, P-384 VCEK
with the AMD extension OIDs), signable reports, and an ES384 JWKS/JWT signer
shaped like NRAS. These are injected only through `VerifyOptions.amdRoots` /
`fetchJwks` and drive the full positive path (`verified`) plus one negative per
check. Real material cannot produce `verified` because its REPORT_DATA and
`eat_nonce` are not bound to our keys; with real material the tests assert that
exactly `snp.measurement`, `snp.report_data`, `gpu.nonce` fail (and
`snp.policy` for the Milan debug vector) and every cryptographic check passes.

## Fixtures for the Rust runner (`../../fixtures/protocol/`)

`binding.json`, `signed-blob.json`, `hpke-open.json`, `hpke-request.json`,
`frames.json`, `model-digest.json`, `simulated-doc.json`. All deterministic
(fixed seeds; HPKE ephemeral keys via the hpke-js `ekm` option = RFC 9180
DeriveKeyPair ikm, which an implementation that cannot inject ekm may ignore:
unseal the stored envelope with the stored recipient key, check the plaintext,
then reproduce the exporter secrets and frames byte-for-byte). Each `_doc`
field explains the vector. `test/*.test.ts` round-trips every one, and
`test/interop-runner.test.ts` consumes the vectors the Rust runner produces
(`../../fixtures/runner/*.json`, skipped when absent): Rust-sealed HPKE
envelopes unseal here with identical exporter secrets, Rust frames reproduce
byte-for-byte, Rust-signed blobs re-sign to the same bytes, and Rust simulated
docs verify as `simulated` under the shipped golden set.

## Deviations from the task brief / PROTOCOL.md

- Ed25519 uses `@noble/curves`, not WebCrypto (see above).
- `VerifyOptions` has extra optional knobs: `nrasIssuer`, `hwmodelAllow`,
  `models`, `amdRoots` (tests), and `minTcb` is per product line.
- Milan roots are pinned in addition to Genoa/Turin (test vector coverage).
- `Verdict` carries the parsed `doc` on success paths; `doc.sig` also fails on
  schema errors (no separate `doc.parse` id, keeping PROTOCOL's id list).
- `checkVcekAgainstReport` fails when `CHIP_ID` is all zero (MASK_CHIP_KEY):
  the VCEK cannot then be bound to the chip.
