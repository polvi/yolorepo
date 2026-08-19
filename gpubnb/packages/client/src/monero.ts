const PICO_PER_XMR = 10n ** 12n;

/** piconero → decimal XMR string with trailing zeros trimmed (≤12 dp). */
export function piconeroToXmr(piconero: bigint): string {
  const whole = piconero / PICO_PER_XMR;
  const frac = piconero % PICO_PER_XMR;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(12, "0").replace(/0+$/, "")}`;
}

/**
 * `monero:<subaddress>[?tx_amount=<xmr>]` — deliberately minimal (address + amount only):
 * monero-wallet-gui rejects the whole URI if any one parameter displeases it. Cake Wallet,
 * Monerujo and Feather all open it.
 */
export function moneroUri(subaddress: string, piconero?: bigint): string {
  return piconero === undefined ? `monero:${subaddress}` : `monero:${subaddress}?tx_amount=${piconeroToXmr(piconero)}`;
}
