const PICO_PER_XMR = 10n ** 12n;

// piconero → decimal XMR string with trailing zeros trimmed (≤12 dp).
export function piconeroToXmr(piconero: bigint): string {
  const whole = piconero / PICO_PER_XMR;
  const frac = piconero % PICO_PER_XMR;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

// µTAB → piconero at an integral µTAB-per-XMR rate. BigInt keeps the
// intermediate product exact (µTAB × 1e12 overflows doubles fast).
export function tabMicroToPiconero(amountTabMicro: number, rateTabMicroPerXmr: number): bigint {
  return (BigInt(amountTabMicro) * PICO_PER_XMR) / BigInt(rateTabMicroPerXmr);
}

// Standard wallet URI; Cake Wallet opens these directly on mobile. Wallet
// URI parsers are strict: URLSearchParams' form encoding ('+' for spaces)
// and raw ':' made Cake Wallet drop the whole query, so the description is
// sanitized to plain words and percent-encoded by hand (%20 spaces).
export function buildMoneroUri(address: string, piconero: bigint, description: string): string {
  const desc = description
    .replace(/[^\w\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const query = `tx_amount=${piconeroToXmr(piconero)}${desc ? `&tx_description=${encodeURIComponent(desc)}` : ''}`;
  return `monero:${address}?${query}`;
}
