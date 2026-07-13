// Secondary weapon modules (Phase-5 loadout). Each auto-fires on its own
// cadence alongside the base gun, so it works on every input (no extra button).
// Selected/bought in the hangar; the firing itself lives in game.js
// (fireSecondary). 'none' is free and always owned.
export const WEAPONS = [
  {
    id: 'none', name: 'NONE', cost: 0, cadence: 0,
    desc: 'Just the primary cannon.',
  },
  {
    id: 'scatter', name: 'SCATTER', cost: 500, cadence: 1300,
    desc: 'Auto-fires a wide 5-bolt fan on a short timer.',
  },
  {
    id: 'seeker', name: 'SEEKER', cost: 900, cadence: 1600,
    desc: 'Launches a homing micro-missile at the nearest foe.',
  },
  {
    id: 'pulse', name: 'PULSE', cost: 1300, cadence: 2000,
    desc: 'Emits a short shockwave that wipes weak foes and fire nearby.',
  },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
