// WebAudio SFX + streamed HTMLAudio music.
// Mobile browsers (iOS especially) only unlock audio inside a real user-gesture
// event handler — installAutoUnlock() resumes the context and "warms" the music
// elements (muted play/pause) on the first touch/click/key.
const AC = window.AudioContext || window.webkitAudioContext;
const actx = new AC();
const buffers = {};

const SFX = ['click', 'hover', 'gun', 'explosion', 'powerup', 'rocket', 'player1_kill', 'player2_kill'];
const TRACKS = ['background_music', 'versus_music'];

export async function loadSounds(onProgress) {
  let done = 0;
  await Promise.all(
    SFX.map(async (name) => {
      try {
        const res = await fetch(`assets/sounds/${name}.m4a`);
        const buf = await res.arrayBuffer();
        buffers[name] = await actx.decodeAudioData(buf);
      } catch { /* sound stays silent */ }
      onProgress(++done, SFX.length);
    })
  );
}

export function play(name, volume = 0.6) {
  const buf = buffers[name];
  if (!buf || actx.state !== 'running') return;
  const src = actx.createBufferSource();
  const gain = actx.createGain();
  gain.gain.value = volume;
  src.buffer = buf;
  src.connect(gain).connect(actx.destination);
  src.start();
}

/* ------------------------------ synth jingles ------------------------------ */
// Event sounds generated with oscillators — no audio files needed.

function note(freq, when, dur, type = 'triangle', vol = 0.2, slide = 0) {
  const osc = actx.createOscillator();
  const gain = actx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), when + dur);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(vol, when + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, when + dur);
  osc.connect(gain).connect(actx.destination);
  osc.start(when);
  osc.stop(when + dur + 0.05);
}

export function playSynth(name) {
  if (actx.state !== 'running') return;
  const t = actx.currentTime;
  if (name === 'fanfare') {
    [523, 659, 784, 1046].forEach((f, i) => note(f, t + i * 0.12, 0.25, 'triangle', 0.22));
    note(1046, t + 0.48, 0.55, 'triangle', 0.16);
  } else if (name === 'warning') {
    for (let i = 0; i < 3; i++) note(520, t + i * 0.5, 0.42, 'sawtooth', 0.11, -260);
  } else if (name === 'combo') {
    note(700, t, 0.08, 'square', 0.14);
    note(1050, t + 0.07, 0.1, 'square', 0.14);
  } else if (name === 'shield_pop') {
    note(900, t, 0.28, 'sine', 0.26, -700);
  } else if (name === 'respawn') {
    note(300, t, 0.35, 'sine', 0.2, 550);
  } else if (name === 'siren') {
    // falling-wreck wail
    note(880, t, 1.3, 'sawtooth', 0.07, -640);
    note(860, t + 0.06, 1.2, 'triangle', 0.05, -600);
  } else if (name === 'warp') {
    note(240, t, 0.28, 'sine', 0.16, 620);
    note(900, t + 0.06, 0.16, 'triangle', 0.1);
  } else if (name === 'laser_charge') {
    note(180, t, 0.85, 'sawtooth', 0.12, 500);
  } else if (name === 'laser_fire') {
    note(950, t, 0.7, 'sawtooth', 0.16, -500);
  }
}

/* ---------------------------------- music ---------------------------------- */

const musicEls = {};
let currentTrack = null;

function musicEl(track) {
  let el = musicEls[track];
  if (!el) {
    el = new Audio(`assets/sounds/${track}.m4a`);
    el.loop = true;
    el.preload = 'auto';
    musicEls[track] = el;
  }
  return el;
}

export function playMusic(track, volume = 0.45) {
  if (currentTrack === track) return;
  stopMusic();
  currentTrack = track;
  const el = musicEl(track);
  el.volume = volume;
  try { el.currentTime = 0; } catch {}
  el.play().catch(() => {}); // if blocked, the unlock handler will retry
}

export function stopMusic() {
  if (currentTrack) {
    musicEls[currentTrack]?.pause();
    currentTrack = null;
  }
}

export function unlock() {
  if (actx.state !== 'running') actx.resume().catch(() => {});
}

let warmed = false;

export function installAutoUnlock() {
  const tryUnlock = () => {
    if (actx.state !== 'running') actx.resume().catch(() => {});
    if (!warmed) {
      warmed = true;
      // user-activate every music element so later .play() calls are allowed on iOS
      for (const t of TRACKS) {
        const el = musicEl(t);
        if (t === currentTrack) {
          if (el.paused) el.play().catch(() => { warmed = false; });
          continue;
        }
        el.muted = true;
        el.play()
          .then(() => { el.pause(); try { el.currentTime = 0; } catch {} el.muted = false; })
          .catch(() => { el.muted = false; warmed = false; });
      }
    } else if (currentTrack) {
      const el = musicEls[currentTrack];
      if (el && el.paused) el.play().catch(() => {});
    }
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown']) {
    addEventListener(ev, tryUnlock, true);
  }
}
