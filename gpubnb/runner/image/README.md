# CVM image (plan)

Golden measurements come from **this** build. The image must therefore be a
deterministic artifact: same inputs → same kernel, initrd, cmdline and
dm-verity root → same SEV-SNP `MEASUREMENT`. This directory holds the plan, a
mkosi configuration and `measure.sh`. **None of it has been run yet**; it is
the intended procedure and will be corrected on first hardware contact.

## Pieces

- `mkosi.conf` — Ubuntu 24.04 (noble) disk image: ESP-less direct boot, root
  on a **dm-verity** protected partition (`Verity=signed` is not needed: the
  verity root hash goes on the *measured* kernel cmdline instead), packages:
  `nvidia-driver-open-595`, `nvidia-persistenced`, `linux-image-generic` (6.8+
  has SNP guest support and `/dev/sev-guest`), `python3`, `vllm` (or
  `llama-server`), `nv-attestation-cli`, `monero-wallet-rpc`, and `gpubnbd`
  (built with `--features snp`, copied in by `mkosi.extra/`).
- Direct boot: QEMU `-kernel/-initrd/-append` with the AmdSev OVMF build, so
  kernel + initrd + cmdline are part of the launch measurement. The cmdline
  carries `roothash=<verity root>` (and `ro`), which pins the whole root
  filesystem transitively: the measurement covers the cmdline, the cmdline
  covers the verity root, the verity root covers every file.
- `gpubnbd.service` (systemd, in `mkosi.extra/`): `After=nvidia-persistenced`,
  `ExecStart=/usr/bin/gpubnbd run --config /etc/gpubnb/gpubnbd.toml`,
  `Restart=on-failure`. Config comes from a separate, *unmeasured* config
  partition / cloud-init seed: the host's XMR address, view key, `gb_` token
  and prices are host-specific and must not change the measurement. That is
  safe because nothing in the config can weaken the trust path: keys are
  generated in RAM, the model digest is recomputed, and the simulated attester
  is only reachable via `--simulate`, which the unit file does not pass.
- `measure.sh` — computes the expected `MEASUREMENT` with
  [`sev-snp-measure`](https://github.com/virtee/sev-snp-measure) from the
  OVMF binary, kernel, initrd, cmdline, vCPU count and type, and prints a
  golden entry `{ runner_version, measurement, verity_root, simulated: false }`
  ready to be signed by the offline root (`gpubnb-golden-v1`).

## Build (intended)

```sh
cd gpubnb/runner
cargo build --release --features snp --target x86_64-unknown-linux-gnu
mkdir -p image/mkosi.extra/usr/bin && cp target/x86_64-unknown-linux-gnu/release/gpubnbd image/mkosi.extra/usr/bin/
cd image
mkosi --image-version "$(git describe --always)" build       # → gpubnb.raw, gpubnb.vmlinuz, gpubnb.initrd, gpubnb.roothash
./measure.sh --ovmf /path/to/AmdSev/OVMF.fd --vcpus 8 --vcpu-type EPYC-v4 \
  --kernel gpubnb.vmlinuz --initrd gpubnb.initrd --roothash "$(cat gpubnb.roothash)" --runner-version 0.1.0
```

Reproducibility notes: pin `SOURCE_DATE_EPOCH`, the Ubuntu snapshot
(`Mirror=https://snapshot.ubuntu.com/ubuntu/<ts>`), the NVIDIA driver version
and the gpubnbd commit; mkosi's `Seed=` fixes partition UUIDs. Verify by
building twice and comparing `sha256sum gpubnb.raw gpubnb.vmlinuz gpubnb.initrd`.
The image is a deterministic *artifact* with a published verity root hash; it
is not claimed to be source-reproducible by third parties in v1.
