(function (global) {
  const SpaceVoid = (global.SpaceVoid = global.SpaceVoid || {});
  if (SpaceVoid.uiAudio) {
    return;
  }

  const AudioContextClass = global.AudioContext || global.webkitAudioContext;
  const FALLBACK = {
    play: () => {},
    setVolume: () => {},
    getVolume: () => 0,
    bindInteractivity: () => {},
  };

  if (!AudioContextClass) {
    SpaceVoid.uiAudio = FALLBACK;
    return;
  }

  const BASE_GAIN = 0.55;
  const MAX_DELAY_TIME = 0.4;
  const HOVER_DEBOUNCE_MS = 120;
  const ADJUST_DEBOUNCE_MS = 140;

  let context = null;
  let masterGain = null;
  let effectInput = null;
  let filterNode = null;
  let delayNode = null;
  let delayFeedback = null;
  let delayWet = null;
  let compressor = null;
  let noiseBuffer = null;
  let currentVolume = 0.7;
  let interactivityBound = false;
  const lastHoverTimes = new WeakMap();
  const lastAdjustTimes = new WeakMap();

  function ensureContext() {
    if (context) return context;
    context = new AudioContextClass({ latencyHint: 'interactive' });
    masterGain = context.createGain();
    masterGain.gain.value = currentVolume * BASE_GAIN;

    effectInput = context.createGain();
    effectInput.gain.value = 0.42;

    filterNode = context.createBiquadFilter();
    filterNode.type = 'lowpass';
    filterNode.frequency.value = 1600;
    filterNode.Q.value = 0.6;

    compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.1;

    delayNode = context.createDelay(MAX_DELAY_TIME);
    delayNode.delayTime.value = 0.07;

    delayFeedback = context.createGain();
    delayFeedback.gain.value = 0.1;

    delayWet = context.createGain();
    delayWet.gain.value = 0.14;

    effectInput.connect(filterNode);
    filterNode.connect(compressor);
    compressor.connect(masterGain);

    filterNode.connect(delayNode);
    delayNode.connect(delayWet);
    delayWet.connect(masterGain);
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);

    masterGain.connect(context.destination);

    return context;
  }

  function resumeContext() {
    if (!context) return;
    if (context.state === 'suspended') {
      context.resume().catch(() => {});
    }
  }

  function getNoiseBuffer() {
    if (noiseBuffer) return noiseBuffer;
    const ctx = ensureContext();
    const length = Math.floor(ctx.sampleRate * 0.2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      const t = i / length;
      const fade = 1 - t;
      data[i] = (Math.random() * 2 - 1) * fade;
    }
    noiseBuffer = buffer;
    return noiseBuffer;
  }

  function scheduleGainEnvelope(gainNode, now, { attack = 0.01, decay = 0.05, sustain = 0.4, release = 0.1, duration = 0.3 }) {
    const peak = now + attack;
    const decayEnd = peak + decay;
    const stopTime = now + duration + release;

    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.linearRampToValueAtTime(1, peak);
    gainNode.gain.linearRampToValueAtTime(sustain, decayEnd);
    gainNode.gain.setTargetAtTime(0.0001, now + duration, release * 0.6);

    return stopTime;
  }

  function withCleanup(node, cleanup) {
    if (!node || typeof cleanup !== 'function') return;
    node.addEventListener('ended', () => {
      if (cleanup.__uiAudioDone) {
        return;
      }
      cleanup.__uiAudioDone = true;
      cleanup();
    });
  }

  function playHover(now) {
    const ctx = ensureContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(620, now + 0.16);

    const stopTime = scheduleGainEnvelope(gain, now, {
      attack: 0.012,
      decay: 0.06,
      sustain: 0.18,
      release: 0.1,
      duration: 0.16,
    });

    osc.connect(gain);
    gain.connect(effectInput);
    osc.start(now);
    osc.stop(stopTime);
    withCleanup(osc, () => {
      osc.disconnect();
      gain.disconnect();
    });
  }

  function playClick(now) {
    const ctx = ensureContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(360, now);
    osc.frequency.linearRampToValueAtTime(520, now + 0.07);

    const stopTime = scheduleGainEnvelope(gain, now, {
      attack: 0.004,
      decay: 0.06,
      sustain: 0.2,
      release: 0.1,
      duration: 0.14,
    });

    osc.connect(gain);
    gain.connect(effectInput);
    osc.start(now);
    osc.stop(stopTime);
    withCleanup(osc, () => {
      osc.disconnect();
      gain.disconnect();
    });
  }

  function playConfirm(now) {
    const ctx = ensureContext();
    const gain = ctx.createGain();
    gain.connect(effectInput);

    const oscA = ctx.createOscillator();
    oscA.type = 'sine';
    oscA.frequency.setValueAtTime(420, now);
    oscA.frequency.linearRampToValueAtTime(600, now + 0.12);

    const oscB = ctx.createOscillator();
    oscB.type = 'sine';
    const secondStart = now + 0.08;
    oscB.frequency.setValueAtTime(560, secondStart);
    oscB.frequency.linearRampToValueAtTime(760, secondStart + 0.12);

    const stopTime = scheduleGainEnvelope(gain, now, {
      attack: 0.008,
      decay: 0.08,
      sustain: 0.26,
      release: 0.18,
      duration: 0.24,
    });

    oscA.connect(gain);
    oscB.connect(gain);
    oscA.start(now);
    oscB.start(secondStart);
    oscA.stop(stopTime);
    oscB.stop(stopTime);
    const cleanup = () => {
      oscA.disconnect();
      oscB.disconnect();
      gain.disconnect();
    };
    withCleanup(oscA, cleanup);
    withCleanup(oscB, cleanup);
  }

  function playCancel(now) {
    const ctx = ensureContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.linearRampToValueAtTime(140, now + 0.2);

    const stopTime = scheduleGainEnvelope(gain, now, {
      attack: 0.014,
      decay: 0.1,
      sustain: 0.16,
      release: 0.18,
      duration: 0.22,
    });

    osc.connect(gain);
    gain.connect(effectInput);
    osc.start(now);
    osc.stop(stopTime);
    withCleanup(osc, () => {
      osc.disconnect();
      gain.disconnect();
    });
  }

  function playToggle(now, options = {}) {
    const { rising = true } = options;
    const ctx = ensureContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    const startFreq = rising ? 380 : 300;
    const endFreq = rising ? 560 : 220;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.linearRampToValueAtTime(endFreq, now + 0.15);

    const stopTime = scheduleGainEnvelope(gain, now, {
      attack: 0.006,
      decay: 0.08,
      sustain: 0.2,
      release: 0.18,
      duration: 0.18,
    });

    osc.connect(gain);
    gain.connect(effectInput);
    osc.start(now);
    osc.stop(stopTime);
    withCleanup(osc, () => {
      osc.disconnect();
      gain.disconnect();
    });
  }

  function playDisabled(now) {
    const ctx = ensureContext();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    source.buffer = getNoiseBuffer();
    filter.type = 'bandpass';
    filter.frequency.value = 150;
    filter.Q.value = 5;

    const stopTime = scheduleGainEnvelope(gain, now, {
      attack: 0.003,
      decay: 0.04,
      sustain: 0.18,
      release: 0.1,
      duration: 0.1,
    });

    source.connect(filter);
    filter.connect(gain);
    gain.connect(effectInput);

    source.start(now);
    source.stop(stopTime);
    withCleanup(source, () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    });
  }

  function playInputSlide(now) {
    const ctx = ensureContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.linearRampToValueAtTime(500, now + 0.05);

    const stopTime = scheduleGainEnvelope(gain, now, {
      attack: 0.003,
      decay: 0.04,
      sustain: 0.16,
      release: 0.08,
      duration: 0.08,
    });

    osc.connect(gain);
    gain.connect(effectInput);
    osc.start(now);
    osc.stop(stopTime);
    withCleanup(osc, () => {
      osc.disconnect();
      gain.disconnect();
    });
  }

  const SOUND_BUILDERS = {
    hover: playHover,
    click: playClick,
    confirm: playConfirm,
    cancel: playCancel,
    toggleOn: (now) => playToggle(now, { rising: true }),
    toggleOff: (now) => playToggle(now, { rising: false }),
    disabled: playDisabled,
    adjust: playInputSlide,
  };

  function play(type) {
    const builder = SOUND_BUILDERS[type];
    if (!builder) return;
    const ctx = ensureContext();
    resumeContext();
    const now = ctx.currentTime;
    builder(now);
  }

  function setVolume(volume) {
    currentVolume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : currentVolume));
    if (masterGain && context) {
      const now = context.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setTargetAtTime(currentVolume * BASE_GAIN, now, 0.02);
    }
  }

  function getVolume() {
    return currentVolume;
  }

  const SOUND_PROFILES = {
    button: {
      hover: 'hover',
      focus: 'hover',
      click: 'click',
      disabled: 'disabled',
    },
    toggle: {
      hover: 'hover',
      focus: 'hover',
      change: (element) => (element.checked ? 'toggleOn' : 'toggleOff'),
      click: null,
      disabled: 'disabled',
    },
    control: {
      hover: 'hover',
      focus: 'hover',
      input: 'adjust',
    },
  };

  function resolveProfile(element) {
    if (!element || !(element instanceof HTMLElement)) return SOUND_PROFILES.button;
    const profileName = element.dataset.uiSound;
    if (profileName && SOUND_PROFILES[profileName]) {
      return SOUND_PROFILES[profileName];
    }
    if (element.matches('input[type="checkbox"], input[type="radio"][role="switch"], [role="switch"]')) {
      return SOUND_PROFILES.toggle;
    }
    return SOUND_PROFILES.button;
  }

  function getSoundForEvent(element, eventName, event) {
    if (!(element instanceof HTMLElement)) return null;
    const datasetKey = `sound${eventName.charAt(0).toUpperCase()}${eventName.slice(1)}`;
    if (element.dataset && element.dataset[datasetKey]) {
      return element.dataset[datasetKey];
    }
    const profile = resolveProfile(element);
    const mapping = profile[eventName];
    if (!mapping) return null;
    if (typeof mapping === 'function') {
      return mapping(element, event);
    }
    return mapping;
  }

  function isDisabled(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
      if (element.disabled) return true;
    }
    if (element.hasAttribute('aria-disabled')) {
      return element.getAttribute('aria-disabled') === 'true';
    }
    return element.classList.contains('is-disabled');
  }

  function shouldPlayWithDebounce(map, element, interval) {
    const now = performance.now();
    const last = map.get(element) || 0;
    if (now - last < interval) {
      return false;
    }
    map.set(element, now);
    return true;
  }

  function shouldPlayHover(element) {
    return shouldPlayWithDebounce(lastHoverTimes, element, HOVER_DEBOUNCE_MS);
  }

  function shouldPlayAdjust(element) {
    return shouldPlayWithDebounce(lastAdjustTimes, element, ADJUST_DEBOUNCE_MS);
  }

  function bindInteractivity() {
    if (interactivityBound || typeof document === 'undefined') return;
    interactivityBound = true;

    document.addEventListener('pointerdown', (event) => {
      const element = event.target instanceof HTMLElement ? event.target.closest('[data-ui-sound]') : null;
      if (!element) return;
      if (isDisabled(element)) {
        const sound = getSoundForEvent(element, 'disabled', event);
        if (sound) {
          play(sound);
        }
      }
    }, true);

    document.addEventListener('pointerover', (event) => {
      const element = event.target instanceof HTMLElement ? event.target.closest('[data-ui-sound]') : null;
      if (!element) return;
      if (isDisabled(element)) return;
      const related = event.relatedTarget instanceof HTMLElement ? event.relatedTarget.closest('[data-ui-sound]') : null;
      if (element === related || (related && element.contains(related))) {
        return;
      }
      if (!shouldPlayHover(element)) return;
      const sound = getSoundForEvent(element, 'hover', event);
      if (sound) {
        play(sound);
      }
    });

    document.addEventListener('focusin', (event) => {
      const element = event.target instanceof HTMLElement ? event.target.closest('[data-ui-sound]') : null;
      if (!element || isDisabled(element)) return;
      const sound = getSoundForEvent(element, 'focus', event);
      if (sound) {
        play(sound);
      }
    });

    document.addEventListener('click', (event) => {
      const element = event.target instanceof HTMLElement ? event.target.closest('[data-ui-sound]') : null;
      if (!element) return;
      if (isDisabled(element)) {
        const disabledSound = getSoundForEvent(element, 'disabled', event);
        if (disabledSound) {
          play(disabledSound);
        }
        return;
      }
      const sound = getSoundForEvent(element, 'click', event);
      if (sound) {
        play(sound);
      }
    });

    document.addEventListener('change', (event) => {
      const element = event.target instanceof HTMLElement ? event.target.closest('[data-ui-sound]') : null;
      if (!element) return;
      if (isDisabled(element)) return;
      const sound = getSoundForEvent(element, 'change', event);
      if (sound) {
        play(sound);
      }
    });

    document.addEventListener('input', (event) => {
      const element = event.target instanceof HTMLElement ? event.target.closest('[data-ui-sound]') : null;
      if (!element) return;
      if (isDisabled(element)) return;
      if (!shouldPlayAdjust(element)) return;
      const sound = getSoundForEvent(element, 'input', event);
      if (sound) {
        play(sound);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const element = event.target instanceof HTMLElement ? event.target.closest('[data-ui-sound]') : null;
      if (!element || isDisabled(element)) return;
      if (element.matches('button, [role="button"], [data-sound-click], [data-ui-sound]')) {
        resumeContext();
      }
    }, true);

    document.addEventListener('pointerdown', () => {
      resumeContext();
    });
  }

  const uiAudio = {
    play,
    setVolume,
    getVolume,
    bindInteractivity,
  };

  SpaceVoid.uiAudio = uiAudio;
  bindInteractivity();
})(window);
