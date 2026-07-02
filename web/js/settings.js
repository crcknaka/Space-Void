// Persistent settings, lifetime stats and achievements (localStorage)
const S_KEY = 'sv_settings';
const T_KEY = 'sv_stats';
const A_KEY = 'sv_ach';

function load(key, def) {
  try { return { ...def, ...(JSON.parse(localStorage.getItem(key)) || {}) }; }
  catch { return { ...def }; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

export const settings = load(S_KEY, { music: 0.6, sfx: 0.6, vibro: true });
export function saveSettings() { save(S_KEY, settings); }

export const stats = load(T_KEY, {
  kills: 0, bossKills: 0, maxLevel: 1, maxMult: 1, bestScore: 0,
  shieldSaves: 0, maxRunPowerups: 0, dailyRuns: 0,
});

export const ACHIEVEMENTS = [
  { id: 'first_boss', title: 'FIRST BOSS DOWN', test: (s) => s.bossKills >= 1 },
  { id: 'combo5', title: 'COMBO x5', test: (s) => s.maxMult >= 5 },
  { id: 'level5', title: 'VETERAN — LEVEL 5', test: (s) => s.maxLevel >= 5 },
  { id: 'level10', title: 'ACE — LEVEL 10', test: (s) => s.maxLevel >= 10 },
  { id: 'score10k', title: '10 000 POINTS', test: (s) => s.bestScore >= 10000 },
  { id: 'kills500', title: 'EXTERMINATOR — 500 KILLS', test: (s) => s.kills >= 500 },
  { id: 'collector', title: 'COLLECTOR — 5 POWERUPS IN A RUN', test: (s) => s.maxRunPowerups >= 5 },
  { id: 'shielded', title: 'SAVED BY THE SHIELD', test: (s) => s.shieldSaves >= 1 },
  { id: 'daily', title: 'DAILY CHALLENGER', test: (s) => s.dailyRuns >= 1 },
];

const unlocked = new Set(load(A_KEY, { list: [] }).list);
export function isUnlocked(id) { return unlocked.has(id); }
export function unlockedCount() { return unlocked.size; }

// Merge stat deltas ('max*'/'best*' keys take the maximum, others add).
// Returns freshly unlocked achievement defs.
export function bumpStats(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('max') || k.startsWith('best')) stats[k] = Math.max(stats[k] || 0, v);
    else stats[k] = (stats[k] || 0) + v;
  }
  save(T_KEY, stats);
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (!unlocked.has(a.id) && a.test(stats)) {
      unlocked.add(a.id);
      fresh.push(a);
    }
  }
  if (fresh.length) save(A_KEY, { list: [...unlocked] });
  return fresh;
}

export function vibrate(pattern) {
  if (!settings.vibro) return;
  try { navigator.vibrate?.(pattern); } catch {}
}
