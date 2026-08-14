import { describe, expect, it } from 'vitest';
import {
  GROUPS,
  OPTION_BY_LABEL,
  displayName,
  haversineMeters,
  resolveClaim,
  type VeggieRow,
} from '../worker/veggie-logic';

const veg = (over: Partial<VeggieRow>): VeggieRow => ({
  id: 'v1',
  category: 'melon',
  label: 'Watermelon',
  spec: 2,
  lat: 44.1776,
  lon: -121.306,
  first_player: 'Ravi',
  last_player: 'Ravi',
  confirmations: 0,
  ...over,
});

const opt = (label: string) => {
  const o = OPTION_BY_LABEL.get(label);
  if (!o) throw new Error(`missing option ${label}`);
  return o;
};

describe('taxonomy', () => {
  it('has unique labels across all groups', () => {
    const labels = GROUPS.flatMap((g) => g.options).map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('golden midget is more specific than watermelon than generic melon', () => {
    expect(opt('Melon (not sure which)').spec).toBe(1);
    expect(opt('Watermelon').spec).toBe(2);
    expect(opt('Golden Midget Watermelon').spec).toBe(3);
  });
});

describe('resolveClaim', () => {
  it('scores discoveries by specificity: 10/13/16', () => {
    expect(resolveClaim(opt('Strawberries'), 'Mia', null).points).toBe(10);
    expect(resolveClaim(opt('Watermelon'), 'Mia', null).points).toBe(13);
    expect(resolveClaim(opt('Golden Midget Watermelon'), 'Mia', null).points).toBe(16);
  });

  it('rejects the last player re-tagging the same veggie', () => {
    const r = resolveClaim(opt('Watermelon'), 'Ravi', veg({ last_player: 'Ravi' }));
    expect(r.action).toBe('rejected');
    expect(r.points).toBe(0);
  });

  it('confirms an existing veggie for another player', () => {
    const r = resolveClaim(opt('Melon (not sure which)'), 'Mia', veg({}));
    expect(r).toMatchObject({ action: 'confirm', points: 3 });
  });

  it('pays extra for confirming with the exact variety', () => {
    const r = resolveClaim(opt('Watermelon'), 'Mia', veg({}));
    expect(r).toMatchObject({ action: 'confirm', points: 5 });
  });

  it('refines a generic find with a specific name', () => {
    const generic = veg({ label: 'Melon (not sure which)', spec: 1 });
    expect(resolveClaim(opt('Watermelon'), 'Mia', generic)).toMatchObject({
      action: 'refine',
      points: 6,
    });
    expect(resolveClaim(opt('Golden Midget Watermelon'), 'Mia', generic)).toMatchObject({
      action: 'refine',
      points: 9,
    });
  });

  it('refines watermelon up to golden midget', () => {
    const r = resolveClaim(opt('Golden Midget Watermelon'), 'Mia', veg({}));
    expect(r).toMatchObject({ action: 'refine', points: 6 });
  });
});

describe('displayName', () => {
  it('prefers the mapped name', () => {
    expect(displayName('550e8400-e29b-41d4-a716-446655440000', 'Ravi')).toBe('Ravi');
  });
  it('shortens unmapped uuid keys', () => {
    expect(displayName('550e8400-e29b-41d4-a716-446655440000')).toBe('Player-550e');
  });
  it('passes through human-looking keys (Shortcuts device names)', () => {
    expect(displayName("Ravi's Apple Watch")).toBe("Ravi's Apple Watch");
  });
});

describe('haversineMeters', () => {
  it('measures ~11m for 0.0001 deg latitude', () => {
    const d = haversineMeters(44.1776, -121.306, 44.1777, -121.306);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(12);
  });
});
