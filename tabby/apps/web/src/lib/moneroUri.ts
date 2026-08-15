const PICO_PER_XMR = 10n ** 12n;

// piconero → decimal XMR string with trailing zeros trimmed (≤12 dp).
export function piconeroToXmr(piconero: bigint): string {
  const whole = piconero / PICO_PER_XMR;
  const frac = piconero % PICO_PER_XMR;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

// Payments are quoted to 8 decimal places (1e-8 XMR is a rounding error of
// well under a hundredth of a cent). Atomic-unit precision produced amounts
// like 0.169799878714, which read as noise to a human and push wallet amount
// fields to their limits; rounding up also means a settled debt is never
// left a hair short.
const PICO_PER_QUOTE = 10_000n; // 1e-8 XMR

// µTAB → piconero at an integral µTAB-per-XMR rate. BigInt keeps the
// intermediate product exact (µTAB × 1e12 overflows doubles fast).
export function tabMicroToPiconero(amountTabMicro: number, rateTabMicroPerXmr: number): bigint {
  const exact = (BigInt(amountTabMicro) * PICO_PER_XMR) / BigInt(rateTabMicroPerXmr);
  return ((exact + PICO_PER_QUOTE - 1n) / PICO_PER_QUOTE) * PICO_PER_QUOTE;
}

// Deliberately minimal: address plus amount, nothing else. monero-wallet-gui
// (wallet2::parse_uri) rejects the WHOLE uri, prefilling nothing, if any one
// parameter displeases it, and a tx_description buys nothing when the group
// already knows what the payment is for. Fewer parameters, fewer ways for a
// wallet to hand back an empty send screen.
export function buildMoneroUri(address: string, piconero: bigint): string {
  return `monero:${address}?tx_amount=${piconeroToXmr(piconero)}`;
}

// 44AF..EP3A — enough to eyeball that two people mean the same wallet.
export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}..${address.slice(-4)}`;
}
