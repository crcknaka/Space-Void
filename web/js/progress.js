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
  upgrades: { hull: 0, thrusters: 0, reactor: 0, arsenal: 0, shield: 0 },
};

function fresh() {
  return { ...DEFAULTS, upgrades: { ...DEFAULTS.upgrades }, unlockedShips: [...DEFAULTS.unlockedShips] };
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
    };
  } catch {
    return fresh();
  }
}

export const progress = load();

export function saveProgress() {
  try { localStorage.setItem(P_KEY, JSON.stringify(progress)); } catch {}
}

// Credits earned for a finished run. Score is the main driver; bosses and a
// fresh personal best add flat bonuses. Returns the breakdown so the game-over
// screen can show where the reward came from.
export function awardRun({ score = 0, bossKills = 0, newBest = false } = {}) {
  const base = Math.max(0, Math.floor(score / 100));
  const boss = Math.max(0, bossKills) * 15;
  const best = newBest ? 50 : 0;
  const total = base + boss + best;
  progress.credits += total;
  saveProgress();
  return { base, boss, best, total, credits: progress.credits };
}
