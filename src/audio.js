/**
 * Audio engine with Web Audio API.
 * Handles Mozart playback, progressive distortion, glass sounds, pop, and horror ambient.
 */

const GLASS_INTERVALS = [
  [0.0, 2.3],
  [3.65, 5.0],
  [5.3, 7.0],
  [7.3, 9.4],
  [9.7, 12.0],
  [13.3, 15.0],
  [16.2, 19.0],
  [19.3, 21.0],
  [21.7, 24.5],
];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.mozartBuffer = null;
    this.glassBuffer = null;
    this.horrorBuffer = null;
    this.popBuffer = null;
    this.mozartSource = null;
    this.horrorSource = null;
    this.mozartStartTime = 0;
    this.isPlaying = false;

    // Distortion chain nodes
    this.inputGain = null;
    this.waveshaper = null;
    this.filterLow = null;
    this.filterHigh = null;
    this.lfo = null;
    this.lfoGain = null;
    this.tremoloGain = null;
    this.compressor = null;
    this.masterGain = null;
    this.noiseGain = null;
    this.noiseSource = null;

    this.distortionLevel = 0;
    this._cleanCurve = null;
    this._cleanInputGain = 1;
    this._lastCurveAmount = -1; // track last curve amount to avoid redundant replacements

    // Global pitch drift state
    this._driftUpdateInterval = 0.4; // seconds between drift target changes
    this._lastDriftTime = 0;
    this._currentDriftTarget = 0;
  }

  async init() {
    this.ctx = new AudioContext();

    const [mozartBuf, glassBuf, horrorBuf, popBuf] = await Promise.all([
      this._loadBuffer('/mz_545_1.mp3'),
      this._loadBuffer('/glass.m4a'),
      this._loadBuffer('/horror.m4a'),
      this._loadBuffer('/pop.m4a'),
    ]);

    this.mozartBuffer = mozartBuf;
    this.glassBuffer = glassBuf;
    this.horrorBuffer = horrorBuf;
    this.popBuffer = popBuf;

    this._buildChain();
  }

  async _loadBuffer(url) {
    const resp = await fetch(url);
    const arrayBuf = await resp.arrayBuffer();
    return this.ctx.decodeAudioData(arrayBuf);
  }

  _buildChain() {
    const ctx = this.ctx;

    this.inputGain = ctx.createGain();
    this.inputGain.gain.value = 1;

    // Waveshaper — start perfectly linear
    this.waveshaper = ctx.createWaveShaper();
    this._cleanCurve = this._makeDistortionCurve(0);
    this.waveshaper.curve = this._cleanCurve;
    this.waveshaper.oversample = '4x';

    // Filters — start transparent
    this.filterLow = ctx.createBiquadFilter();
    this.filterLow.type = 'lowpass';
    this.filterLow.frequency.value = 22050;
    this.filterLow.Q.value = 0.5;

    this.filterHigh = ctx.createBiquadFilter();
    this.filterHigh.type = 'highpass';
    this.filterHigh.frequency.value = 10;
    this.filterHigh.Q.value = 0.5;

    // Tremolo via LFO
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 0;
    this.tremoloGain = ctx.createGain();
    this.tremoloGain.gain.value = 1;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.tremoloGain.gain);
    this.lfo.start();

    // Dynamics compressor — brick-wall limiter to prevent loudness increase.
    // Aggressively compresses anything above -24dB, with hard-knee and
    // high ratio to keep perceived volume from rising with distortion.
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -15;  // moderate threshold
    this.compressor.knee.value = 10;        // soft knee for natural sound
    this.compressor.ratio.value = 12;       // strong compression
    this.compressor.attack.value = 0.003;   // fast attack
    this.compressor.release.value = 0.15;   // moderate release

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 1;

    // White noise (starts silent)
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this._startNoise();

    // Chain: input → waveshaper → filters → tremolo → compressor → master → output
    this.inputGain.connect(this.waveshaper);
    this.waveshaper.connect(this.filterLow);
    this.filterLow.connect(this.filterHigh);
    this.filterHigh.connect(this.tremoloGain);
    this.tremoloGain.connect(this.compressor);
    this.noiseGain.connect(this.compressor);
    this.compressor.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);
  }

  _startNoise() {
    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseSource = this.ctx.createBufferSource();
    this.noiseSource.buffer = noiseBuffer;
    this.noiseSource.loop = true;
    this.noiseSource.connect(this.noiseGain);
    this.noiseSource.start();
  }

  _makeDistortionCurve(amount) {
    const samples = 44100;
    const curve = new Float32Array(samples);
    const k = amount;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = k === 0 ? x : ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  playMozart(fadeDuration = 0.3) {
    if (this.isPlaying) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.mozartSource = this.ctx.createBufferSource();
    this.mozartSource.buffer = this.mozartBuffer;
    this.mozartSource.loop = true;
    this.mozartSource.connect(this.inputGain);
    this.mozartSource.start();
    this.mozartStartTime = this.ctx.currentTime;
    this.isPlaying = true;

    // Fade in: start silent and ramp to full over fadeDuration
    const now = this.ctx.currentTime;
    this.masterGain.gain.setValueAtTime(0, now);
    this.masterGain.gain.linearRampToValueAtTime(1, now + fadeDuration);
  }

  playPop() {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const source = this.ctx.createBufferSource();
    source.buffer = this.popBuffer;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.6;
    source.connect(gain);
    gain.connect(this.ctx.destination);
    source.start();
  }

  getMozartTime() {
    if (!this.isPlaying) return 0;
    const elapsed = this.ctx.currentTime - this.mozartStartTime;
    return elapsed % this.mozartBuffer.duration;
  }

  getMozartDuration() {
    return this.mozartBuffer ? this.mozartBuffer.duration : 260;
  }

  /**
   * Set distortion 0 (clean) to 1 (maximum).
   * Applies internal quadratic curve so early values are nearly silent.
   */
  setDistortion(level) {
    const eff = level * level; // quadratic ramp
    // Skip if the effective distortion hasn't changed meaningfully —
    // avoids scheduling redundant audio automation every frame.
    if (Math.abs(eff - this.distortionLevel) < 0.0001) return;
    this.distortionLevel = eff;
    const now = this.ctx.currentTime;

    if (eff < 0.001) {
      this.waveshaper.curve = this._cleanCurve;
      this.inputGain.gain.setTargetAtTime(1, now, 0.05);
      this.filterLow.frequency.setTargetAtTime(22050, now, 0.05);
      this.filterLow.Q.setTargetAtTime(0.5, now, 0.05);
      this.filterHigh.frequency.setTargetAtTime(10, now, 0.05);
      this.lfo.frequency.setTargetAtTime(0, now, 0.05);
      this.lfoGain.gain.setTargetAtTime(0, now, 0.05);
      this.noiseGain.gain.setTargetAtTime(0, now, 0.1);
      this.masterGain.gain.setTargetAtTime(1, now, 0.1);
      if (this.mozartSource) this.mozartSource.detune.setTargetAtTime(0, now, 0.05);
      return;
    }

    // Only replace the waveshaper curve when the amount has changed meaningfully.
    // Assigning a new Float32Array every frame causes audible clicks because the
    // lookup-table swap can create sample discontinuities.
    const curveAmount = Math.round(eff * 400);
    if (curveAmount !== this._lastCurveAmount) {
      this._lastCurveAmount = curveAmount;
      this.waveshaper.curve = this._makeDistortionCurve(curveAmount);
    }

    // Reduce input gain as distortion rises — starve the waveshaper so it
    // has less signal to compress. At max distortion, input is 55%.
    const inputComp = 1 - eff * 0.45;
    this.inputGain.gain.setTargetAtTime(Math.max(0.40, inputComp), now, 0.08);
    this._cleanInputGain = inputComp;

    this.filterLow.frequency.setTargetAtTime(22050 - eff * 21250, now, 0.08);
    // Cap filter Q low — high Q creates huge resonant peaks
    this.filterLow.Q.setTargetAtTime(0.5 + eff * 3, now, 0.08);
    this.filterHigh.frequency.setTargetAtTime(10 + eff * 390, now, 0.08);
    this.lfo.frequency.setTargetAtTime(eff * 8, now, 0.08);
    // Moderate tremolo depth
    this.lfoGain.gain.setTargetAtTime(eff * 0.15, now, 0.08);
    // Restrained noise
    this.noiseGain.gain.setTargetAtTime(eff * 0.05, now, 0.15);

    // Master gain compensation — compressor handles most limiting,
    // this just trims the overall level gently.
    // At max distortion → ~0.25 gain.
    const gainComp = 1 - eff * 0.55;
    this.masterGain.gain.setTargetAtTime(Math.max(0.25, gainComp), now, 0.12);

    // ── Global pitch drift ──
    // Only update the drift target every ~0.4s so it wanders smoothly
    // instead of jittering every frame. At max distortion: ±2400 cents (±2 octaves).
    if (this.mozartSource) {
      if (now - this._lastDriftTime > this._driftUpdateInterval) {
        this._lastDriftTime = now;
        this._currentDriftTarget = (Math.random() - 0.5) * eff * 4800; // ±2400 at eff=1
      }
      // Slow ramp (0.3s time constant) so the pitch slides rather than jumps
      this.mozartSource.detune.setTargetAtTime(this._currentDriftTarget, now, 0.3);
    }
  }

  pulseNote() {
    const eff = this.distortionLevel;
    if (eff < 0.03) return;
    const now = this.ctx.currentTime;
    const baseQ = 0.5 + eff * 3;
    // Smooth Q pulse — 15ms ramp avoids resonant click artifacts
    this.filterLow.Q.setTargetAtTime(baseQ + eff * 1.5, now, 0.015);
    this.filterLow.Q.setTargetAtTime(baseQ, now + 0.05, 0.08);

    // ── Per-note pitch snap ──
    // Every note triggers a dramatic pitch jump. At max distortion:
    // ±3600 cents = ±3 octaves. Uses setTargetAtTime with a very short
    // time constant instead of setValueAtTime to avoid click artifacts
    // from instantaneous discontinuities.
    if (this.mozartSource) {
      const jolt = (Math.random() - 0.5) * eff * 7200; // ±3600 at eff=1
      this.mozartSource.detune.setTargetAtTime(jolt, now, 0.010);
    }
  }

  playGlassSound() {
    const interval = GLASS_INTERVALS[Math.floor(Math.random() * GLASS_INTERVALS.length)];
    const source = this.ctx.createBufferSource();
    source.buffer = this.glassBuffer;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.35;
    source.connect(gain);
    gain.connect(this.ctx.destination);
    source.start(0, interval[0], interval[1] - interval[0]);
  }

  fadeOutMozart(duration = 3) {
    return new Promise((resolve) => {
      const now = this.ctx.currentTime;

      // Cancel any scheduled automations that might fight the fade
      this.masterGain.gain.cancelScheduledValues(now);
      this.inputGain.gain.cancelScheduledValues(now);
      this.noiseGain.gain.cancelScheduledValues(now);
      this.lfoGain.gain.cancelScheduledValues(now);

      // Fade the master output AND the input to the distortion chain
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(0, now + duration);

      this.inputGain.gain.setValueAtTime(this.inputGain.gain.value, now);
      this.inputGain.gain.linearRampToValueAtTime(0, now + duration);

      // Fade out the noise separately (it bypasses inputGain)
      this.noiseGain.gain.setValueAtTime(this.noiseGain.gain.value, now);
      this.noiseGain.gain.linearRampToValueAtTime(0, now + duration);

      // Fade out the LFO modulation to avoid tremolo artifacts
      this.lfoGain.gain.setValueAtTime(this.lfoGain.gain.value, now);
      this.lfoGain.gain.linearRampToValueAtTime(0, now + duration * 0.5);

      // Keep pitch chaos running during the entire fade-out so the song
      // stays unrecognizable until it's fully silent.
      const eff = this.distortionLevel;
      let driftTimer = 0;
      const chaosInterval = setInterval(() => {
        if (!this.mozartSource) return;
        const t = this.ctx.currentTime;
        // Per-note snap every 100ms — smooth 10ms ramp to avoid click artifacts
        const jolt = (Math.random() - 0.5) * eff * 7200;
        this.mozartSource.detune.setTargetAtTime(jolt, t, 0.010);
        // Global drift update every ~400ms
        driftTimer++;
        if (driftTimer % 4 === 0) {
          const drift = (Math.random() - 0.5) * eff * 4800;
          this.mozartSource.detune.setTargetAtTime(drift, t, 0.3);
        }
      }, 100);

      setTimeout(() => {
        clearInterval(chaosInterval);
        if (this.mozartSource) { this.mozartSource.stop(); this.mozartSource = null; }
        if (this.noiseSource) { this.noiseSource.stop(); this.noiseSource = null; }
        this.isPlaying = false;
        resolve();
      }, duration * 1000);
    });
  }

  fadeInHorror(duration = 3) {
    const horrorGain = this.ctx.createGain();
    horrorGain.gain.value = 0;
    horrorGain.connect(this.ctx.destination);
    this.horrorSource = this.ctx.createBufferSource();
    this.horrorSource.buffer = this.horrorBuffer;
    this.horrorSource.loop = true;
    this.horrorSource.connect(horrorGain);
    this.horrorSource.start();
    const now = this.ctx.currentTime;
    horrorGain.gain.setValueAtTime(0, now);
    horrorGain.gain.linearRampToValueAtTime(0.7, now + duration);
    this.horrorGain = horrorGain;
  }

  /**
   * Route a video element through Web Audio and start a gain ramp.
   * Call this RIGHT WHEN the video starts playing (AudioContext must be active).
   *
   * Gain starts at `initialMultiplier` (e.g. 1.5 = 50% louder than normal)
   * and linearly ramps down to 1.0 (normal) over the video's duration.
   *
   * @param {HTMLVideoElement} videoEl
   * @param {number} initialMultiplier – starting gain (>1 = louder than natural)
   */
  startFragmentationVideoRamp(videoEl, initialMultiplier = 1.5) {
    // createMediaElementSource can only be called once per element
    if (!this._fragMediaSource) {
      this._fragMediaSource = this.ctx.createMediaElementSource(videoEl);
      this._fragGain = this.ctx.createGain();
      this._fragMediaSource.connect(this._fragGain);
      this._fragGain.connect(this.ctx.destination);
    }

    const duration = videoEl.duration || 60;
    const now = this.ctx.currentTime;
    this._fragGain.gain.setValueAtTime(initialMultiplier, now);
    this._fragGain.gain.linearRampToValueAtTime(1.0, now + duration);
  }
}
