import { parseMidi } from './midi.js';
import { AudioEngine } from './audio.js';
import { Scene3D, GH3D } from './scene.js';
import { initChat, startEgoChat, triggerFragmentation } from './chat.js';

/* ─── State ─── */
const S = {
  LOADING: 'loading',
  INTRO: 'intro',
  HEAVEN: 'heaven',
  PORTAL_APPEAR: 'portal_appear',
  PORTAL_TRANSITION: 'portal_transition',
  WHAT_IF: 'what_if',
  GUITAR_HERO: 'guitar_hero',
  CHAT: 'chat',
};

let state = S.LOADING;
const audio = new AudioEngine();
let scene3d = null;
let midiNotes = [];
let midiDuration = 0;
let globalTime = 0; // for blob animation

/* ─── DOM ─── */
const $ = (id) => document.getElementById(id);
const introOverlay = $('intro-overlay');
const continueBtn = $('continue-btn');
const heaven = $('heaven');
const heavenWords = $('heaven-words');
const scrollTooltip = $('scroll-tooltip');
const portalContainer = $('portal-container');
const threeCanvas = $('three-canvas');
const egoMessages = $('ego-messages');
const whatIfText = $('what-if-text');
const chatContainer = $('chat-container');
const chatMessages = $('chat-messages');
const chatInput = $('chat-input');

/* ─── Wire up AI chat module ─── */
initChat({
  chatContainer,
  chatMessages,
  chatInput,
  audio,
});

/* ─── Heaven words ─── */
const WORDS = ['Heaven', 'Oneness', 'Mind', 'Love', 'God', 'Christ', 'Joy'];
let heavenWordIdx = 0;
let heavenWordTimer = 0;
const WORD_INTERVAL = 2.8;

function updateHeavenWords(dt) {
  heavenWordTimer += dt;
  if (heavenWordTimer >= WORD_INTERVAL) {
    heavenWordTimer = 0;
    heavenWordIdx = (heavenWordIdx + 1) % WORDS.length;
    showHeavenWord(WORDS[heavenWordIdx]);
  }
}

function showHeavenWord(word) {
  const el = document.createElement('div');
  el.className = 'heaven-word';
  el.textContent = word;
  heavenWords.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.add('visible');
    setTimeout(() => {
      el.classList.remove('visible');
      el.classList.add('fading');
      setTimeout(() => el.remove(), 1200);
    }, 1800);
  });
}

/* ─── Scroll / Portal ─── */
let virtualScroll = 0;
const MAX_SCROLL = 1000;
let scrollEnabled = false;
let tooltipShown = false;
let tooltipTimer = 0;

/* ─── Spring Physics ─── */
class Spring {
  constructor(stiffness = 220, damping = 18) {
    this.value = 0;
    this.target = 0;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
  }
  update(dt) {
    const force = -this.stiffness * (this.value - this.target);
    const damp = -this.damping * this.velocity;
    this.velocity += (force + damp) * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
  isSettled() {
    return (
      Math.abs(this.velocity) < 0.08 &&
      Math.abs(this.value - this.target) < 0.002
    );
  }
}

const portalSpring = new Spring(220, 18);
let portalPhase = 0; // 0=hidden, 1=first spring (5%), 2=second spring (10%), 3=settled (awaiting 2nd scroll), 4=closing

/* ─── Portal two-phase expansion ─── */
let expandPhase = 0; // 0=not expanding, 1=spring to 50%, 2=waiting 1s, 3=slow expand to 100%
const expandSpring = new Spring(120, 14); // softer spring for the 50% bounce
let expandWaitTimer = 0;
let expandSlowProgress = 0;

/* ─── Guitar Hero (3D) ─── */
const GH_SPEED = 4; // world units per second (z travel speed)
const MAX_MISSES = 120;

const GH = {
  active: false,
  songStartPos: 0,
  noteIdx: 0,
  spawnOffset: 0,
  liveNotes: [],
  missCount: 0,
  totalMisses: 0,
  markerX: 0.5, // 0-1 normalized
  mouseX: 0.5,
  HIT_WINDOW: 0.12,
  HIT_X_TOL: 0.06,
  gameElapsed: 0,
  ended: false,
  fadingOut: false,
  minNote: 36,
  maxNote: 89,
};

function noteToWorldX(midiNote) {
  const frac = (midiNote - GH.minNote) / (GH.maxNote - GH.minNote);
  return GH3D.X_MIN + frac * (GH3D.X_MAX - GH3D.X_MIN);
}

function screenXToWorldX(screenFrac) {
  return GH3D.X_MIN + screenFrac * (GH3D.X_MAX - GH3D.X_MIN);
}

/* ─── Ego Messages ─── */
const EGO_MESSAGES = [
  { at: 0, text: 'You are the musician now...' },
  { at: 8, text: 'You are missing some notes!' },
  { at: 40, text: 'What are you doing?!' },
  { at: 70, text: 'The melody is gone!' },
  { at: 100, text: 'You messed up really bad...' },
];
let egoIdx = 0;
let currentEgoEl = null;

function checkEgoMessages() {
  while (
    egoIdx < EGO_MESSAGES.length &&
    GH.totalMisses >= EGO_MESSAGES[egoIdx].at
  ) {
    showEgoMessage(EGO_MESSAGES[egoIdx].text);
    egoIdx++;
  }
}

function showEgoMessage(text) {
  // Remove previous ego message
  if (currentEgoEl) {
    currentEgoEl.remove();
    currentEgoEl = null;
  }

  const el = document.createElement('div');
  el.className = 'ego-msg';
  el.textContent = text;
  egoMessages.appendChild(el);
  currentEgoEl = el;

  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    if (currentEgoEl === el) {
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 800);
      currentEgoEl = null;
    }
  }, 5000);
}

/* ─── Tile destruction scheduling ─── */
let tileDropAccumulator = 0;

function maybeTileDrop() {
  const interval = Math.max(1, Math.floor(12 - GH.totalMisses / 20));
  tileDropAccumulator++;
  if (tileDropAccumulator >= interval) {
    tileDropAccumulator = 0;
    if (scene3d) {
      // Drop 3-4 tiles at once for a more dramatic effect
      const count = 3 + Math.floor(Math.random() * 2); // 3 or 4
      for (let i = 0; i < count; i++) {
        scene3d.destroyRandomTile();
      }
      audio.playGlassSound();
    }
  }
}

/* ─── What-if typing effect (two-phase) ─── */
let whatIfCurrentText = '';
let whatIfPhase2Started = false;
const CURSOR_HTML = '<span class="typing-cursor">\u258C</span>';

// Phase 1: types "What if" while amoeba is still expanding
function startWhatIfPhase1() {
  whatIfText.style.display = 'flex';
  whatIfCurrentText = '';
  whatIfPhase2Started = false;
  const text = 'What if';
  let charIdx = 0;

  function step() {
    if (charIdx < text.length) {
      whatIfCurrentText += text[charIdx];
      whatIfText.innerHTML = whatIfCurrentText + CURSOR_HTML;
      charIdx++;
      setTimeout(step, 80);
    }
    // Phase 1 done – just keep the cursor blinking; phase 2 is triggered externally
  }

  setTimeout(step, 300);
}

// Phase 2: types " I played my own song?" then expands amoeba fully & starts guitar hero
function startWhatIfPhase2() {
  if (whatIfPhase2Started) return;
  whatIfPhase2Started = true;
  const text = ' I could be separate from Heaven?';
  let charIdx = 0;

  function step() {
    if (charIdx < text.length) {
      whatIfCurrentText += text[charIdx];
      whatIfText.innerHTML = whatIfCurrentText + CURSOR_HTML;
      charIdx++;
      setTimeout(step, 65);
    } else {
      // Keep the cursor visible, then fade out text
      // Extra dwell time so users can absorb the full phrase
      setTimeout(() => {
        whatIfText.classList.add('fading');
        // While text fades, expand amoeba from 50% to 100%
        expandPhase = 3;
        expandSlowProgress = 0;
        setTimeout(() => {
          whatIfText.style.display = 'none';
        }, 1000);
      }, 2500);
    }
  }

  setTimeout(step, 400);
}

/* ─── Guitar Hero logic (3D) ─── */
function startGuitarHero() {
  scene3d.setupGuitarHero();
  GH.active = true;
  GH.songStartPos = audio.getMozartTime();
  GH.noteIdx = 0;
  GH.spawnOffset = 0;
  GH.missCount = 0;
  GH.totalMisses = 0;
  GH.gameElapsed = 0;
  GH.ended = false;
  GH.fadingOut = false;
  GH.liveNotes = [];
  GH._delayEnded = false;
  egoIdx = 0;
  tileDropAccumulator = 0;

  state = S.GUITAR_HERO;
}

const GH_START_DELAY = 1; // seconds before notes start appearing

function updateGuitarHero(dt) {
  if (!GH.active || GH.ended) return;

  GH.gameElapsed += dt;
  const songDuration = audio.getMozartDuration();
  const scrollTime = (GH3D.SPAWN_Z - GH3D.CATCH_Z) / -GH_SPEED; // time for a note to travel from spawn to catch

  // Smooth marker toward mouse
  GH.markerX += (GH.mouseX - GH.markerX) * Math.min(1, dt * 6);
  scene3d.setMarkerX(screenXToWorldX(GH.markerX));

  // Don't spawn any notes until the start delay has passed
  if (GH.gameElapsed < GH_START_DELAY) return;

  // First frame after delay: skip notes so that the first ones appear
  // only ~2 seconds of travel from the catch line, not at the far horizon.
  if (!GH._delayEnded) {
    GH._delayEnded = true;
    const nearHorizon = GH.gameElapsed + 3; // only 2s ahead → notes start close
    while (GH.noteIdx < midiNotes.length) {
      const n = midiNotes[GH.noteIdx];
      const t = n.time - GH.songStartPos + GH.spawnOffset;
      if (t > nearHorizon) break;
      GH.noteIdx++;
    }
  }

  // Spawn notes
  let safety = midiNotes.length + 100;
  while (safety-- > 0) {
    if (GH.noteIdx >= midiNotes.length) {
      GH.noteIdx = 0;
      GH.spawnOffset += songDuration;
    }

    const note = midiNotes[GH.noteIdx];
    const noteGameTime = note.time - GH.songStartPos + GH.spawnOffset;

    if (noteGameTime > GH.gameElapsed + scrollTime + 0.5) break;

    if (noteGameTime >= GH.gameElapsed - 1.5) {
      const mesh = scene3d.createNoteMesh();
      const worldX = noteToWorldX(note.note);
      mesh.position.set(worldX, GH3D.NOTE_Y, GH3D.SPAWN_Z);

      GH.liveNotes.push({
        worldX,
        gameTime: noteGameTime,
        missed: false,
        hit: false,
        note: note.note,
        mesh,
      });
    }

    GH.noteIdx++;
  }

  // Update note positions and check misses/hits
  const startFadeIn = Math.min(1, (GH.gameElapsed - GH_START_DELAY) / 2); // 2s fade-in at game start

  for (const n of GH.liveNotes) {
    const timeDiff = n.gameTime - GH.gameElapsed;
    const z = GH3D.CATCH_Z - timeDiff * GH_SPEED; // timeDiff>0 → z further negative (in front)
    n.mesh.position.z = z;

    // Fade in: 0 at spawn, 1 near catch (multiplied by game-start and game-end fades)
    const zRange = GH3D.SPAWN_Z - GH3D.CATCH_Z;
    const zFrac = (z - GH3D.CATCH_Z) / zRange;   // 0 at catch, 1 at spawn
    const opacity = Math.max(0, Math.min(1, 1 - zFrac)) * startFadeIn * getNoteFadeAlpha();
    scene3d.setNoteOpacity(n.mesh, opacity);

    if (n.missed || n.hit) continue;

    // Check for hit slightly before the line
    if (
      !n.missed &&
      GH.gameElapsed >= n.gameTime - GH.HIT_WINDOW &&
      GH.gameElapsed < n.gameTime
    ) {
      const markerWorldX = screenXToWorldX(GH.markerX);
      const xRange = GH3D.X_MAX - GH3D.X_MIN;
      if (Math.abs(markerWorldX - n.worldX) < GH.HIT_X_TOL * xRange) {
        n.hit = true;
        scene3d.setNoteHit(n.mesh);
      }
    }

    // Miss as soon as the note reaches the catch line
    if (!n.hit && GH.gameElapsed >= n.gameTime) {
      n.missed = true;
      GH.missCount++;
      GH.totalMisses++;
      scene3d.setNoteMissed(n.mesh);
      onMiss();
    }
  }

  // Remove notes past catch line
  for (let i = GH.liveNotes.length - 1; i >= 0; i--) {
    const n = GH.liveNotes[i];
    if (GH.gameElapsed - n.gameTime > 1.5) {
      scene3d.removeNoteMesh(n.mesh);
      GH.liveNotes.splice(i, 1);
    }
  }

  // Update distortion based on misses (skip during fade-out to not fight audio fade)
  if (!GH.fadingOut) {
    const progress = Math.min(1, GH.totalMisses / 200);
    audio.setDistortion(progress);
  }

  // Ego messages
  checkEgoMessages();

  // Per-note distortion pulses (skip during fade-out)
  if (!GH.fadingOut) {
    for (const n of GH.liveNotes) {
      if (
        !n._pulsed &&
        GH.gameElapsed >= n.gameTime - 0.02 &&
        GH.gameElapsed <= n.gameTime + 0.08
      ) {
        n._pulsed = true;
        if (GH.totalMisses > 55) {
          audio.pulseNote();
        }
      }
    }
  }

  // End game when miss threshold reached
  if (GH.totalMisses >= MAX_MISSES && !GH.fadingOut) {
    endGuitarHero();
  }
}

function onMiss() {
  maybeTileDrop();
}

function endGuitarHero() {
  GH.fadingOut = true;
  // GH.active stays TRUE — notes keep flowing, moving, turning red on miss

  // After 3 seconds, fully clean up notes and teardown
  GH._fadeStart = performance.now();
  GH._fadeDuration = 3000; // 3 seconds

  // Start transition immediately (overlaps with note flow)
  transitionToChat();
}

function getNoteFadeAlpha() {
  if (!GH.fadingOut || !GH._fadeStart) return 1;
  const elapsed = performance.now() - GH._fadeStart;
  return Math.max(0, 1 - elapsed / GH._fadeDuration);
}

async function transitionToChat() {
  // Destroy remaining tiles rapidly
  const rapidDestroy = setInterval(() => {
    if (scene3d && scene3d.intactIndices.length > 0) {
      for (let i = 0; i < 5; i++) scene3d.destroyRandomTile();
    } else {
      clearInterval(rapidDestroy);
    }
  }, 50);

  // Longer fade out for dramatic effect
  audio.fadeOutMozart(7);
  setTimeout(() => {
    audio.fadeInHorror(4);
  }, 3000);

  // After note fade completes (3s), clean up notes and show chat
  setTimeout(() => {
    // Clean up all remaining notes
    for (const n of GH.liveNotes) {
      scene3d.removeNoteMesh(n.mesh);
    }
    GH.liveNotes = [];
    GH.active = false;
    GH.ended = true;
    scene3d.teardownGuitarHero();

    state = S.CHAT;
    chatContainer.style.display = 'flex';
    chatInput.disabled = true; // disabled until ego sends first message
    setTimeout(() => {
      chatContainer.classList.add('visible');
      setTimeout(() => startEgoChat(), 4000);
    }, 50);
  }, 3000);
}

/* ─── Main flow ─── */

async function load() {
  const midResp = await fetch(`${import.meta.env.BASE_URL}mz_545_1_format0.mid`);
  const midBuf = await midResp.arrayBuffer();
  const midi = parseMidi(midBuf);
  midiNotes = midi.notes;
  midiDuration = midi.duration;

  await audio.init();

  // Scale MIDI note times to match actual MP3 duration
  const mp3Duration = audio.getMozartDuration();
  const scaleFactor = mp3Duration / midiDuration;
  if (Math.abs(scaleFactor - 1) > 0.005) {
    midiNotes = midiNotes.map((n) => ({
      ...n,
      time: n.time * scaleFactor,
    }));
    midiDuration = mp3Duration;
  }

  continueBtn.disabled = false;
  continueBtn.textContent = 'Continue';
  state = S.INTRO;
}

function startExperience() {
  introOverlay.classList.add('hidden');
  audio.playMozart();
  state = S.HEAVEN;

  showHeavenWord(WORDS[0]);

  // Init 3D scene (hidden behind white heaven)
  scene3d = new Scene3D(threeCanvas);
  scene3d.init();
  scene3d.setBlobPortal(0, 0);
  portalContainer.style.display = 'block';
}

/* ─── Event listeners ─── */

continueBtn.addEventListener('click', () => {
  if (continueBtn.disabled) return;
  startExperience();
});

// Virtual scroll via wheel
window.addEventListener(
  'wheel',
  (e) => {
    if (!scrollEnabled) return;
    e.preventDefault();

    if (state === S.HEAVEN && portalPhase === 0) {
      virtualScroll += Math.abs(e.deltaY) * 0.3;
      if (virtualScroll > 10) {
        portalPhase = 1;
        portalSpring.target = 0.025;
        state = S.PORTAL_APPEAR;
        scrollTooltip.classList.add('hidden');
        audio.playPop();
      }
      return;
    }

    if (state === S.PORTAL_APPEAR) {
      // Allow scroll-back to close
      if (e.deltaY < 0) {
        portalPhase = 4; // closing
        portalSpring.target = 0;
        return;
      }

      // 2nd scroll after initial pop has settled → trigger the full expansion
      if (portalPhase === 3 && e.deltaY > 0) {
        triggerPortalExpansion();
      }
      return;
    }
  },
  { passive: false }
);

// Click / tap on blob to trigger expansion (alternative to 2nd scroll)
threeCanvas.addEventListener('click', () => {
  if (state === S.PORTAL_APPEAR && portalPhase === 3) {
    triggerPortalExpansion();
  }
});
threeCanvas.addEventListener('touchend', (e) => {
  if (state === S.PORTAL_APPEAR && portalPhase === 3) {
    e.preventDefault();
    triggerPortalExpansion();
  }
});

// Helper: triggers portal expansion from either scroll or click/tap
function triggerPortalExpansion() {
  state = S.PORTAL_TRANSITION;
  scrollEnabled = false;
  portalContainer.style.pointerEvents = 'none'; // disable clicks once expanding
  portalContainer.style.cursor = 'default';
  expandPhase = 1;
  expandSpring.value = portalSpring.value; // start from current size (~0.10)
  expandSpring.target = 0.60;              // spring to 50%
  expandSpring.velocity = 0;
}

// Mouse tracking for guitar hero
window.addEventListener('mousemove', (e) => {
  GH.mouseX = e.clientX / window.innerWidth;
});

/* ─── Animation loop ─── */
let lastTime = 0;

function animate(time) {
  requestAnimationFrame(animate);

  const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0.016;
  lastTime = time;
  globalTime += dt;

  switch (state) {
    case S.HEAVEN:
      updateHeavenWords(dt);
      tooltipTimer += dt;
      if (tooltipTimer > 5 && !tooltipShown) {
        tooltipShown = true;
        scrollEnabled = true;
        scrollTooltip.classList.add('visible');
      }
      if (scene3d) scene3d.render(dt);
      break;

    case S.PORTAL_APPEAR: {
      updateHeavenWords(dt);
      portalSpring.update(dt);

      if (portalPhase === 4) {
        // Closing
        scene3d.setBlobPortal(Math.max(0, portalSpring.value), globalTime);
        if (portalSpring.isSettled() && portalSpring.value < 0.005) {
          portalPhase = 0;
          portalSpring.value = 0;
          portalSpring.velocity = 0;
          virtualScroll = 0;
          state = S.HEAVEN;
          scrollEnabled = true;
        }
      } else {
        scene3d.setBlobPortal(portalSpring.value, globalTime);
        if (portalPhase === 1 && portalSpring.isSettled()) {
          portalPhase = 2;
          portalSpring.target = 0.10;
        }
        if (portalPhase === 2 && portalSpring.isSettled()) {
          portalPhase = 3;
          // Stay in PORTAL_APPEAR – awaiting 2nd scroll or click/tap to trigger expansion
          portalContainer.style.pointerEvents = 'auto';
          portalContainer.style.cursor = 'pointer';
        }
      }
      scene3d.render(dt);
      break;
    }

    case S.PORTAL_TRANSITION: {
      // Phase 1: spring to 50%
      if (expandPhase === 1) {
        expandSpring.update(dt);
        const radius = Math.max(0, expandSpring.value);
        scene3d.setBlobPortal(radius, globalTime);


        // FOV narrows as we approach 50%
        scene3d.setFOV(65 - (radius / 0.60) * 10);

        if (expandSpring.isSettled()) {
          expandPhase = 2;
          expandWaitTimer = 0;
          // Show "What if" at 50%
          startWhatIfPhase1();
        }
      }

      // Phase 2: wait 1 second at 50%, then start typing the rest of the phrase
      if (expandPhase === 2) {
        expandWaitTimer += dt;
        // Keep rendering at current size
        scene3d.setBlobPortal(0.60, globalTime);
        if (expandWaitTimer >= 2.5) {
          expandPhase = 0; // no more expansion phases for now
          // Start typing phase 2 while amoeba stays at 50%
          startWhatIfPhase2();
          state = S.WHAT_IF;
        }
      }

      // Phase 3: slow expand from 50% to 100% (triggered by startWhatIfPhase2 after text fades)
      if (expandPhase === 3) {
        expandSlowProgress += dt * 0.6; // slower expansion
        const t = Math.min(1, expandSlowProgress);
        const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
        const radius = 0.60 + (1 - 0.40) * eased;
        scene3d.setBlobPortal(radius, globalTime);

        // FOV continues narrowing
        scene3d.setFOV(55 - t * 5);

        if (t >= 1) {
          expandPhase = 0;
          scene3d.setBlobPortal(1, globalTime);
          startGuitarHero();
        }
      }

      if (scene3d) scene3d.render(dt);
      break;
    }

    case S.WHAT_IF: {
      // Phase 3 expansion can be triggered here after text fades
      let currentRadius = 0.60; // default: hold at 60%
      if (expandPhase === 3) {
        expandSlowProgress += dt * 0.6;
        const t = Math.min(1, expandSlowProgress);
        const eased = 1 - Math.pow(1 - t, 3);
        currentRadius = 0.60 + (1 - 0.60) * eased;
        scene3d.setFOV(55 - t * 5);

        if (t >= 1) {
          expandPhase = 0;
          scene3d.setBlobPortal(1, globalTime);
          startGuitarHero();
          break;
        }
      }
      // Always update blob with globalTime so wobble animation stays alive
      scene3d.setBlobPortal(currentRadius, globalTime);
      if (scene3d) scene3d.render(dt);
      break;
    }

    case S.GUITAR_HERO:
      updateGuitarHero(dt);
      if (scene3d) scene3d.render(dt);
      break;

    case S.CHAT:
      if (scene3d) scene3d.render(dt);
      break;
  }
}

/* ─── Init ─── */
load().catch((err) => {
  console.error('Failed to load:', err);
  continueBtn.textContent = 'Error loading';
});

requestAnimationFrame(animate);
