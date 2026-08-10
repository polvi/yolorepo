// The ledger's normalization unit is the µTAB: 100,000 per TAB, and
// 1 TAB = 10 USD exactly, so USD and TAB conversions are integer-exact.
// CAD needs an entry-time fx rate (µTAB per CAD), snapshotted per expense.

export const TAB_MICRO_PER_TAB = 100_000;
export const TAB_MICRO_PER_USD = 10_000;

export type Currency = 'USD' | 'CAD' | 'TAB';

// µTAB per major unit of each currency. CAD's comes from the fx rate at
// entry time (cadUsdMicro = micro-USD per CAD from the rate source).
export function tabMicroPerUnit(currency: Currency, usdPerCad?: number): number {
  switch (currency) {
    case 'TAB':
      return TAB_MICRO_PER_TAB;
    case 'USD':
      return TAB_MICRO_PER_USD;
    case 'CAD': {
      if (usdPerCad === undefined || !(usdPerCad > 0)) {
        throw new Error('CAD requires a positive USD-per-CAD rate');
      }
      return Math.round(usdPerCad * TAB_MICRO_PER_USD);
    }
  }
}

// amount_minor is hundredths of the major unit (cents / TAB-hundredths).
export function normalizeToTabMicro(amountMinor: number, perUnit: number): number {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('amount_minor must be a positive integer');
  }
  return Math.round((amountMinor * perUnit) / 100);
}

// Equal split that sums exactly to the total: base = floor(T/n), and the
// first (T mod n) participants in user-id order get one extra µTAB.
export function equalSplit(
  totalTabMicro: number,
  participantIds: string[]
): Map<string, number> {
  if (participantIds.length === 0) throw new Error('participants required');
  if (new Set(participantIds).size !== participantIds.length) {
    throw new Error('duplicate participants');
  }
  const sorted = [...participantIds].sort();
  const base = Math.floor(totalTabMicro / sorted.length);
  const remainder = totalTabMicro % sorted.length;
  const shares = new Map<string, number>();
  sorted.forEach((id, i) => shares.set(id, base + (i < remainder ? 1 : 0)));
  return shares;
}

export function formatTab(tabMicro: number): string {
  const sign = tabMicro < 0 ? '-' : '';
  const abs = Math.abs(tabMicro);
  const whole = Math.floor(abs / TAB_MICRO_PER_TAB);
  const frac = abs % TAB_MICRO_PER_TAB;
  const cents = Math.round(frac / 1000); // show TAB to 2 decimals
  return `${sign}${whole}.${String(cents).padStart(2, '0')}`;
}

export function tabMicroToUsd(tabMicro: number): number {
  return tabMicro / TAB_MICRO_PER_USD;
}
