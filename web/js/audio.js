// WebAudio SFX + streamed HTMLAudio music
const AC = window.AudioContext || window.webkitAudioContext;
const actx = new AC();
const buffers = {};

const SFX = ['click', 'hover', 'gun', 'explosion', 'powerup', 'rocket', 'player1_kill', 'player2_kill'];

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

let musicEl = null;
let currentTrack = null;

export function playMusic(track, volume = 0.45) {
  if (currentTrack === track) return;
  stopMusic();
  currentTrack = track;
  musicEl = new Audio(`assets/sounds/${track}.m4a`);
  musicEl.loop = true;
  musicEl.volume = volume;
  musicEl.play().catch(() => {});
}

export function stopMusic() {
  if (musicEl) { musicEl.pause(); musicEl = null; }
  currentTrack = null;
}

export function unlock() {
  if (actx.state !== 'running') actx.resume().catch(() => {});
}
