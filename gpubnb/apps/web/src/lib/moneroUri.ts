const PICO_PER_XMR = 10n ** 12n;

// piconero → decimal XMR string with trailing zeros trimmed (≤12 dp).
export function piconeroToXmr(piconero: bigint): string {
  const neg = piconero < 0n;
  const abs = neg ? -piconero : piconero;
  const whole = abs / PICO_PER_XMR;
  const frac = abs % PICO_PER_XMR;
  const sign = neg ? '-' : '';
  if (frac === 0n) return `${sign}${whole}`;
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${sign}${whole}.${fracStr}`;
}

// Deliberately minimal: address plus optional amount. monero-wallet-gui
// (wallet2::parse_uri) rejects the WHOLE uri, prefilling nothing, if any one
// parameter displeases it. Fewer parameters, fewer ways for a wallet to hand
// back an empty send screen.
export function buildMoneroUri(address: string, piconero?: bigint): string {
  if (piconero === undefined || piconero <= 0n) return `monero:${address}`;
  return `monero:${address}?tx_amount=${piconeroToXmr(piconero)}`;
}

// 5Abc..EP3A — enough to eyeball that two people mean the same subaddress.
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}
