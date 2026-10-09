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

export function saveName(n) {
  try { localStorage.setItem('spacevoid_name', String(n).toUpperCase().slice(0, 14)); } catch {}
}

// Shared look of the two name dialogs — same language as the canvas UI kit
// (ui.js): system type, tracked caps, glass panel, cyan primary action.
const OV_FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
const OV_WRAP = `position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(2,5,10,.74);z-index:10;font-family:${OV_FONT};`;
const OV_BOX = 'background:rgba(8,16,28,.94);border:1px solid rgba(104,214,255,.45);border-radius:3px;'
  + 'box-shadow:0 0 0 1px rgba(0,0,0,.6),0 18px 60px rgba(0,0,0,.6),0 0 46px rgba(104,214,255,.10);'
  + 'padding:28px 32px 26px;text-align:center;max-width:90vw';
const OV_TITLE = 'color:#68d6ff;font-size:11px;font-weight:600;letter-spacing:.28em;margin-bottom:16px';
const OV_INPUT = 'width:240px;max-width:70vw;background:rgba(4,9,16,.85);color:#f6faff;caret-color:#68d6ff;'
  + 'border:1px solid rgba(188,208,230,.3);border-radius:2px;padding:12px 12px;'
  + `font:600 18px ${OV_FONT};letter-spacing:.16em;text-align:center;outline:none;text-transform:uppercase`;
const OV_BTN = `border-radius:2px;padding:12px 24px;min-height:44px;font:700 12px ${OV_FONT};letter-spacing:.18em;cursor:pointer`;
const OV_OK = `background:#68d6ff;color:#06101c;border:1px solid #68d6ff;${OV_BTN}`;
const OV_ALT = `background:transparent;color:#bcd0e6;border:1px solid rgba(188,208,230,.35);${OV_BTN}`;

// DOM overlay to set the persistent player name (used by SETTINGS)
let nameEditor = null;
export function askPlayerName() {
  if (!nameEditor) {
    nameEditor = document.createElement('div');
    nameEditor.style.cssText = OV_WRAP;
    nameEditor.innerHTML = `
      <div style="${OV_BOX}">
        <div style="${OV_TITLE}">PILOT NAME</div>
        <input id="pname-input" maxlength="14" placeholder="PILOT" autocomplete="off" spellcheck="false"
          style='${OV_INPUT}'>
        <div style="margin-top:18px;display:flex;gap:10px;justify-content:center">
          <button id="pname-ok" style='${OV_OK}'>SAVE</button>
          <button id="pname-cancel" style='${OV_ALT}'>CANCEL</button>
        </div>
      </div>`;
    document.body.appendChild(nameEditor);
  }
  const inp = nameEditor.querySelector('#pname-input');
  const ok = nameEditor.querySelector('#pname-ok');
  const cancel = nameEditor.querySelector('#pname-cancel');
  inp.value = savedName();
  nameEditor.style.display = 'flex';
  setTimeout(() => inp.focus(), 50);
  return new Promise((resolve) => {
    const done = (v) => { nameEditor.style.display = 'none'; ok.onclick = cancel.onclick = inp.onkeydown = null; resolve(v); };
    ok.onclick = () => { const n = inp.value.trim().toUpperCase().slice(0, 14); if (n) { saveName(n); done(n); } else inp.focus(); };
    cancel.onclick = () => done(null);
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') ok.onclick(); if (e.key === 'Escape') cancel.onclick(); };
  });
}

let overlay = null;

function buildOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'nameov';
  overlay.style.cssText = OV_WRAP;
  overlay.innerHTML = `
    <div style="${OV_BOX}">
      <div style="${OV_TITLE}">SUBMIT YOUR SCORE</div>
      <input id="nameov-input" maxlength="14" placeholder="YOUR NAME" autocomplete="off" spellcheck="false"
        style='${OV_INPUT}'>
      <div style="margin-top:18px;display:flex;gap:10px;justify-content:center">
        <button id="nameov-ok" style='${OV_OK}'>SUBMIT</button>
        <button id="nameov-skip" style='${OV_ALT}'>SKIP</button>
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
