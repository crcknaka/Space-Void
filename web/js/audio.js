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
  gain.gain.linearRampToValueAtTime(vol * settings.sfx, when + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, when + dur);
  src.connect(bp).connect(gain).connect(actx.destination);
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
    // player beam: charge blip → thick descending zap over a sub-hum,
    // with a sizzling noise sweep and a shimmering top harmonic
    note(500, t, 0.06, 'sine', 0.1, 1700);
    note(2300, t + 0.05, 0.38, 'sawtooth', 0.17, -2050);
    note(1150, t + 0.05, 0.3, 'square', 0.09, -950);
    note(150, t + 0.05, 0.42, 'square', 0.12, -95);
    note(4400, t + 0.06, 0.2, 'triangle', 0.06, -3400);
    noiseHit(t + 0.05, 0.34, 0.16, 3400, 500, 1.4);
  } else if (name === 'warp') {
    // hyperspace spool-up: rising sweep + accelerating whoosh
    note(240, t, 0.3, 'sine', 0.15, 620);
    note(150, t, 1.15, 'sawtooth', 0.07, 850);
    noiseHit(t, 1.5, 0.13, 350, 3600, 0.8);
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
