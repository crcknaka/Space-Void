// Player ship roster (Phase 5). Each ship is a 'player'-family procedural hull
// (seed + colour overrides) plus a stat block that overrides Player defaults.
// Vanguard is free and matches the classic player sprite; the rest cost credits.
//
// stats keys (all optional; omitted = Player default):
//   defaultSpeed 5, fastSpeed 8, shootDelay 500, rockets 3, lasers 2, lives 3,
//   w 50, h 30, startShield false
// Smaller w/h = a smaller hitbox (harder to hit) AND a smaller sprite.
export const SHIPS = [
  {
    id: 'vanguard', name: 'VANGUARD', seed: 4, cost: 0,
    desc: 'Balanced all-rounder. The classic hull.',
    stats: {},
  },
  {
    id: 'interceptor', name: 'INTERCEPTOR', seed: 11, cost: 400,
    hue: [186, 200], accHue: [178, 192], lit: [60, 72],
    desc: 'Fast and nimble with a tiny profile — but only 2 lives.',
    stats: { defaultSpeed: 6, fastSpeed: 9.5, shootDelay: 400, lives: 2, w: 42, h: 26 },
  },
  {
    id: 'juggernaut', name: 'JUGGERNAUT', seed: 23, cost: 800,
    hue: [205, 220], accHue: [30, 46], sat: [8, 16], lit: [46, 58],
    desc: 'Heavy hull: 4 lives and extra rockets, but slow and a big target.',
    stats: { defaultSpeed: 4, fastSpeed: 6.5, shootDelay: 520, lives: 4, rockets: 5, w: 58, h: 36 },
  },
  {
    id: 'ghost', name: 'GHOST', seed: 31, cost: 1200,
    hue: [268, 288], accHue: [280, 300], sat: [16, 28], lit: [62, 74],
    desc: 'Starts shielded with a small profile; slightly softer guns.',
    stats: { defaultSpeed: 5.5, fastSpeed: 9, shootDelay: 520, w: 44, h: 28, startShield: true },
  },
  {
    id: 'ace', name: 'ACE', seed: 41, cost: 1600,
    hue: [46, 62], accHue: [38, 54], sat: [18, 28], lit: [54, 66],
    desc: 'Rapid fire and an extra beam charge — a glass cannon on 2 lives.',
    stats: { shootDelay: 360, lives: 2, lasers: 3 },
  },
];

export const SHIP_BY_ID = Object.fromEntries(SHIPS.map((s) => [s.id, s]));

// colour/shape overrides passed to genShip(seed, 'player', over)
export function shipOverrides(ship) {
  const o = {};
  for (const k of ['hue', 'accHue', 'sat', 'lit']) if (ship[k]) o[k] = ship[k];
  return o;
}
