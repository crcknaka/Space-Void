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
