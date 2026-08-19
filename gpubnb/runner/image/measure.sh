#!/usr/bin/env bash
# Compute the expected SEV-SNP launch MEASUREMENT for the gpubnb CVM image and
# print a golden entry. UNTESTED: written from the sev-snp-measure CLI docs.
#
#   ./measure.sh --ovmf OVMF.fd --vcpus 8 --vcpu-type EPYC-v4 \
#       --kernel gpubnb.vmlinuz --initrd gpubnb.initrd --roothash <hex> --runner-version 0.1.0
#
# Requires: pip install sev-snp-measure
set -euo pipefail

OVMF="" VCPUS=8 VCPU_TYPE="EPYC-v4" KERNEL="" INITRD="" ROOTHASH="" RUNNER_VERSION="" EXTRA_CMDLINE="console=ttyS0 ro quiet systemd.volatile=overlay"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ovmf) OVMF="$2"; shift 2;;
    --vcpus) VCPUS="$2"; shift 2;;
    --vcpu-type) VCPU_TYPE="$2"; shift 2;;
    --kernel) KERNEL="$2"; shift 2;;
    --initrd) INITRD="$2"; shift 2;;
    --roothash) ROOTHASH="$2"; shift 2;;
    --runner-version) RUNNER_VERSION="$2"; shift 2;;
    --cmdline) EXTRA_CMDLINE="$2"; shift 2;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
for v in OVMF KERNEL INITRD ROOTHASH RUNNER_VERSION; do
  [[ -n "${!v}" ]] || { echo "--$(echo $v | tr 'A-Z_' 'a-z-') is required" >&2; exit 2; }
done

# The exact cmdline must match what the host passes to QEMU -append, byte for byte.
CMDLINE="${EXTRA_CMDLINE} roothash=${ROOTHASH}"
echo "cmdline: ${CMDLINE}" >&2

MEASUREMENT=$(sev-snp-measure --mode snp --vcpus "${VCPUS}" --vcpu-type "${VCPU_TYPE}" \
  --ovmf "${OVMF}" --kernel "${KERNEL}" --initrd "${INITRD}" --append "${CMDLINE}" --output-format hex)

[[ ${#MEASUREMENT} -eq 96 ]] || { echo "unexpected measurement length: ${MEASUREMENT}" >&2; exit 1; }

cat <<JSON
{
  "runner_version": "${RUNNER_VERSION}",
  "measurement": "${MEASUREMENT}",
  "verity_root": "${ROOTHASH}",
  "simulated": false,
  "note": "ovmf=$(sha256sum "${OVMF}" | cut -c1-16) kernel=$(sha256sum "${KERNEL}" | cut -c1-16) initrd=$(sha256sum "${INITRD}" | cut -c1-16) vcpus=${VCPUS} vcpu_type=${VCPU_TYPE}"
}
JSON
echo "Sign this entry into the golden set with the offline root (DOMAIN gpubnb-golden-v1) and publish via packages/protocol/golden/." >&2
