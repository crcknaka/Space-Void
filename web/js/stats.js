(function (global) {
  const SpaceVoid = (global.SpaceVoid = global.SpaceVoid || {});

  const STORAGE_KEY = 'space-void-total-stats';
  const DEFAULT_TOTALS = {
    enemiesDestroyed: 0,
    asteroidsSmashed: 0,
    bossesKilled: 0,
    deathCount: 0,
    playtimeSeconds: 0,
  };

  function cloneDefaults() {
    return { ...DEFAULT_TOTALS };
  }

  function sanitizeNumber(value) {
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.floor(value));
  }

  function sanitizeTotals(rawTotals) {
    if (!rawTotals || typeof rawTotals !== 'object') {
      return cloneDefaults();
    }
    const totals = cloneDefaults();
    totals.enemiesDestroyed = sanitizeNumber(rawTotals.enemiesDestroyed);
    totals.asteroidsSmashed = sanitizeNumber(rawTotals.asteroidsSmashed);
    totals.bossesKilled = sanitizeNumber(rawTotals.bossesKilled);
    totals.deathCount = sanitizeNumber(rawTotals.deathCount);
    totals.playtimeSeconds = sanitizeNumber(rawTotals.playtimeSeconds);
    return totals;
  }

  function loadTotals() {
    if (!('localStorage' in global) || !global.localStorage) {
      return cloneDefaults();
    }
    try {
      const stored = global.localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        return cloneDefaults();
      }
      const parsed = JSON.parse(stored);
      return sanitizeTotals(parsed);
    } catch (error) {
      console.warn('Failed to load total stats from localStorage.', error);
      return cloneDefaults();
    }
  }

  function saveTotals(totals) {
    if (!('localStorage' in global) || !global.localStorage) {
      return;
    }
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(totals));
    } catch (error) {
      console.warn('Failed to save total stats to localStorage.', error);
    }
  }

  function recordSession(sessionStats = {}) {
    const totals = loadTotals();
    const updateNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

    totals.enemiesDestroyed += updateNumber(sessionStats.enemiesDestroyed);
    totals.asteroidsSmashed += updateNumber(sessionStats.asteroidsSmashed);
    totals.bossesKilled += updateNumber(sessionStats.bossesKilled);
    totals.deathCount += updateNumber(sessionStats.deaths);
    totals.playtimeSeconds += Math.max(0, Math.floor(updateNumber(sessionStats.playtimeSeconds)));

    saveTotals(totals);
    return { ...totals };
  }

  function getTotals() {
    return loadTotals();
  }

  function formatPlaytime(seconds) {
    const totalSeconds = Math.max(0, Math.floor(typeof seconds === 'number' ? seconds : 0));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    const segments = [];
    if (hours > 0) {
      segments.push(`${hours}h`);
    }
    if (minutes > 0 || hours > 0) {
      segments.push(`${minutes}m`);
    }
    segments.push(`${secs}s`);
    return segments.join(' ');
  }

  SpaceVoid.stats = {
    getTotals,
    recordSession,
    formatPlaytime,
    DEFAULT_TOTALS: cloneDefaults(),
  };
})(window);
