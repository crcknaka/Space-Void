// WebAudio SFX + streamed HTMLAudio music.
// Mobile browsers (iOS especially) only unlock audio inside a real user-gesture
// event handler — installAutoUnlock() resumes the context and "warms" the music
// elements (muted play/pause) on the first touch/click/key.
import { settings } from './settings.js';

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
  if (!buf || actx.state !== 'running' || settings.sfx <= 0) return;
  const src = actx.createBufferSource();
  const gain = actx.createGain();
  gain.gain.value = volume * settings.sfx;
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
  gain.gain.linearRampToValueAtTime(vol * settings.sfx, when + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, when + dur);
  osc.connect(gain).connect(actx.destination);
  osc.start(when);
  osc.stop(when + dur + 0.05);
}

export function playSynth(name) {
  if (actx.state !== 'running' || settings.sfx <= 0) return;
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
  } else if (name === 'achieve') {
    note(660, t, 0.12, 'triangle', 0.2);
    note(880, t + 0.1, 0.12, 'triangle', 0.2);
    note(1320, t + 0.2, 0.35, 'triangle', 0.18);
  } else if (name === 'siren') {
    // falling-wreck wail
    note(880, t, 1.3, 'sawtooth', 0.07, -640);
    note(860, t + 0.06, 1.2, 'triangle', 0.05, -600);
  } else if (name === 'plaser') {
    // player laser: bright zap + power hum
    note(1800, t, 0.16, 'sawtooth', 0.16, -1200);
    note(220, t, 0.3, 'square', 0.1, -60);
    note(3200, t + 0.01, 0.1, 'triangle', 0.07, -2400);
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
const musicGains = {};
let currentTrack = null;
let currentBaseVol = 0.45;

function musicEl(track) {
  let el = musicEls[track];
  if (!el) {
    el = new Audio(`assets/sounds/${track}.m4a`);
    el.loop = true;
    el.preload = 'auto';
    musicEls[track] = el;
    // Route through a WebAudio gain node: HTMLMediaElement.volume is
    // read-only on iOS, so this is the only reliable volume control.
    try {
      const src = actx.createMediaElementSource(el);
      const gain = actx.createGain();
      src.connect(gain).connect(actx.destination);
      musicGains[track] = gain;
    } catch { /* fall back to element volume below */ }
  }
  return el;
}

function setTrackVolume(track, vol) {
  const gain = musicGains[track];
  if (gain) gain.gain.value = vol;
  else { try { musicEls[track].volume = vol; } catch {} }
}

export function playMusic(track, volume = 0.45) {
  if (currentTrack === track) return;
  stopMusic();
  currentTrack = track;
  currentBaseVol = volume;
  const el = musicEl(track);
  setTrackVolume(track, volume * settings.music);
  try { el.currentTime = 0; } catch {}
  if (settings.music > 0) el.play().catch(() => {}); // if blocked, the unlock handler retries
}

// live-apply the music volume setting (called from the settings screen)
export function applyMusicVolume() {
  if (!currentTrack) return;
  const el = musicEls[currentTrack];
  if (!el) return;
  setTrackVolume(currentTrack, currentBaseVol * settings.music);
  if (settings.music <= 0) el.pause();
  else if (el.paused) el.play().catch(() => {});
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
          if (el.paused && settings.music > 0) el.play().catch(() => { warmed = false; });
          continue;
        }
        el.muted = true;
        el.play()
          .then(() => { el.pause(); try { el.currentTime = 0; } catch {} el.muted = false; })
          .catch(() => { el.muted = false; warmed = false; });
      }
    } else if (currentTrack && settings.music > 0) {
      const el = musicEls[currentTrack];
      if (el && el.paused) el.play().catch(() => {});
    }
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown']) {
    addEventListener(ev, tryUnlock, true);
  }
}
