# gpubnbd — the gpubnb runner

`gpubnbd` runs **inside** a confidential VM (AMD SEV-SNP) with an NVIDIA GPU
passed through in Confidential Computing mode. It turns a local
OpenAI-compatible server (vLLM, llama-server) into an **attested,
end-to-end-encrypted, Monero-metered** endpoint that anyone can rent through
[gpubnb](../README.md). The wire protocol is [`../PROTOCOL.md`](../PROTOCOL.md);
this crate is its Rust half, `packages/protocol` is the TypeScript half, and
`fixtures/` holds the vectors both sides must agree on.

What it does at boot and while serving:

1. Generates RAM-only keys: X25519 `hpke` keypair, Ed25519 `sign` keypair, a
   32-byte `boot_nonce`; hashes the model weights (`model_digest`, §8);
   computes `binding` (§2).
2. Produces an **attestation doc** binding those keys: SEV-SNP report with
   `REPORT_DATA = SHA512("gpubnb-report-v1" || binding || challenge)` + VCEK
   chain, and the NVIDIA detached EAT (`nvattest`, nonce
   `SHA256("gpubnb-gpu-v1" || binding || challenge)`). The runner self-checks
   the EAT claims and only then sets the GPU ready state
   (`nvidia-smi conf-compute -srs 1`): a GPU that fails attestation never serves.
3. Registers with the marketplace (`PUT /api/listings/:slug`, `POST .../attest`)
   and heartbeats every 5 min; a returned challenge triggers a fresh doc.
4. Serves the HPKE-sealed endpoint (§5): `POST /v1/sessions` (base mode),
   `POST /v1/sessions/status` and `POST /v1/chat/completions` (PSK mode with a
   per-session key, replay high-water mark per session), plus public
   `GET /v1/models`, `GET /.well-known/gpubnb/{attestation,info}`. Responses
   are AEAD frame streams with the request-ciphertext hash as AAD; chunks,
   errors and the Ed25519-signed **receipt** all travel inside.
5. Meters in piconero (§6): `reserve = cost(prompt_estimate, max_tokens)`
   up front, settle to upstream `usage`, `payment_required` + receipt when the
   session balance is short. Credit arrives from a view-only
   `monero-wallet-rpc` watcher at K confirmations, idempotent by
   `(txid, major, minor)`, revoked on reorg (balance may go negative).
6. Keeps the ledger in RAM and **persists on write** to `state_dir`: the
   ledger reaches disk (tmp + fsync + rename) before a session offer or a
   receipt leaves the runner and before an accepted request counter starts
   work; if that write fails the runner answers `busy` instead. Interval
   snapshots are only a backstop. This is the design `specs/Metering.tla`
   forced: with lazy snapshots a crash between a receipt and the next
   snapshot re-issues a `seq` and re-accepts a replayed counter after
   restart (`IssuedMonotone`/`ReplaySafe`). Plaintext under `--simulate`;
   sealed with ChaCha20-Poly1305 under a key from `SNP_GET_DERIVED_KEY` in
   real mode, so only the same measured image on the same chip can read it
   back. Reservations and chain credits are the only RAM-only state
   (credits rebuild by rescan).

## Layout

```
runner/
  Cargo.toml              workspace
  gpubnbd/                binary: run | probe | doc | digest
  gpubnbd.example.toml    annotated config
  crates/protocol         pure: encodings, signed blobs, binding, HPKE envelope + frames, events, receipts/offers, model digest
  crates/attest           Identity, Attester trait, SimulatedAttester, SnpNvAttester (feature `snp`), runner-side verifier
  crates/xmr              monero-wallet-rpc client + confirmation watcher + FreeCredit
  crates/gateway          axum routes, ledger, metering, upstream proxy, snapshots
  crates/marketplace      gb_ client: upsert / attest / heartbeat loop
  image/                  deterministic CVM image plan + measure.sh (untested, see image/README.md)
```

Features: default build has no hardware paths and runs on macOS/Linux;
`--features snp` enables `/dev/sev-guest` (via the `sev` crate), `nvattest`,
`nvidia-smi` and sealed snapshots (Linux only at runtime; the feature still
type-checks on macOS).

## Simulate mode on a Mac

Everything except the hardware roots runs locally: a simulated attestation
doc signed by the checked-in dev root (verifies as `simulated`, never
`verified`), Monero either on stagenet or skipped entirely (`xmr.mode = "free"`
credits every session a fixed balance), and any OpenAI-compatible upstream,
for example pi-local's `llama-server` on `http://127.0.0.1:8080`.

```sh
cd gpubnb/runner
cargo build

cat > /tmp/gpubnbd.toml <<'TOML'
[listing]
slug = "sim-mac"
gpu_model = "SIMULATED"
model_id = "Qwen/Qwen3.6-35B-A3B"
ctx_len = 65536
price_in_piconero = 1000000        # 1 piconero per token, easy to read
price_out_piconero = 1000000
endpoint_url = "http://127.0.0.1:8787"
[upstream]
url = "http://127.0.0.1:8080"       # llama-server / vLLM
model = "default"                   # name the upstream expects
[xmr]
mode = "free"                       # --simulate only
[server]
listen = "127.0.0.1:8787"
state_dir = "/tmp/gpubnb-state"
TOML

# 1. runner
./target/debug/gpubnbd run --config /tmp/gpubnbd.toml --simulate

# 2. in another shell: a renter-side probe (verify doc → open session → status → chat → receipt)
./target/debug/gpubnbd probe --url http://127.0.0.1:8787 --prompt "Say hello in five words." --max-tokens 256

# other commands
./target/debug/gpubnbd doc --config /tmp/gpubnbd.toml --simulate --challenge $(printf 'ab%.0s' $(seq 32))
./target/debug/gpubnbd digest /path/to/weights
curl -s http://127.0.0.1:8787/.well-known/gpubnb/info | jq
```

Add a `[marketplace]` section (`url`, `token = "gb_…"`) to register as a
**simulated** listing; the marketplace hides simulated listings unless asked
and never marks them `verified`. For stagenet payments set
`xmr.mode = "wallet"`, `network = "stagenet"`, your stagenet address + private
view key, a node URL and either `wallet_rpc_url` (existing wallet-rpc) or
`wallet_rpc_bin` (spawned with `--stagenet --daemon-address … --wallet-dir …`).

Tests: `cargo test` (unit tests per crate, an end-to-end test that runs the
gateway in simulate+free mode against a fake streaming upstream, and fixture
tests: ours in `fixtures/runner/`, cross-checked against the TypeScript
package's `fixtures/protocol/` when present). Regenerate ours with
`GPUBNB_WRITE_FIXTURES=1 cargo test`.

## Real deployment (summary of the NVIDIA CC Deployment Guide v7.1)

Target: RTX PRO 6000 Blackwell **Server Edition** (single-GPU passthrough
only; Workstation/Max-Q are not CC-capable), driver R595 / CUDA 13.2, vBIOS
1.4, host Ubuntu 25.10, guest Ubuntu 24.04, AMD EPYC Genoa/Turin with SEV-SNP.
This is the procedure as written in the guide; it has not yet been exercised
on hardware from this repo.

**Host**

1. BIOS: SEV, SEV-ES, **SEV-SNP** enabled, SMEE on, IOMMU enabled, SNP memory
   coverage / RMP on, TSME as you prefer. Host kernel with SNP host support and
   `kvm_amd` loaded with `sev_snp=1 sev=1 sev_es=1`; confirm with
   `dmesg | grep -i "SEV-SNP enabled"` and `/sys/module/kvm_amd/parameters/sev_snp`.
2. Keep the GPU away from the host driver: blacklist `nouveau`/`nvidia`, bind
   to `vfio-pci` (RTX PRO 6000 Blackwell SE: `10de:2bb5`), e.g.
   `options vfio-pci ids=10de:2bb5` + `softdep nvidia pre: vfio-pci`.
3. Put the GPU in CC mode (persistent across reboots, set from the host with
   NVIDIA's `gpu-admin-tools`):
   `python3 nvidia_gpu_tools.py --gpu-bdf=<bdf> --set-cc-mode=on --reset-after-cc-mode-switch`
   (`--query-cc-mode` to check; `devtools` mode always fails attestation and is
   rejected by every verifier).
4. Launch the guest with the guide's QEMU (patched QEMU/OVMF from NVIDIA's
   `nvtrust` tree), roughly:
   ```
   qemu-system-x86_64 -enable-kvm -cpu EPYC-v4 -machine q35,kernel-irqchip=split,confidential-guest-support=sev0,memory-backend=ram1 \
     -object memory-backend-memfd,id=ram1,size=<mem>,share=true,prealloc=false \
     -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,policy=0x30000 \
     -bios OVMF.fd                      # AmdSev OVMF build
     -kernel vmlinuz -initrd initrd.img -append "<measured cmdline>"   # direct boot: kernel/initrd/cmdline are measured
     -device pcie-root-port,id=pci.1,bus=pcie.0 -device vfio-pci,host=<bdf>,bus=pci.1 \
     -netdev user,id=n0,hostfwd=tcp::8787-:8787 -device virtio-net-pci,netdev=n0 \
     -drive file=gpubnb.raw,format=raw,if=virtio
   ```
   `policy=0x30000` = SMT allowed, debug off, migration off; the verifier
   requires DEBUG=0 and MIGRATE_MA=0 (§4).
5. Put a TLS terminator (Caddy, nginx) in front of `:8787`. It sees nothing:
   request bodies are HPKE-sealed and responses are AEAD frames.

**Guest (the image in `image/`)**

Ubuntu 24.04, `nvidia-driver-open-595` with the kernel crypto modules the CC
driver needs (`modprobe ecdsa_generic ecdh`), `nvidia-persistenced`,
`nv-attestation-cli` (`nvattest`), vLLM or llama-server, `monero-wallet-rpc`,
and `gpubnbd` built with `--features snp`. At boot `gpubnbd run` gets the SNP
report from `/dev/sev-guest`, runs
`nvattest --format json attest --device gpu --verifier remote --nonce <hex>`,
self-checks the claims (`measres`, `dbgstat == disabled`, `secboot`,
`hwmodel` allowlist, `eat_nonce`), sets the GPU ready state, registers, and
serves. The `MEASUREMENT` in the report must match the golden entry for the
runner version (`image/measure.sh`); the marketplace and the renter SDK both
check it.

## Refusals

- `xmr.mode = "free"` outside `--simulate`.
- Model digest not present in the signed `attest.models_json` catalog
  (`gpubnb-models-v1`, offline root) outside `--simulate`; missing
  `weights_dir` outside `--simulate`.
- Real attester when the binary lacks the `snp` feature or `/dev/sev-guest` is
  absent; GPU CC mode not `on`; any EAT claim failing the self-check (the ready
  state is never set in that case).
- Replayed request counters (HTTP 409, nothing changes), unknown sessions
  (404), undecryptable envelopes (400, the counter does not advance).

## Limitations (by design, see the project README)

The host can still DoS the endpoint or hide payments after prepay (keep
top-ups small; signed offers + receipts feed the marketplace's reputation);
chunk timing leaks token counts; debits, receipt sequence and replay marks
are persisted before they are acted on, so a crash loses only in-flight
reservations (released) and the credits it rebuilds by rescan, and any
shortfall falls on the host, never the renter; v1 is SEV-SNP only.
