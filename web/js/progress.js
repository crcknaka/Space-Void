// Persistent meta-progression (localStorage): a scrap/credits economy that
// funds ship unlocks and permanent upgrades. Stored as one versioned blob so
// the schema can grow without corrupting older saves. Phase-5 groundwork —
// ships/upgrades read from here; this step wires the currency + earning.
const P_KEY = 'sv_progress';
const VERSION = 1;

const DEFAULTS = {
  v: VERSION,
  credits: 0,
  selectedShip: 'vanguard',
  unlockedShips: ['vanguard'],
  upgrades: { hull: 0, thrusters: 0, reactor: 0, arsenal: 0, deflector: 0 },
  secondary: 'none',
  unlockedWeapons: ['none'],
};

function fresh() {
  return {
    ...DEFAULTS,
    upgrades: { ...DEFAULTS.upgrades },
    unlockedShips: [...DEFAULTS.unlockedShips],
    unlockedWeapons: [...DEFAULTS.unlockedWeapons],
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(P_KEY));
    if (!raw || typeof raw !== 'object') return fresh();
    // future versions migrate here; for v1 an unknown version resets cleanly
    if (raw.v !== VERSION) return fresh();
    return {
      ...fresh(),
      ...raw,
      upgrades: { ...DEFAULTS.upgrades, ...(raw.upgrades || {}) },
      unlockedShips: Array.isArray(raw.unlockedShips) && raw.unlockedShips.length
        ? raw.unlockedShips : [...DEFAULTS.unlockedShips],
      unlockedWeapons: Array.isArray(raw.unlockedWeapons) && raw.unlockedWeapons.length
        ? [...new Set(['none', ...raw.unlockedWeapons])] : [...DEFAULTS.unlockedWeapons],
    };
  } catch {
    return fresh();
  }
}

export const progress = load();

export function saveProgress() {
  try { localStorage.setItem(P_KEY, JSON.stringify(progress)); } catch {}
}

// Portable profile code (base64 of the JSON) for moving progress between
// browsers/devices. import mutates the live `progress` object in place so the
// shared reference every module holds stays valid.
export function exportCode() {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(progress)))); } catch { return ''; }
}
export function importCode(code) {
  try {
    const raw = JSON.parse(decodeURIComponent(escape(atob(String(code).trim()))));
    if (!raw || typeof raw !== 'object' || typeof raw.credits !== 'number') return false;
    const clean = {
      ...fresh(),
      ...raw,
      v: VERSION,
      credits: Math.max(0, Math.floor(raw.credits)),
      upgrades: { ...DEFAULTS.upgrades, ...(raw.upgrades || {}) },
      unlockedShips: Array.isArray(raw.unlockedShips) && raw.unlockedShips.length
        ? [...new Set(['vanguard', ...raw.unlockedShips])] : [...DEFAULTS.unlockedShips],
      unlockedWeapons: Array.isArray(raw.unlockedWeapons) && raw.unlockedWeapons.length
        ? [...new Set(['none', ...raw.unlockedWeapons])] : [...DEFAULTS.unlockedWeapons],
    };
    for (const k of Object.keys(progress)) delete progress[k];
    Object.assign(progress, clean);
    saveProgress();
    return true;
  } catch {
    return false;
  }
}

// Credits earned for a finished run. Score is the main driver; bosses and a
// fresh personal best add flat bonuses. Returns the breakdown so the game-over
// screen can show where the reward came from.
// Permanent meta-upgrades, applied on top of the chosen ship's stats
// (game.js applyUpgrades). Each level costs base * (currentLevel + 1).
export const UPGRADES = [
  { id: 'hull', name: 'HULL PLATING', max: 2, cost: 300, desc: '+1 life per level' },
  { id: 'thrusters', name: 'THRUSTERS', max: 3, cost: 200, desc: '+0.4 speed per level' },
  { id: 'reactor', name: 'REACTOR', max: 3, cost: 250, desc: '-6% fire delay per level' },
  { id: 'arsenal', name: 'ARSENAL', max: 3, cost: 150, desc: '+1 start rocket per level' },
  { id: 'deflector', name: 'DEFLECTOR', max: 1, cost: 500, desc: 'Start every run shielded' },
];
export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

export function upgradeLevel(id) { return progress.upgrades[id] || 0; }
export function upgradeCost(id) {
  const u = UPGRADE_BY_ID[id];
  return u ? u.cost * (upgradeLevel(id) + 1) : 0;
}
export function buyUpgrade(id) {
  const u = UPGRADE_BY_ID[id];
  if (!u) return false;
  const lvl = upgradeLevel(id);
  if (lvl >= u.max) return false;
  const cost = u.cost * (lvl + 1);
  if (progress.credits < cost) return false;
  progress.credits -= cost;
  progress.upgrades[id] = lvl + 1;
  saveProgress();
  return true;
}

export function awardRun({ score = 0, bossKills = 0, newBest = false } = {}) {
  const base = Math.max(0, Math.floor(score / 100));
  const boss = Math.max(0, bossKills) * 15;
  const best = newBest ? 50 : 0;
  const total = base + boss + best;
  progress.credits += total;
  saveProgress();
  return { base, boss, best, total, credits: progress.credits };
}
