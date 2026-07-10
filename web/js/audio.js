// WebAudio SFX + streamed HTMLAudio music.
// Mobile browsers (iOS especially) only unlock audio inside a real user-gesture
// event handler — installAutoUnlock() resumes the context and "warms" the music
// elements (muted play/pause) on the first touch/click/key.
import { settings } from './settings.js';
import { W } from './const.js';

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

// x (world px) → stereo position; sounds follow their source across the field
function pannedOut(x) {
  if (x == null || !actx.createStereoPanner) return actx.destination;
  const p = actx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, (x / W) * 2 - 1)) * 0.75;
  p.connect(actx.destination);
  return p;
}

export function play(name, volume = 0.6, x = null, rate = 1) {
  const buf = buffers[name];
  if (!buf || actx.state !== 'running' || settings.sfx <= 0) return;
  const src = actx.createBufferSource();
  const gain = actx.createGain();
  gain.gain.value = volume * settings.sfx;
  src.buffer = buf;
  src.playbackRate.value = rate; // pitch variation breaks sample monotony
  src.connect(gain).connect(pannedOut(x));
  src.start();
}

let OUT = null;  // per-playSynth output (panned); null = master
let GAIN = 1;    // per-playSynth loudness multiplier

/* ------------------------------ synth jingles ------------------------------ */
// Event sounds generated with oscillators — no audio files needed.

// Filtered white-noise burst — adds "air" that plain oscillators lack.
let noiseBuf = null;
function noiseHit(when, dur, vol = 0.2, freq = 1500, freqEnd = 0, q = 1.2) {
  if (!noiseBuf) {
    noiseBuf = actx.createBuffer(1, actx.sampleRate / 2, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = actx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const bp = actx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = q;
  bp.frequency.setValueAtTime(freq, when);
  if (freqEnd) bp.frequency.exponentialRampToValueAtTime(Math.max(60, freqEnd), when + dur);
  const gain = actx.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(vol * GAIN * settings.sfx, when + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, when + dur);
  src.connect(bp).connect(gain).connect(OUT || actx.destination);
  src.start(when);
  src.stop(when + dur + 0.05);
}

function note(freq, when, dur, type = 'triangle', vol = 0.2, slide = 0) {
  const osc = actx.createOscillator();
  const gain = actx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), when + dur);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(vol * GAIN * settings.sfx, when + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, when + dur);
  osc.connect(gain).connect(OUT || actx.destination);
  osc.start(when);
  osc.stop(when + dur + 0.05);
}

export function playSynth(name, x = null, gain = 1) {
  if (actx.state !== 'running' || settings.sfx <= 0) return;
  OUT = x == null ? null : pannedOut(x);
  GAIN = gain;
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
    // player shield shatters: descending wail + low thump + glassy noise burst
    note(950, t, 0.32, 'sine', 0.26, -760);
    note(1900, t, 0.16, 'triangle', 0.12, -1300);
    note(140, t + 0.02, 0.24, 'square', 0.13, -70);
    noiseHit(t, 0.3, 0.2, 2400, 500, 1);
  } else if (name === 'shield_hit') {
    // a bolt splashing on an energy shield: quick zappy wobble-ping
    note(1500, t, 0.08, 'sine', 0.13, -520);
    note(2300, t + 0.01, 0.06, 'triangle', 0.08, -800);
    noiseHit(t, 0.07, 0.06, 3200, 1600, 2.5);
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
    // player beam: charge blip → massive layered zap — sub-bass slam under a
    // thick descending core, shimmer harmonic, long sizzling tail to match
    // the beam staying hot on screen
    note(500, t, 0.06, 'sine', 0.13, 1900);
    note(60, t + 0.05, 0.5, 'sine', 0.4, -18);
    note(2300, t + 0.05, 0.5, 'sawtooth', 0.2, -2100);
    note(1150, t + 0.05, 0.42, 'square', 0.11, -960);
    note(150, t + 0.05, 0.55, 'square', 0.14, -100);
    note(4400, t + 0.06, 0.3, 'triangle', 0.07, -3500);
    noiseHit(t + 0.05, 0.16, 0.26, 900, 320, 1);
    noiseHit(t + 0.05, 0.55, 0.2, 3400, 420, 1.3);
  } else if (name === 'warp') {
    // hyperspace spool-up: rising sweep + accelerating whoosh
    note(240, t, 0.3, 'sine', 0.15, 620);
    note(150, t, 1.15, 'sawtooth', 0.07, 850);
    noiseHit(t, 1.5, 0.13, 350, 3600, 0.8);
  } else if (name === 'storm') {
    // ion storm rolling in: low rumble + crackling sizzle
    note(70, t, 2, 'sawtooth', 0.08, -25);
    noiseHit(t, 2.2, 0.16, 420, 160, 0.7);
    noiseHit(t + 0.2, 1.6, 0.08, 2600, 900, 2);
  } else if (name === 'zap') {
    // one lightning bolt
    note(1500, t, 0.1, 'sawtooth', 0.07, -1100);
    noiseHit(t, 0.14, 0.1, 3200, 700, 1.6);
  } else if (name === 'crack') {
    // rock splitting: stony crunch, randomized per hit so a rock field never
    // sounds like a loop — snap, deep double thud, rubble hiss, stray pebbles
    const p = 0.88 + Math.random() * 0.28; // pitch spread
    noiseHit(t, 0.05, 0.45, 2900 * p, 1300, 2);
    note(78 * p, t, 0.24, 'square', 0.65, -48);
    note(50 * p, t + 0.02, 0.24, 'sine', 0.6, -20);
    noiseHit(t, 0.3, 0.8, 1250 * p, 220, 1);
    noiseHit(t + 0.06 + Math.random() * 0.05, 0.26, 0.35, 540 * p, 150, 0.8);
    if (Math.random() < 0.5) noiseHit(t + 0.17, 0.16, 0.2, 950 * p, 320, 1.6);
  } else if (name === 'hit') {
    // armor holds the hit: layered impact — snap transient, punch + sub
    // thump, detuned metallic ring-off, spark sizzle; jittered per hit
    const p = 0.88 + Math.random() * 0.28;
    noiseHit(t, 0.03, 0.5, 4200 * p, 2400, 2.5);
    note(150 * p, t, 0.13, 'square', 0.38, -95);
    note(58 * p, t + 0.01, 0.16, 'sine', 0.45, -26);
    note(910 * p, t, 0.13, 'triangle', 0.17, -260);
    note(1370 * p * (0.97 + Math.random() * 0.07), t + 0.005, 0.1, 'triangle', 0.1, -430);
    noiseHit(t + 0.01, 0.13, 0.15, 2600 * p, 650, 1.6);
  } else if (name === 'thock') {
    // giant rock chipped, not cracked: dull stone knock + gritty tick
    const p = 0.85 + Math.random() * 0.3;
    note(125 * p, t, 0.09, 'square', 0.32, -65);
    noiseHit(t, 0.09, 0.35, 850 * p, 280, 1.3);
  } else if (name === 'plasma') {
    // x5 combo bolt: short hot sizzle layered over the gun sample
    note(1350, t, 0.09, 'sawtooth', 0.1, -850);
    noiseHit(t, 0.07, 0.07, 3100, 1500, 2.2);
  } else if (name === 'laser_charge') {
    // boss beam spool-up: rising twin saws with a building shimmer — dread
    note(180, t, 0.85, 'sawtooth', 0.15, 520);
    note(91, t, 0.85, 'square', 0.11, 265);
    noiseHit(t + 0.2, 0.68, 0.09, 700, 2800, 1.6);
  } else if (name === 'laser_fire') {
    // boss beam: heavy — sub roar under a detuned saw stack + searing noise
    note(60, t, 0.9, 'sine', 0.36, -22);
    note(950, t, 0.8, 'sawtooth', 0.2, -520);
    note(715, t + 0.02, 0.75, 'sawtooth', 0.13, -370);
    note(1900, t, 0.5, 'triangle', 0.08, -900);
    noiseHit(t, 0.85, 0.17, 2600, 700, 1.2);
  }
  OUT = null;
  GAIN = 1;
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
