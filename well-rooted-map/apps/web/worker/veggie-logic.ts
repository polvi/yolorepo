// Pure game logic for the veggie-tagging game (no I/O), unit-tested in
// test/veggie.test.ts. Router lives in veggie.ts.
//
// Taxonomy: every claimable label maps to a category plus a specificity
// tier. spec 1 = the plant itself (Carrots), spec 2 = a variety (Watermelon,
// Lemon Cucumber), spec 3 = a named cultivar (Golden Midget Watermelon).
// More specific = more points, so "Golden Midget Watermelon" beats
// "Watermelon" beats "Melon (not sure which)".

export type Option = { label: string; category: string; spec: number };
export type Group = { label: string; options: Option[] };

const o = (label: string, category: string, spec: number): Option => ({ label, category, spec });

// Menu source of truth — the watch Shortcut fetches this from the API, so
// editing here updates every player's menu without touching their watches.
export const GROUPS: Group[] = [
  { label: '🍓 Strawberries', options: [o('Strawberries', 'strawberry', 1)] },
  { label: '🌽 Sweet Corn', options: [o('Sweet Corn', 'sweet-corn', 1)] },
  {
    label: '🍈 Melons…',
    options: [
      o('Melon (not sure which)', 'melon', 1),
      o('Watermelon', 'melon', 2),
      o('Golden Midget Watermelon', 'melon', 3),
      o('Cantaloupe', 'melon', 2),
      o('Orange Honeydew', 'melon', 2),
      o('Piel de Sapo', 'melon', 2),
      o('Asian Melon', 'melon', 2),
      o('Snow Leopard Melon', 'melon', 2),
      o('Casaba', 'melon', 2),
    ],
  },
  {
    label: '🥒 Cucumbers…',
    options: [
      o('Cucumber (not sure which)', 'cucumber', 1),
      o('Lemon Cucumber', 'cucumber', 2),
      o('Slicer Cucumber', 'cucumber', 2),
      o('Armenian Cucumber', 'cucumber', 2),
    ],
  },
  {
    label: '🎃 Squash…',
    options: [
      o('Squash (not sure which)', 'squash', 1),
      o('Zucchini', 'squash', 2),
      o('Yellow Summer Squash', 'squash', 2),
      o('Patty Pan Squash', 'squash', 2),
      o('Pumpkin', 'squash', 2),
    ],
  },
  {
    label: '🍅 Tomatoes…',
    options: [
      o('Tomato (not sure which)', 'tomato', 1),
      o('Cherry Tomatoes', 'tomato', 2),
      o('Slicing Tomatoes', 'tomato', 2),
    ],
  },
  {
    label: '🥦 Broccoli…',
    options: [
      o('Broccoli (not sure which)', 'broccoli', 1),
      o('Broccoli Florets', 'broccoli', 2),
      o('Broccoli Rapini', 'broccoli', 2),
    ],
  },
  {
    label: '🥬 Greens…',
    options: [
      o('Lettuce', 'lettuce', 1),
      o('Kale', 'kale', 1),
      o('Chard', 'chard', 1),
      o('Napa Cabbage', 'napa-cabbage', 1),
      o('Green Cabbage', 'green-cabbage', 1),
      o('Snow Peas', 'snow-peas', 1),
    ],
  },
  {
    label: '🥕 More Veggies…',
    options: [
      o('Carrots', 'carrots', 1),
      o('Beets', 'beets', 1),
      o('Potatoes', 'potatoes', 1),
      o('Onions', 'onions', 1),
      o('Kohlrabi', 'kohlrabi', 1),
      o('Fennel', 'fennel', 1),
      o('Green Beans', 'green-beans', 1),
      o('Peppers', 'peppers', 1),
      o('Cilantro', 'cilantro', 1),
      o('Dill', 'dill', 1),
    ],
  },
  { label: '💐 Flowers', options: [o('Flowers', 'flowers', 1)] },
  { label: '🍑 Peaches', options: [o('Peaches', 'peaches', 1)] },
];

export const OPTION_BY_LABEL: ReadonlyMap<string, Option> = new Map(
  GROUPS.flatMap((g) => g.options).map((opt) => [opt.label, opt])
);

// Two players tagging the same plant should resolve to one veggie: claims
// within this radius of an existing same-category veggie confirm/refine it.
export const CLAIM_RADIUS_M = 12;
// Stops points-by-button-mashing; also the only rate limit.
export const COOLDOWN_MS = 15_000;

export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(sa));
}

export type VeggieRow = {
  id: string;
  category: string;
  label: string;
  spec: number;
  lat: number;
  lon: number;
  first_player: string;
  last_player: string;
  confirmations: number;
};

// Players are keyed by whatever stable id the client sends (a device UUID
// from /tag, a Device Name from Shortcuts, or a typed name). A name mapping
// is optional and can be added later; until then raw machine-looking keys
// display as Player-xxxx.
export function displayName(key: string, mapped?: string | null): string {
  if (mapped) return mapped;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    return `Player-${key.slice(0, 4)}`;
  }
  return key;
}

export type Resolution =
  | { action: 'discover'; points: number; message: string }
  | { action: 'refine'; points: number; message: string }
  | { action: 'confirm'; points: number; message: string }
  | { action: 'rejected'; points: 0; message: string };

// Scoring: discover 10/13/16 by specificity; refine (adding a more specific
// name to an existing find) 3 + 3 per specificity step; confirm 3, or 5 for
// naming the exact variety back. The last player to touch a veggie can't
// score it again — go find something else. `player` and the row's *_player
// fields are identity KEYS; finderDisplay is the human name for messages.
export function resolveClaim(
  opt: Option,
  player: string,
  nearest: VeggieRow | null,
  finderDisplay?: string
): Resolution {
  const finder = finderDisplay ?? nearest?.first_player ?? '';
  if (nearest === null) {
    const points = 10 + 3 * (opt.spec - 1);
    const excl = opt.spec >= 3 ? '🏆' : '🎉';
    return { action: 'discover', points, message: `${excl} FIRST FIND: ${opt.label}!` };
  }
  if (nearest.last_player === player) {
    return {
      action: 'rejected',
      points: 0,
      message: `🏃 You just tagged this ${nearest.label} — go find another one!`,
    };
  }
  if (opt.spec > nearest.spec) {
    const points = 3 + 3 * (opt.spec - nearest.spec);
    return {
      action: 'refine',
      points,
      message: `🔬 Nice eye! ${nearest.label} is really ${opt.label} (${finder} found it first)`,
    };
  }
  const exact = opt.label === nearest.label && opt.spec >= 2;
  return {
    action: 'confirm',
    points: exact ? 5 : 3,
    message: exact
      ? `✅ Confirmed ${nearest.label} — exact match!`
      : `✅ Confirmed ${finder}'s ${nearest.label}`,
  };
}
