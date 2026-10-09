// WebAudio SFX + streamed HTMLAudio music.
// Mobile browsers (iOS especially) only unlock audio inside a real user-gesture
// event handler — installAutoUnlock() resumes the context and "warms" the music
// elements (muted play/pause) on the first touch/click/key.
import { settings } from './settings.js';
import { W } from './const.js';

const AC = window.AudioContext || window.webkitAudioContext;
const actx = new AC();
const buffers = {};
// phones get the lighter graph: fewer simultaneous voices, no cabin reverb
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
// the context the synth voices are built on — the live one, except while
// renderSynth() borrows the helpers to render a sound offline (dev harness)
let cx = actx;

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

/* --------------------------------- routing --------------------------------- */
// Every effect lands on one of two buses. "world" is anything that happens
// outside the ship — in the cockpit view it is heard through the hull
// (setInterior). "cabin" is the pilot's own weapons, the interface and the
// cockpit itself, which always stay full and dry. Music bypasses both.
let bus = null;
function buses() {
  if (!bus) {
    const world = actx.createGain(), dry = actx.createGain(), cabin = actx.createGain();
    world.connect(dry).connect(actx.destination);
    cabin.connect(actx.destination);
    bus = { world, dry, cabin, lp: null, muff: null, wet: null };
  }
  return bus;
}

// names that are always heard dry, whatever the camera
const CABIN = new Set(['click', 'hover', 'powerup', 'player1_kill', 'player2_kill',
  'fanfare', 'warning', 'combo', 'respawn', 'achieve', 'empty', 'overdrive', 'plasma', 'plaser',
  'warp', 'launch', 'lock']);
const isCabin = (name) => CABIN.has(name) || name.startsWith('pit_');

// x (world px) → stereo position; sounds follow their source across the field
function pannedOut(x, dest = actx.destination) {
  if (x == null || !cx.createStereoPanner) return dest;
  const p = cx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, (x / W) * 2 - 1)) * 0.75;
  p.connect(dest);
  return p;
}

// own = true marks the pilot's own shot: it skips the hull filter in the
// cockpit view and gets a mechanical thump through the airframe.
export function play(name, volume = 0.6, x = null, rate = 1, own = false) {
  const buf = buffers[name];
  if (!buf || actx.state !== 'running' || settings.sfx <= 0) return;
  if (!own && interiorOn && isOwnShot(name, x)) own = true;
  const src = actx.createBufferSource();
  const gain = actx.createGain();
  gain.gain.value = volume * settings.sfx;
  src.buffer = buf;
  src.playbackRate.value = rate; // pitch variation breaks sample monotony
  const b = buses();
  src.connect(gain).connect(pannedOut(x, own || isCabin(name) ? b.cabin : b.world));
  src.onended = () => gain.disconnect();
  src.start();
  if (own && interiorOn) bodyThump(name);
}

let OUT = null;  // per-playSynth output (panned bus); null = master
let GAIN = 1;    // per-playSynth loudness multiplier
// live voice budget: past it new layers are dropped instead of piling up
const MAX_VOICES = coarse ? 28 : 56;
let voices = 0;
const sfxVol = () => (cx === actx ? settings.sfx : 1); // offline renders are measured at unity
function track(src, gain) {
  if (cx !== actx) return;
  voices++;
  src.onended = () => { voices--; gain.disconnect(); };
}

/* ------------------------------ synth jingles ------------------------------ */
// Event sounds generated with oscillators — no audio files needed.

// Filtered white-noise burst — adds "air" that plain oscillators lack.
let noiseBuf = null;
// type: 'bandpass' (default) or 'lowpass' for weight; attack: fade-in time (s)
function noiseHit(when, dur, vol = 0.2, freq = 1500, freqEnd = 0, q = 1.2, type = 'bandpass', attack = 0.015) {
  if (cx === actx && voices >= MAX_VOICES) return;
  if (!noiseBuf) {
    noiseBuf = actx.createBuffer(1, actx.sampleRate / 2, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = cx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const bp = cx.createBiquadFilter();
  bp.type = type;
  bp.Q.value = q;
  bp.frequency.setValueAtTime(freq, when);
  if (freqEnd) bp.frequency.exponentialRampToValueAtTime(Math.max(60, freqEnd), when + dur);
  const gain = cx.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(vol * GAIN * sfxVol(), when + Math.min(attack, dur * 0.9));
  gain.gain.exponentialRampToValueAtTime(0.001, when + dur);
  src.connect(bp).connect(gain).connect(OUT || cx.destination);
  track(src, gain);
  src.start(when, Math.random() * 0.4); // a different slice of the noise per hit
  src.stop(when + dur + 0.05);
}

function note(freq, when, dur, type = 'triangle', vol = 0.2, slide = 0, attack = 0.012) {
  if (cx === actx && voices >= MAX_VOICES) return;
  const osc = cx.createOscillator();
  const gain = cx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), when + dur);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(vol * GAIN * sfxVol(), when + Math.min(attack, dur * 0.9));
  gain.gain.exponentialRampToValueAtTime(0.001, when + dur);
  osc.connect(gain).connect(OUT || cx.destination);
  track(osc, gain);
  osc.start(when);
  osc.stop(when + dur + 0.05);
}

// Two detuned saws behind a low-pass: stressed metal, hull groans.
function groan(when, dur, vol, f0, f1, cut = 320) {
  if (cx === actx && voices >= MAX_VOICES) return;
  const lp = cx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 4;
  lp.frequency.setValueAtTime(cut, when);
  lp.frequency.exponentialRampToValueAtTime(cut * 0.5, when + dur);
  const gain = cx.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(vol * GAIN * sfxVol(), when + dur * 0.3);
  gain.gain.exponentialRampToValueAtTime(0.001, when + dur);
  lp.connect(gain).connect(OUT || cx.destination);
  for (const det of [1, 1.037]) {
    const osc = cx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0 * det, when);
    osc.frequency.exponentialRampToValueAtTime(f1 * det, when + dur);
    osc.connect(lp);
    if (det === 1) track(osc, gain);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }
}

// own = true: the pilot's own weapon (see play()).
export function playSynth(name, x = null, gain = 1, own = false) {
  if (actx.state !== 'running' || settings.sfx <= 0) return;
  const b = buses();
  OUT = pannedOut(x, own || isCabin(name) ? b.cabin : b.world);
  GAIN = gain;
  synth(name, actx.currentTime);
  OUT = null;
  GAIN = 1;
  if (interiorOn && name === 'plaser') bodyThump(name);
}

function synth(name, t) {
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
  } else if (name === 'empty') {
    // dry-fire: dull mechanical click, no musical tone — reads as "out of ammo"
    note(150, t, 0.035, 'square', 0.1, -70);
    noiseHit(t, 0.05, 0.09, 760, 280, 1.3);
  } else if (name === 'overdrive') {
    // OVERDRIVE unleashed: a rising power surge + a big shimmering chord
    note(200, t, 0.5, 'sawtooth', 0.18, 900);
    note(120, t, 0.55, 'square', 0.12, 500);
    [523, 659, 784, 1046].forEach((f, i) => note(f, t + 0.1 + i * 0.03, 0.5, 'triangle', 0.14, 60));
    noiseHit(t, 0.5, 0.18, 600, 3400, 1);
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
  } else if (name === 'pit_hit') {
    // something heavy slams the hull from outside: sub thud + body knock,
    // then the loose panels and harness buckles rattle themselves quiet
    const p = 0.9 + Math.random() * 0.2;
    note(58 * p, t, 0.34, 'sine', 0.42, -28);
    note(112 * p, t, 0.13, 'square', 0.16, -62);
    noiseHit(t, 0.2, 0.3, 260, 90, 0.7, 'lowpass', 0.004);
    noiseHit(t, 0.025, 0.2, 2400, 1200, 1.5, 'bandpass', 0.003);
    let rt = t + 0.07;
    for (let i = 0; i < 6; i++) {
      const k = 1 - i / 7;
      noiseHit(rt, 0.03, 0.11 * k, 2300 + Math.random() * 1900, 0, 5, 'bandpass', 0.003);
      if (i % 2) note(700 + Math.random() * 900, rt, 0.06, 'triangle', 0.035 * k);
      rt += 0.035 + Math.random() * 0.05 + i * 0.008;
    }
  } else if (name === 'pit_crack') {
    // canopy glass cracking right in front of the face: dry snap, a run of
    // spreading ticks, thin glassy ring-off
    const p = 0.92 + Math.random() * 0.16;
    noiseHit(t, 0.018, 0.4, 6500 * p, 3500, 1.2, 'bandpass', 0.002);
    note(210 * p, t, 0.03, 'square', 0.1, -90);
    let ct = t + 0.03;
    const n = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      noiseHit(ct, 0.012 + Math.random() * 0.012, 0.22 * (0.5 + Math.random() * 0.5), 4200 + Math.random() * 4200, 0, 3, 'bandpass', 0.002);
      ct += 0.02 + Math.random() * 0.07;
    }
    for (const f of [3140, 4370, 5830]) note(f * p, t + 0.005, 0.22, 'sine', 0.04, -f * 0.02, 0.003);
    note(1900 * p, t + 0.02, 0.12, 'sawtooth', 0.025, 500);
  } else if (name === 'pit_shield') {
    // the shield soaks a hit, heard from inside the bubble: beating low
    // whoomp, pressure thump, a little fizz on top
    note(410, t, 0.42, 'sine', 0.17, -230);
    note(431, t, 0.42, 'sine', 0.12, -240);
    note(1240, t, 0.2, 'triangle', 0.05, -500);
    note(52, t, 0.3, 'sine', 0.26, -18);
    noiseHit(t, 0.36, 0.2, 520, 140, 0.8, 'lowpass');
    noiseHit(t + 0.01, 0.22, 0.06, 3200, 1500, 3);
  } else if (name === 'pit_spark') {
    // a console shorting out: a few dry ticks, falling zap, mains buzz
    let st = t;
    for (let i = 0; i < 3; i++) {
      noiseHit(st, 0.014, 0.2, 5200 + Math.random() * 2500, 0, 2, 'bandpass', 0.002);
      st += 0.018 + Math.random() * 0.03;
    }
    note(2400, t, 0.05, 'sawtooth', 0.07, -1900, 0.003);
    note(100, t, 0.09, 'square', 0.05);
    noiseHit(t + 0.03, 0.12, 0.05, 3800, 1800, 2);
  } else if (name === 'pit_switch') {
    // relay: contact click, tiny body knock, softer settle a moment later
    noiseHit(t, 0.012, 0.14, 2700, 0, 2.5, 'bandpass', 0.002);
    note(180, t, 0.022, 'square', 0.08, -70, 0.002);
    noiseHit(t + 0.048, 0.01, 0.07, 1900, 0, 3, 'bandpass', 0.002);
    note(125, t + 0.048, 0.02, 'square', 0.04, -40, 0.002);
  } else if (name === 'launch') {
    // catapult: capacitors charge for 1.5 s, the clamp lets go, the ship is
    // thrown down the rail (whoosh + sub push)
    note(70, t, 1.5, 'sawtooth', 0.08, 330, 1.35);
    note(140, t, 1.5, 'sine', 0.09, 760, 1.35);
    note(141.5, t, 1.5, 'triangle', 0.05, 770, 1.35);
    noiseHit(t, 1.5, 0.09, 300, 3400, 1.2, 'bandpass', 1.3);
    const c = t + 1.5;
    noiseHit(c, 0.03, 0.32, 2600, 900, 1.5, 'bandpass', 0.003);
    note(130, c, 0.1, 'square', 0.22, -75, 0.003);
    note(820, c, 0.16, 'triangle', 0.07, -90);
    note(1235, c + 0.004, 0.12, 'triangle', 0.04, -120);
    const w = c + 0.06;
    note(66, w, 0.75, 'sine', 0.36, -34);
    noiseHit(w, 0.95, 0.3, 2800, 260, 0.7, 'bandpass', 0.03);
    noiseHit(w, 0.6, 0.2, 240, 80, 0.7, 'lowpass', 0.02);
    note(320, w, 0.6, 'sawtooth', 0.06, -230);
  } else if (name === 'tear') {
    // a wing or a plate ripping off: rising screech over ragged tearing,
    // ending in the snap as the last spar gives
    const p = 0.88 + Math.random() * 0.24;
    note(480 * p, t, 0.38, 'sawtooth', 0.06, 900);
    note(497 * p, t, 0.38, 'sawtooth', 0.045, 960);
    for (let i = 0; i < 5; i++) {
      noiseHit(t + i * 0.07 + Math.random() * 0.02, 0.09, 0.18 + Math.random() * 0.1, (900 + i * 380) * p, 1400 + i * 420, 3.5);
    }
    const s = t + 0.4;
    noiseHit(s, 0.035, 0.32, 3600, 1500, 1.5, 'bandpass', 0.003);
    note(96 * p, s, 0.16, 'square', 0.2, -52);
    note(50 * p, s, 0.22, 'sine', 0.3, -20);
    noiseHit(s, 0.25, 0.14, 1300, 300, 1);
  } else if (name === 'boss_break') {
    // a capital ship's spine goes: long structural groan and creaks, then
    // the crunch and a scatter of debris
    groan(t, 1.05, 0.3, 64, 36, 340);
    note(41, t, 1.45, 'sine', 0.3, -12, 0.25);
    note(310, t + 0.15, 0.3, 'sawtooth', 0.03, -120, 0.08);
    note(205, t + 0.45, 0.3, 'sawtooth', 0.03, 90, 0.08);
    const c = t + 0.8;
    noiseHit(c, 0.04, 0.32, 3000, 1200, 1.5, 'bandpass', 0.003);
    noiseHit(c, 0.6, 0.34, 1100, 160, 0.9);
    noiseHit(c, 0.5, 0.22, 220, 70, 0.7, 'lowpass');
    note(72, c, 0.35, 'square', 0.2, -40);
    for (let i = 0; i < 4; i++) {
      noiseHit(c + 0.15 + i * 0.1 + Math.random() * 0.05, 0.05, 0.12 - i * 0.02, 1500 + Math.random() * 1500, 400, 2);
    }
  } else if (name === 'warp_in') {
    // a ship dropping out of hyperspace: the 'warp' sweep played backwards,
    // closed by an arrival thump and a fading shimmer
    note(2600, t, 0.32, 'sine', 0.12, -2440);
    note(1300, t, 0.32, 'sawtooth', 0.05, -1200);
    noiseHit(t, 0.36, 0.18, 4200, 320, 0.9);
    const a = t + 0.3;
    note(84, a, 0.4, 'sine', 0.36, -44);
    noiseHit(a, 0.05, 0.2, 1800, 600, 1.2, 'bandpass', 0.004);
    noiseHit(a, 0.45, 0.12, 900, 250, 0.8);
    note(1180, a, 0.5, 'triangle', 0.05, -80);
    note(1774, a + 0.01, 0.4, 'sine', 0.03, -60);
  } else if (name === 'lock') {
    // helmet sight: two short pips and a held higher one — quiet, in the ear
    note(1175, t, 0.05, 'sine', 0.1, 0, 0.004);
    note(1175, t + 0.07, 0.05, 'sine', 0.1, 0, 0.004);
    note(1568, t + 0.14, 0.14, 'sine', 0.11, 0, 0.004);
    note(3136, t + 0.14, 0.08, 'triangle', 0.022, 0, 0.004);
    noiseHit(t, 0.01, 0.04, 3000, 0, 3, 'bandpass', 0.002);
  } else if (name === 'pit_decomp') {
    // canopy gone: the cabin air leaves in one violent rush, then only the
    // ears ringing (used by interiorState on death)
    noiseHit(t, 0.02, 0.36, 3000, 800, 1, 'bandpass', 0.002);
    noiseHit(t, 0.7, 0.36, 1800, 180, 0.6, 'bandpass', 0.01);
    noiseHit(t, 0.5, 0.22, 300, 60, 0.7, 'lowpass', 0.006);
    note(70, t, 0.5, 'sine', 0.36, -45);
    note(3620, t + 0.25, 4.5, 'sine', 0.03, 0, 0.6);
    note(3655, t + 0.25, 4.5, 'sine', 0.011, 0, 0.6);
  } else if (name === 'pit_alarm') {
    // master caution, one two-tone cycle (interiorState repeats it)
    note(740, t, 0.17, 'triangle', 0.085);
    note(1480, t, 0.12, 'sine', 0.02);
    note(554, t + 0.2, 0.22, 'triangle', 0.085);
    note(1108, t + 0.2, 0.14, 'sine', 0.02);
  } else if (name === 'pit_chirp') {
    // the same warning once it has made its point
    note(740, t, 0.06, 'sine', 0.045);
    note(554, t + 0.08, 0.08, 'sine', 0.045);
  } else if (name === 'pit_gun') {
    // own cannon cycling, felt through the seat
    note(66, t, 0.07, 'sine', 0.2, -26, 0.004);
    noiseHit(t, 0.03, 0.1, 380, 150, 1, 'lowpass', 0.003);
    noiseHit(t, 0.012, 0.04, 2200, 0, 3, 'bandpass', 0.002);
  } else if (name === 'pit_rocket') {
    // rail clunk under the wing + the motor hissing away
    note(88, t, 0.12, 'square', 0.12, -50, 0.004);
    note(52, t, 0.2, 'sine', 0.26, -20);
    noiseHit(t, 0.35, 0.1, 700, 2400, 1);
  } else if (name === 'pit_beam') {
    // capacitor bank dumping into the beam
    note(46, t + 0.05, 0.4, 'sine', 0.22, -14);
    noiseHit(t + 0.05, 0.3, 0.08, 200, 80, 0.7, 'lowpass');
  }
}

// Dev harness only: renders one synth sound through an OfflineAudioContext
// (unity volume, no panning) so it can be measured without a running context.
export function renderSynth(name, seconds = 3) {
  const sr = actx.sampleRate;
  const off = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
  cx = off;
  OUT = off.destination;
  GAIN = 1;
  try { synth(name, 0); } finally { cx = actx; OUT = null; }
  return off.startRendering();
}

/* ------------------------------ cockpit interior ------------------------------ */
// First-person camera: the world is heard through the hull (low-pass, a bit
// quieter, a touch of small-cabin reverb) while the cabin gets a living bed —
// reactor hum, air system, electronics, engine rumble — driven per frame.

let interiorOn = false;
let bed = null;
let ownX = null;      // player x from interiorState: own shots are recognised by it
let lastThump = 0;
let wasDead = false;
let alarmT0 = 0, alarmNext = 0, ionNext = 0;
const HULL_HZ = 1150, HULL_GAIN = 0.75, HULL_WET = 0.3, FADE = 0.15;

function ramp(param, v, dur = FADE) {
  const t = actx.currentTime;
  param.cancelScheduledValues(t);
  param.setValueAtTime(param.value, t);
  param.linearRampToValueAtTime(v, t + dur);
}

// a 'gun'/'rocket' sample fired from the player's own x is the player's
function isOwnShot(name, x) {
  return (name === 'gun' || name === 'rocket') && x != null && ownX != null && Math.abs(x - ownX) < 0.5;
}

function bodyThump(name) {
  const t = actx.currentTime;
  if (t - lastThump < 0.07) return; // spread guns fire several bolts per frame
  lastThump = t;
  OUT = buses().cabin;
  synth(name === 'rocket' ? 'pit_rocket' : name === 'plaser' ? 'pit_beam' : 'pit_gun', t);
  OUT = null;
}

function cabinSynth(name, when) {
  if (actx.state !== 'running' || settings.sfx <= 0) return;
  OUT = buses().cabin;
  synth(name, when);
  OUT = null;
}

// short, dense, dark impulse: a cockpit is a very small room
function cabinImpulse() {
  const sr = actx.sampleRate, n = Math.floor(sr * 0.22);
  const buf = actx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += (Math.random() * 2 - 1 - lp) * 0.35; // roll the top off
      d[i] = lp * Math.pow(1 - i / n, 2.5);
    }
    for (const ms of ch ? [7, 13, 23] : [5, 11, 19]) d[Math.floor(sr * ms / 1000)] += 0.5; // early reflections off the canopy
  }
  return buf;
}

function hullChain() {
  const b = buses();
  if (b.lp) return b;
  b.lp = actx.createBiquadFilter();
  b.lp.type = 'lowpass';
  b.lp.Q.value = 0.6;
  b.lp.frequency.value = HULL_HZ;
  b.muff = actx.createGain();
  b.muff.gain.value = 0;
  b.lp.connect(b.muff).connect(actx.destination);
  if (!coarse) {
    const conv = actx.createConvolver();
    conv.buffer = cabinImpulse();
    b.wet = actx.createGain();
    b.wet.gain.value = 0;
    b.lp.connect(conv).connect(b.wet).connect(actx.destination);
  }
  return b;
}

// The cabin bed. c/dest are parameters so the harness can render it offline.
function buildBed(c, dest, lite = coarse) {
  const G = (v) => { const g = c.createGain(); g.gain.value = v; return g; };
  const osc = (type, f) => { const o = c.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; };
  const filt = (type, f, q = 0.7) => { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const srcs = [];
  const O = (type, f) => { const o = osc(type, f); srcs.push(o); return o; };

  const out = G(0), drop = G(1);
  out.connect(drop).connect(dest);

  // 2 s of pink-ish noise: long enough that the loop is not heard as a pattern
  const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const nd = nb.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < nd.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    nd[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
  }
  const noise = c.createBufferSource();
  noise.buffer = nb;
  noise.loop = true;
  noise.start();
  srcs.push(noise);

  // slow breathing shared by the hum and the electronics
  const lfo = O('sine', 0.09), lfoG = G(0.16);
  lfo.connect(lfoG);

  // reactor: fundamental + a slightly sharp octave (slow beat) + a third partial for small speakers
  const humG = G(1);
  lfoG.connect(humG.gain);
  const h1 = O('sine', 54), h2 = O('sine', 108.6), h3 = O('triangle', 162.4);
  h1.connect(G(0.02)).connect(humG);
  h2.connect(G(0.011)).connect(humG);
  h3.connect(G(0.0035)).connect(humG);
  humG.connect(out);

  // air system: soft broadband hiss
  const air = filt('bandpass', 1700, 0.45), airG = G(0.011);
  noise.connect(air).connect(airG).connect(out);

  // electronics: two faint high tones drifting against each other
  let elecG = null;
  if (!lite) {
    elecG = G(1);
    lfoG.connect(elecG.gain);
    O('sine', 2930).connect(G(0.0011)).connect(elecG);
    O('sine', 4417).connect(G(0.0006)).connect(elecG);
    elecG.connect(out);
  }

  // engine: low-passed noise rumble + a filtered saw that climbs with thrust
  const engLP = filt('lowpass', 100, 0.8), engG = G(0);
  noise.connect(engLP).connect(engG).connect(out);
  const eng = O('sawtooth', 38), engOLP = filt('lowpass', 150, 1.2), engOG = G(0);
  eng.connect(engOLP).connect(engOG).connect(out);

  // hyperspace whine: detuned saws through a moving band-pass + rushing air
  const warpBP = filt('bandpass', 900, 3), warpG = G(0);
  const w1 = O('sawtooth', 420), w2 = lite ? null : O('sawtooth', 425);
  w1.connect(warpBP);
  if (w2) w2.connect(warpBP);
  warpBP.connect(warpG).connect(out);
  const rushBP = filt('bandpass', 2500, 0.8), rushG = G(0);
  noise.connect(rushBP).connect(rushG).connect(out);

  // shield: a fifth with a fast tremolo
  const shG = G(0), shTrem = G(0.7);
  const trem = O('sine', 8.3), tremG = G(0.3);
  trem.connect(tremG).connect(shTrem.gain);
  O('sine', 196).connect(shTrem);
  O('sine', 294.7).connect(G(0.6)).connect(shTrem);
  shTrem.connect(shG).connect(out);

  return { c, out, drop, srcs, h1, h2, h3, humG, airG, elecG, engLP, engG, eng, engOLP, engOG, warpBP, warpG, w1, w2, rushBP, rushG, shG };
}

const c01 = (x) => Math.max(0, Math.min(1, +x || 0));

function driveBed(b, s, t, vol) {
  const k = (p, v, tc = 0.25) => p.setTargetAtTime(v, t, tc);
  const boost = s.boost ? 1 : 0, od = s.overdrive ? 1 : 0;
  const speed = c01(s.speed), warp = c01(s.warp), ion = c01(s.ion);
  k(b.out.gain, vol * (s.dead ? 0 : s.paused ? 0.05 : 1), 0.12);

  const hf = 54 * (1 + 0.16 * od + 0.05 * boost + 0.1 * warp);
  k(b.h1.frequency, hf, 0.6);
  k(b.h2.frequency, hf * 2.011, 0.6);
  k(b.h3.frequency, hf * 3.007, 0.6);
  k(b.humG.gain, 1 + 0.3 * od, 0.5);
  if (b.elecG) k(b.elecG.gain, 1 + 4 * ion, 0.2);

  const e = Math.min(1, 0.1 + 0.5 * speed + 0.45 * boost + 0.25 * warp);
  k(b.engG.gain, 0.012 + 0.11 * e, 0.3);
  k(b.engLP.frequency, 80 + 240 * e, 0.3);
  k(b.eng.frequency, 36 + 30 * e + 6 * od, 0.35);
  k(b.engOG.gain, 0.005 + 0.03 * e, 0.3);
  k(b.engOLP.frequency, 140 + 380 * e, 0.3);

  const wf = 420 + 2200 * warp;
  k(b.w1.frequency, wf, 0.15);
  if (b.w2) k(b.w2.frequency, wf * 1.012, 0.15);
  k(b.warpBP.frequency, wf * 1.5, 0.15);
  k(b.warpG.gain, Math.pow(warp, 1.4) * 0.03, 0.15);
  k(b.rushBP.frequency, 2500 + 3500 * warp, 0.15);
  k(b.rushG.gain, warp * 0.035, 0.15);

  k(b.shG.gain, s.shield ? 0.012 : 0, 0.2);
}

function killBed() {
  if (!bed) return;
  const b = bed;
  bed = null;
  for (const s of b.srcs) { try { s.stop(); } catch {} }
  b.drop.disconnect();
}

// brings the graph in line with interiorOn; called again once audio unlocks
function syncInterior() {
  if (actx.state !== 'running') return;
  if (interiorOn) {
    const b = hullChain();
    if (!bed) {
      try { b.world.connect(b.lp); } catch {}
      bed = buildBed(actx, actx.destination);
      ramp(b.lp.frequency, HULL_HZ, 0.02);
      ramp(b.dry.gain, 0);
      ramp(b.muff.gain, HULL_GAIN);
      if (b.wet) ramp(b.wet.gain, HULL_WET);
    }
  } else if (bed) {
    const b = buses(), old = bed;
    ramp(b.dry.gain, 1);
    ramp(b.muff.gain, 0);
    if (b.wet) ramp(b.wet.gain, 0);
    ramp(old.out.gain, 0);
    setTimeout(() => {
      if (interiorOn || bed !== old) return; // switched back on meanwhile
      killBed();
      try { b.world.disconnect(b.lp); } catch {}
    }, 400);
  }
}

// Cockpit mode on/off. Safe before the first user gesture: the state is kept
// and applied when the context starts.
export function setInterior(on) {
  on = !!on;
  if (on === interiorOn) return;
  interiorOn = on;
  wasDead = false;
  alarmT0 = 0;
  if (!on) ownX = null;
  if (on && bed) { // re-entered during the fade-out: just fade back
    const b = buses();
    ramp(b.lp.frequency, HULL_HZ, 0.02);
    ramp(b.dry.gain, 0);
    ramp(b.muff.gain, HULL_GAIN);
    if (b.wet) ramp(b.wet.gain, HULL_WET);
  }
  syncInterior();
}

// Per-frame cockpit state: { boost, speed 0..1, warp 0..1, hp, hpMax, shield,
// ion 0..1, overdrive, paused, dead } plus optional x (player world x, lets
// the mixer tell the pilot's own 'gun'/'rocket' samples from enemy fire).
export function interiorState(s) {
  if (!interiorOn || !s) return;
  if (s.x != null) ownX = s.x;
  if (!bed) syncInterior();
  if (!bed) return;
  const t = actx.currentTime, b = buses();
  driveBed(bed, s, t, settings.sfx);

  // death: the canopy goes — one violent rush of air, then the world is far
  // away behind ringing ears until the run restarts
  const dead = !!s.dead;
  if (dead !== wasDead) {
    wasDead = dead;
    if (dead) cabinSynth('pit_decomp', t);
    b.lp.frequency.setTargetAtTime(dead ? 240 : HULL_HZ, t, dead ? 0.12 : 0.05);
    b.muff.gain.cancelScheduledValues(t);
    b.muff.gain.setTargetAtTime(dead ? HULL_GAIN * 0.5 : HULL_GAIN, t, 0.1);
  }
  if (dead || s.paused) { alarmT0 = 0; return; }

  // master caution on the last hit point: insistent for ~4 s, then it backs
  // off to an occasional chirp so it never becomes the soundtrack
  if (s.hp === 1 && s.hpMax > 1) {
    if (!alarmT0) { alarmT0 = t; alarmNext = t + 0.05; }
    if (alarmNext < t) alarmNext = t + 0.02; // frames stalled (tab was hidden)
    if (t >= alarmNext - 0.05) {
      const loud = alarmNext - alarmT0 < 4;
      cabinSynth(loud ? 'pit_alarm' : 'pit_chirp', alarmNext);
      alarmNext += loud ? 0.85 : 2.8;
    }
  } else alarmT0 = 0;

  // ion storm: the power stutters — the bed drops out for an instant and
  // something behind the panel crackles
  const ion = c01(s.ion);
  if (ion > 0.05 && t >= ionNext) {
    ionNext = t + (0.15 + Math.random() * 0.9) / (0.25 + ion);
    const hold = 0.03 + Math.random() * 0.08;
    bed.drop.gain.cancelScheduledValues(t);
    bed.drop.gain.setTargetAtTime(0.25, t, 0.004);
    bed.drop.gain.setTargetAtTime(1, t + hold, 0.03);
    if (settings.sfx > 0) {
      OUT = b.cabin;
      GAIN = 0.35 + 0.65 * ion;
      noiseHit(t, 0.014, 0.12, 5000 + Math.random() * 3000, 0, 2, 'bandpass', 0.002);
      if (Math.random() < 0.5) noiseHit(t + hold, 0.02, 0.09, 3500 + Math.random() * 2500, 0, 2.5, 'bandpass', 0.002);
      if (Math.random() < 0.3 * ion) note(1800, t, 0.05, 'sawtooth', 0.04, -1400, 0.003);
      OUT = null;
      GAIN = 1;
    }
  }
}

// Dev harness only: the cabin bed held in state s, rendered offline.
export function renderBed(s, seconds = 3) {
  const sr = actx.sampleRate;
  const off = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
  const b = buildBed(off, off.destination, false);
  driveBed(b, s, 0, 1);
  return off.startRendering();
}

/* ---------------------------------- music ---------------------------------- */

const musicEls = {};
const musicGains = {};
const musicFilters = {};
let currentTrack = null;
let currentBaseVol = 0.45;
let musicIntensity = 0; // 0 = calm exploration, 1 = boss/overdrive peak

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
      // reactive low-pass: mellow while calm, opens up as the action heats up
      const filter = actx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 20000;
      const gain = actx.createGain();
      src.connect(filter).connect(gain).connect(actx.destination);
      musicGains[track] = gain;
      musicFilters[track] = filter;
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
  musicIntensity = 0; // start calm/open; the game feeds intensity per frame
  if (musicFilters[track]) musicFilters[track].frequency.value = 20000;
  try { el.currentTime = 0; } catch {}
  if (settings.music > 0) el.play().catch(() => {}); // if blocked, the unlock handler retries
}

// Reactive music: the game feeds a 0..1 intensity (boss / combo / overdrive)
// and the current track swells in volume and brightens (filter opens). Smooth
// ramps keep it musical; safe to call every frame.
export function setMusicIntensity(x) {
  musicIntensity = Math.max(0, Math.min(1, x || 0));
  if (!currentTrack) return;
  const t = actx.currentTime;
  const g = musicGains[currentTrack];
  const f = musicFilters[currentTrack];
  if (g) g.gain.setTargetAtTime(currentBaseVol * settings.music * (1 + 0.45 * musicIntensity), t, 0.5);
  if (f) f.frequency.setTargetAtTime(7000 + 13000 * musicIntensity, t, 0.5); // slight mellow → full presence
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
// the cockpit bed may have been requested before the first gesture
actx.addEventListener?.('statechange', () => syncInterior());

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
