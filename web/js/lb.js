// Leaderboard client: API calls + DOM name-input overlay
const PEPPER = 'void-pepper-7f3a';

// FNV-1a — the server recomputes the same signature (casual tamper deterrent)
export function sig(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

// -> {top: [...], you: {rank, score}|null} or null when offline
export async function fetchTop(mode = '', name = '') {
  try {
    const q = new URLSearchParams();
    if (mode) q.set('mode', mode);
    if (name) q.set('name', name);
    const r = await fetch(`/api/scores?${q}`);
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data) ? { top: data, you: null } : data; // tolerate v1 replies
  } catch {
    return null;
  }
}

export async function submitScore(name, score, mode) {
  try {
    const r = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score, mode, sig: sig(`${name}|${score}|${mode}|${PEPPER}`) }),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export function savedName() {
  try { return localStorage.getItem('spacevoid_name') || ''; } catch { return ''; }
}

function saveName(n) {
  try { localStorage.setItem('spacevoid_name', n); } catch {}
}

let overlay = null;

function buildOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'nameov';
  overlay.style.cssText =
    'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,.65);z-index:10;font-family:Orbitron,sans-serif;';
  overlay.innerHTML = `
    <div style="background:#111;border:2px solid #0c6;border-radius:10px;padding:26px 30px;text-align:center;max-width:90vw">
      <div style="color:#fff;font-size:19px;font-weight:700;margin-bottom:14px">SUBMIT YOUR SCORE</div>
      <input id="nameov-input" maxlength="14" placeholder="YOUR NAME" autocomplete="off" spellcheck="false"
        style="width:220px;max-width:70vw;background:#000;color:#0f8;border:1px solid #333;border-radius:6px;
        padding:10px 12px;font:700 18px Orbitron,sans-serif;text-align:center;outline:none;text-transform:uppercase">
      <div style="margin-top:16px;display:flex;gap:10px;justify-content:center">
        <button id="nameov-ok" style="background:#0c6;color:#000;border:0;border-radius:6px;padding:10px 22px;
          font:700 15px Orbitron,sans-serif;cursor:pointer">SUBMIT</button>
        <button id="nameov-skip" style="background:#444;color:#fff;border:0;border-radius:6px;padding:10px 22px;
          font:700 15px Orbitron,sans-serif;cursor:pointer">SKIP</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

// Resolves with the entered name, or null if skipped
export function askName() {
  if (!overlay) buildOverlay();
  const input = overlay.querySelector('#nameov-input');
  const ok = overlay.querySelector('#nameov-ok');
  const skip = overlay.querySelector('#nameov-skip');
  input.value = savedName();
  overlay.style.display = 'flex';
  setTimeout(() => input.focus(), 50);

  return new Promise((resolve) => {
    const done = (val) => {
      overlay.style.display = 'none';
      ok.onclick = skip.onclick = input.onkeydown = null;
      resolve(val);
    };
    ok.onclick = () => {
      const n = input.value.trim().toUpperCase().slice(0, 14);
      if (!n) { input.focus(); return; }
      saveName(n);
      done(n);
    };
    skip.onclick = () => done(null);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') ok.onclick();
      if (e.key === 'Escape') skip.onclick();
    };
  });
}
