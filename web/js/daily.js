// Daily challenge: date seed, day modifier, limited attempts, reset timer
export const DAILY_TRIES = 3;

export function dailySeed() {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

const todayKey = () => new Date().toISOString().slice(0, 10); // UTC date

// Day modifiers — one per day, deterministic from the date
export const MODS = [
  { id: 'storm', name: 'ASTEROID STORM', desc: 'Twice the asteroids', asteroidRate: 0.45 },
  { id: 'armor', name: 'HEAVY ARMOR', desc: 'Tanks everywhere', tankBias: true },
  { id: 'shields', name: 'SHIELDS ONLY', desc: 'Only shield powerups drop', shieldsOnly: true },
  { id: 'hell', name: 'BULLET HELL', desc: 'Enemies fire faster · score x2', shootRate: 0.55, scoreMul: 2 },
  { id: 'mega', name: 'MEGA BOSSES', desc: 'Boss HP x2 · score x2', bossHp: 2, scoreMul: 2 },
  { id: 'hyper', name: 'HYPERSPEED', desc: 'Everything moves faster', enemySpeed: 1.4, playerBoost: 2 },
  { id: 'swarm', name: 'THE SWARM', desc: 'Endless light fighters', enemyRate: 0.55, lightOnly: true },
  { id: 'frenzy', name: 'ROCKET FRENZY', desc: 'Start with 12 rockets · fast reload', startRockets: 12, rocketDelay: 0.4 },
  { id: 'minefield', name: 'MINEFIELD', desc: 'Tanks lay mines from level 1', minefield: true },
  { id: 'rocketday', name: 'ROCKET DAY', desc: 'Tanks fire homing rockets from level 1 · score x1.5', rocketDay: true, scoreMul: 1.5 },
  { id: 'convoy', name: 'CONVOY RAID', desc: 'Shoot the cargo ships · big bounty + loot', convoy: true },
];

export function todayMod() {
  return MODS[dailySeed() % MODS.length];
}

function loadDaily() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem('sv_daily')); } catch {}
  if (!d || d.day !== todayKey()) d = { day: todayKey(), used: 0 };
  return d;
}

function saveDaily(d) {
  try { localStorage.setItem('sv_daily', JSON.stringify(d)); } catch {}
}

export function dailyAttemptsLeft() {
  return Math.max(0, DAILY_TRIES - loadDaily().used);
}

export function useDailyAttempt() {
  const d = loadDaily();
  d.used += 1;
  saveDaily(d);
}

// "HH:MM:SS" until the next UTC midnight (daily reset)
export function timeToNextDaily() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  let s = Math.max(0, Math.floor((next - now.getTime()) / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
