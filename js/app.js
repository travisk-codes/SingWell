/**
 * SingWell — main application controller.
 *
 * Manages the five screens (setup, exercise list, active exercise,
 * results, profile), coordinates audio capture with pitch detection,
 * drives the exercise timer, and updates the UI on every animation frame.
 */

import {
  detectPitch,
  frequencyToMidiNote,
  midiNoteToName,
  midiNoteToFrequency,
  midiNoteToSolfege,
} from './pitch-detector.js';
import { AudioEngine } from './audio-engine.js';
import {
  WARMUP_EXERCISES,
  VOICE_TYPE_BASE_NOTES,
} from './exercises.js';
import { PitchVisualizer } from './visualizer.js';
import { analyzePerformance } from './feedback.js';
import {
  saveExerciseResult,
  renderPerformanceGraph,
  renderPerformanceLegend,
  renderHistoryList,
  renderRunningAverages,
  renderStreakInfo,
} from './profile.js';
import {
  analyzeFormants,
  checkVowelForSolfege,
  getExpectedVowel,
  resetFormantSmoothing,
} from './formant-analyzer.js';

// ── Application state ────────────────────────────────────────────────

let audioEngine = null;
let pitchVisualizer = null;
let selectedVoiceType = null;
let selectedBaseMidiNote = null;

let activeExerciseDefinition = null;
let activeExerciseSteps = null;
let exerciseStartTimestamp = null;
let isExerciseRunning = false;
let animationFrameId = null;
let previousStepIndex = -1;
let collectedPitchSamples = [];
let profileReturnScreen = null;
let currentTimescale = 'all';
let currentTempoMultiplier = 1.0;
let keyRepeatTotal = 1;
let keyRepeatCurrent = 0;
let keyRepeatTranspose = 0;
let allRoundsResults = [];
let guidedSessionQueue = [];
let guidedSessionIndex = -1;
let isGuidedSession = false;
let formantTrail = [];

// Minimum and maximum detectable singing frequencies (Hz).
// Below ~70 Hz is subharmonic rumble; above ~1100 Hz is past
// most singing voices and likely harmonic artefacts.
const MINIMUM_SINGING_FREQUENCY_HZ = 70;
const MAXIMUM_SINGING_FREQUENCY_HZ = 1100;
const MINIMUM_PITCH_CONFIDENCE = 0.85;

// ── DOM references ───────────────────────────────────────────────────

const setupScreen = document.getElementById('setup-screen');
const exerciseListScreen = document.getElementById('exercise-list-screen');
const activeExerciseScreen = document.getElementById('active-exercise-screen');
const resultsScreen = document.getElementById('results-screen');
const profileScreen = document.getElementById('profile-screen');

const allScreens = [
  setupScreen,
  exerciseListScreen,
  activeExerciseScreen,
  resultsScreen,
  profileScreen,
];

// ── Screen management ────────────────────────────────────────────────

function showScreen(screen) {
  for (const s of allScreens) {
    s.classList.add('hidden');
  }
  screen.classList.remove('hidden');
}

// ── Setup screen ─────────────────────────────────────────────────────

const voiceTypeButtons = document.querySelectorAll('.voice-type-btn');
const startButton = document.getElementById('start-btn');

voiceTypeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedVoiceType = button.dataset.voiceType;
    selectedBaseMidiNote = VOICE_TYPE_BASE_NOTES[selectedVoiceType];

    voiceTypeButtons.forEach((b) =>
      b.classList.toggle('selected', b === button)
    );

    startButton.disabled = false;
  });
});

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  startButton.textContent = 'Requesting microphone...';

  try {
    if (!audioEngine) {
      audioEngine = new AudioEngine();
      await audioEngine.initialize();
    }
    populateExerciseList();
    showScreen(exerciseListScreen);
  } catch (error) {
    alert(
      'Microphone access is required for this app to work.\n\n' +
        'Please allow microphone access in your browser and try again.\n\n' +
        'Error: ' +
        error.message
    );
  } finally {
    startButton.disabled = false;
    startButton.textContent = 'Start Warming Up';
  }
});

// Back to setup from exercise list
document.getElementById('back-to-setup-btn').addEventListener('click', () => {
  showScreen(setupScreen);
});

// ── Header brand — click to return to exercise selection ─────────────

document.querySelector('.header-brand').addEventListener('click', () => {
  if (isExerciseRunning) {
    isExerciseRunning = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
  }
  if (audioEngine) {
    showScreen(exerciseListScreen);
  } else {
    showScreen(setupScreen);
  }
});

// ── Exercise list screen ─────────────────────────────────────────────

function populateExerciseList() {
  const container = document.getElementById('exercise-cards');
  container.innerHTML = '';

  for (const exercise of WARMUP_EXERCISES) {
    const card = document.createElement('button');
    card.className = 'exercise-card';
    card.innerHTML = `
      <h3>${exercise.name}</h3>
      <p>${exercise.description}</p>
    `;
    card.addEventListener('click', () => launchExercise(exercise));
    container.appendChild(card);
  }
}

// ── Guided warmup session ────────────────────────────────────────

const GUIDED_WARMUP_IDS = [
  'sustained-tone',
  'five-tone-scale',
  'major-arpeggio',
  'octave-siren',
];

document.getElementById('guided-warmup-btn').addEventListener('click', () => {
  guidedSessionQueue = GUIDED_WARMUP_IDS.map(
    (id) => WARMUP_EXERCISES.find((e) => e.id === id)
  ).filter(Boolean);
  guidedSessionIndex = 0;
  isGuidedSession = true;
  updateSessionProgress();
  launchExercise(guidedSessionQueue[0], 0, 0);
});

function updateSessionProgress() {
  const el = document.getElementById('session-progress');
  if (!isGuidedSession || guidedSessionQueue.length === 0) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = guidedSessionQueue.map((ex, i) => {
    let cls = 'session-step';
    if (i < guidedSessionIndex) cls += ' session-done';
    if (i === guidedSessionIndex) cls += ' session-current';
    return `<span class="${cls}">${ex.name}</span>`;
  }).join('<span class="session-arrow">→</span>');
}

// ── Tempo control ────────────────────────────────────────────────

document.querySelectorAll('.tempo-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentTempoMultiplier = parseFloat(btn.dataset.tempo);
    document.querySelectorAll('.tempo-btn').forEach((b) =>
      b.classList.toggle('active', b === btn)
    );
  });
});

// ── Key repeat control ───────────────────────────────────────────

document.querySelectorAll('.key-repeat-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    keyRepeatTotal = parseInt(btn.dataset.keys, 10);
    document.querySelectorAll('.key-repeat-btn').forEach((b) =>
      b.classList.toggle('active', b === btn)
    );
  });
});

// ── Active exercise screen ───────────────────────────────────────────

function launchExercise(exerciseDefinition, roundIndex = 0, transpose = 0) {
  activeExerciseDefinition = exerciseDefinition;
  keyRepeatCurrent = roundIndex;
  keyRepeatTranspose = transpose;
  if (roundIndex === 0) allRoundsResults = [];

  activeExerciseSteps = exerciseDefinition.createSteps(selectedBaseMidiNote + transpose);

  // Apply tempo multiplier (lower multiplier = slower = longer durations)
  if (currentTempoMultiplier !== 1.0) {
    activeExerciseSteps = activeExerciseSteps.map((step) => ({
      ...step,
      durationMs: Math.round(step.durationMs / currentTempoMultiplier),
    }));
  }

  collectedPitchSamples = [];
  formantTrail = [];
  previousStepIndex = -1;

  // Show the screen first so the canvas has layout dimensions
  showScreen(activeExerciseScreen);

  // Set up the canvas at its actual displayed size
  const canvas = document.getElementById('pitch-canvas');
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  pitchVisualizer = new PitchVisualizer(canvas);
  pitchVisualizer.configureForExercise(activeExerciseSteps);

  // Update header
  document.getElementById('exercise-title').textContent =
    exerciseDefinition.name;
  document.getElementById('exercise-description-active').textContent =
    exerciseDefinition.description;

  // Reset live display
  document.getElementById('target-note').textContent = '—';
  document.getElementById('detected-note').textContent = '—';
  document.getElementById('target-solfege').textContent = '';
  document.getElementById('detected-solfege').textContent = '';
  document.getElementById('cents-display').textContent = '';
  document.getElementById('accuracy-indicator').textContent = 'Get ready...';
  document.getElementById('accuracy-indicator').className = 'accuracy-indicator';
  document.getElementById('exercise-progress').style.width = '0%';
  document.getElementById('vowel-indicator').textContent = '';
  document.getElementById('vowel-indicator').className = 'vowel-indicator';

  // Show round indicator when doing multiple keys
  const roundIndicator = document.getElementById('round-indicator');
  if (keyRepeatTotal > 1) {
    roundIndicator.textContent = `Key ${keyRepeatCurrent + 1} of ${keyRepeatTotal} (+${keyRepeatTranspose} semitones)`;
    roundIndicator.classList.remove('hidden');
  } else {
    roundIndicator.classList.add('hidden');
  }

  resetFormantSmoothing();
  runCountIn();
}

function runCountIn() {
  const countdownOverlay = document.getElementById('countdown');
  countdownOverlay.classList.remove('hidden');

  // Play the first target note as a reference tone during the countdown
  // so the user can hear the pitch they need to match
  const firstStep = activeExerciseSteps[0];
  audioEngine.playReferenceTone(firstStep.targetFrequency, 3.5, 0.10);

  let beatsRemaining = 3;
  countdownOverlay.textContent = beatsRemaining;
  audioEngine.playCountInClick();

  // Preview loop: render the pitch graph and show the user's current pitch
  // so they can find the right note before the exercise starts
  let previewFrameId = null;
  function previewLoop() {
    pitchVisualizer.render();

    const timeDomainData = audioEngine.getTimeDomainData();
    const pitchResult = detectPitch(timeDomainData, audioEngine.getSampleRate());
    if (
      pitchResult &&
      pitchResult.confidence >= MINIMUM_PITCH_CONFIDENCE &&
      pitchResult.frequency >= MINIMUM_SINGING_FREQUENCY_HZ &&
      pitchResult.frequency <= MAXIMUM_SINGING_FREQUENCY_HZ
    ) {
      const midiNote = frequencyToMidiNote(pitchResult.frequency);
      drawPitchPreviewLine(midiNote);
      document.getElementById('detected-note').textContent =
        midiNoteToName(Math.round(midiNote));
      document.getElementById('detected-solfege').textContent =
        midiNoteToSolfege(midiNote, selectedBaseMidiNote);

      // Live formant chart during countdown so user can prep vowel
      const formantResult = analyzeFormants(timeDomainData, audioEngine.getSampleRate());
      drawFormantChart(
        formantResult ? formantResult.f1 : null,
        formantResult ? formantResult.f2 : null
      );
    }

    previewFrameId = requestAnimationFrame(previewLoop);
  }
  previewFrameId = requestAnimationFrame(previewLoop);

  const countdownInterval = setInterval(() => {
    beatsRemaining--;
    if (beatsRemaining > 0) {
      countdownOverlay.textContent = beatsRemaining;
      audioEngine.playCountInClick();
    } else {
      countdownOverlay.classList.add('hidden');
      clearInterval(countdownInterval);
      if (previewFrameId) cancelAnimationFrame(previewFrameId);
      beginExerciseLoop();
    }
  }, 1000);
}

function drawPitchPreviewLine(midiNote) {
  const canvas = document.getElementById('pitch-canvas');
  const ctx = canvas.getContext('2d');
  const y = pitchVisualizer.midiNoteToYPosition(midiNote);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(canvas.width, y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(midiNoteToName(Math.round(midiNote)), 6, y - 6);
}

// ── Formant chart rendering ──────────────────────────────────────────

const VOWEL_CHART_CENTERS = [
  { label: 'ee', f1: 310, f2: 2300 },
  { label: 'eh', f1: 600, f2: 1800 },
  { label: 'ah', f1: 750, f2: 1200 },
  { label: 'oh', f1: 500, f2: 900 },
];

const FORMANT_F1_MIN = 200, FORMANT_F1_MAX = 900;
const FORMANT_F2_MIN = 700, FORMANT_F2_MAX = 2600;
const VOWEL_CIRCLE_RADIUS = 14;

function formantToXY(f1, f2, w, h) {
  const x = (1 - (f2 - FORMANT_F2_MIN) / (FORMANT_F2_MAX - FORMANT_F2_MIN)) * (w - 20) + 10;
  const y = ((f1 - FORMANT_F1_MIN) / (FORMANT_F1_MAX - FORMANT_F1_MIN)) * (h - 20) + 10;
  return { x, y };
}

/**
 * Compute how close a formant point is to its expected vowel center.
 * Returns 'green' if inside the circle, 'yellow' if close, 'red' if far.
 */
function formantAccuracyColor(f1, f2, expectedVowel) {
  if (!expectedVowel) return 'rgba(255, 255, 255, 0.4)';
  const center = VOWEL_CHART_CENTERS.find((v) => v.label === expectedVowel);
  if (!center) return 'rgba(255, 255, 255, 0.4)';

  // Normalized distance (same scaling as classifyVowel)
  const d1 = (f1 - center.f1) / 300;
  const d2 = (f2 - center.f2) / 800;
  const dist = Math.sqrt(d1 * d1 + d2 * d2);

  if (dist < 0.5) return '#4ade80';   // green — inside circle
  if (dist < 1.0) return '#facc15';   // yellow — close
  return '#f87171';                     // red — far
}

/**
 * Render the formant chart on a given canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {number|null} liveF1 - current detected F1 (null for static chart)
 * @param {number|null} liveF2 - current detected F2
 * @param {Array} trail - collected formant trail samples
 */
function renderFormantChart(canvas, liveF1, liveF2, trail) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, w, h);

  // Draw vowel target circles
  ctx.font = '11px monospace';
  for (const v of VOWEL_CHART_CENTERS) {
    const { x, y } = formantToXY(v.f1, v.f2, w, h);

    ctx.fillStyle = 'rgba(212, 175, 55, 0.2)';
    ctx.beginPath();
    ctx.arc(x, y, VOWEL_CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(212, 175, 55, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, VOWEL_CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#d4af37';
    ctx.textAlign = 'center';
    ctx.fillText(v.label, x, y + 4);
  }

  // Draw trail path with accuracy coloring
  if (trail && trail.length > 1) {
    ctx.lineWidth = 2;
    for (let i = 1; i < trail.length; i++) {
      const prev = formantToXY(trail[i - 1].f1, trail[i - 1].f2, w, h);
      const curr = formantToXY(trail[i].f1, trail[i].f2, w, h);

      ctx.strokeStyle = formantAccuracyColor(
        trail[i].f1, trail[i].f2, trail[i].expectedVowel
      );
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(curr.x, curr.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
  }

  // Draw live detected position
  if (liveF1 && liveF2) {
    const { x, y } = formantToXY(liveF1, liveF2, w, h);

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Live formant chart shorthand (used during exercise and countdown). */
function drawFormantChart(f1, f2, trail) {
  renderFormantChart(
    document.getElementById('formant-canvas'),
    f1, f2, trail || []
  );
}

function flashBeatIndicator() {
  const indicator = document.getElementById('beat-indicator');
  indicator.classList.remove('beat-flash');
  // Force reflow to restart animation
  void indicator.offsetWidth;
  indicator.classList.add('beat-flash');
}

function beginExerciseLoop() {
  exerciseStartTimestamp = performance.now();
  isExerciseRunning = true;
  exerciseLoop();
}

function exerciseLoop() {
  if (!isExerciseRunning) return;

  const elapsedMs = performance.now() - exerciseStartTimestamp;
  const totalDurationMs = activeExerciseSteps.reduce(
    (sum, s) => sum + s.durationMs,
    0
  );

  // Exercise complete?
  if (elapsedMs >= totalDurationMs) {
    finishExercise();
    return;
  }

  // ── Pitch detection ──────────────────────────────────────────
  const timeDomainData = audioEngine.getTimeDomainData();
  const pitchResult = detectPitch(timeDomainData, audioEngine.getSampleRate());

  let detectedMidiNote = null;
  if (
    pitchResult &&
    pitchResult.confidence >= MINIMUM_PITCH_CONFIDENCE &&
    pitchResult.frequency >= MINIMUM_SINGING_FREQUENCY_HZ &&
    pitchResult.frequency <= MAXIMUM_SINGING_FREQUENCY_HZ
  ) {
    detectedMidiNote = frequencyToMidiNote(pitchResult.frequency);
  }

  // ── Find the current exercise step ───────────────────────────
  let accumulatedTimeMs = 0;
  let currentStepIndex = 0;
  let currentStep = activeExerciseSteps[0];

  for (let i = 0; i < activeExerciseSteps.length; i++) {
    if (
      elapsedMs >= accumulatedTimeMs &&
      elapsedMs < accumulatedTimeMs + activeExerciseSteps[i].durationMs
    ) {
      currentStep = activeExerciseSteps[i];
      currentStepIndex = i;
      break;
    }
    accumulatedTimeMs += activeExerciseSteps[i].durationMs;
  }

  // Play a reference tone when we transition to a new step
  // (skip for continuous exercises — the slide is the point).
  // Reset formant smoothing so vowel detection starts fresh.
  // Flash the beat indicator on each transition.
  if (
    currentStepIndex !== previousStepIndex &&
    !activeExerciseDefinition.isContinuous
  ) {
    audioEngine.playReferenceTone(currentStep.targetFrequency, 0.5, 0.08);
    resetFormantSmoothing();
    flashBeatIndicator();
    previousStepIndex = currentStepIndex;
  } else if (activeExerciseDefinition.isContinuous) {
    previousStepIndex = currentStepIndex;
  }

  // ── Formant / vowel detection ─────────────────────────────────
  let formantResult = null;
  if (detectedMidiNote !== null) {
    formantResult = analyzeFormants(
      timeDomainData,
      audioEngine.getSampleRate()
    );
  }

  // ── Check vowel against expected solfege ──────────────────────
  let vowelCheck = null;
  const stepExpectedVowel = currentStep.expectedVowel ||
    (currentStep.solfegeLabel ? getExpectedVowel(currentStep.solfegeLabel) : null);
  if (formantResult && stepExpectedVowel && !activeExerciseDefinition.isContinuous) {
    vowelCheck = {
      matches: formantResult.vowel === stepExpectedVowel,
      expectedVowel: stepExpectedVowel,
      possibleSyllables: [],
    };
  }

  // ── Record sample ────────────────────────────────────────────
  const rmsVolume = audioEngine.computeRmsVolume();

  if (detectedMidiNote !== null) {
    collectedPitchSamples.push({
      timeMs: elapsedMs,
      midiNote: detectedMidiNote,
      rmsVolume,
      detectedVowel: formantResult ? formantResult.vowel : null,
      vowelMatches: vowelCheck ? vowelCheck.matches : null,
    });
  }

  // ── Update visualization ─────────────────────────────────────
  pitchVisualizer.recordPitchSample(elapsedMs, detectedMidiNote);
  pitchVisualizer.render();

  // Update formant chart with trail (always draw so circles are visible)
  if (formantResult) {
    formantTrail.push({
      f1: formantResult.f1,
      f2: formantResult.f2,
      expectedVowel: stepExpectedVowel,
    });
  }
  drawFormantChart(
    formantResult ? formantResult.f1 : null,
    formantResult ? formantResult.f2 : null,
    formantTrail
  );

  // ── Update live readout ──────────────────────────────────────
  updateLiveDisplay(
    currentStep, detectedMidiNote, rmsVolume,
    elapsedMs, totalDurationMs, formantResult, vowelCheck
  );

  animationFrameId = requestAnimationFrame(exerciseLoop);
}

function updateLiveDisplay(
  currentStep,
  detectedMidiNote,
  rmsVolume,
  elapsedMs,
  totalDurationMs,
  formantResult,
  vowelCheck
) {
  const targetNoteElement = document.getElementById('target-note');
  const detectedNoteElement = document.getElementById('detected-note');
  const targetSolfegeElement = document.getElementById('target-solfege');
  const detectedSolfegeElement = document.getElementById('detected-solfege');
  const centsDisplayElement = document.getElementById('cents-display');
  const accuracyIndicatorElement = document.getElementById('accuracy-indicator');
  const progressBarElement = document.getElementById('exercise-progress');
  const volumeMeterElement = document.getElementById('volume-meter');
  const vowelIndicatorElement = document.getElementById('vowel-indicator');

  // Target note
  targetNoteElement.textContent = midiNoteToName(
    Math.round(currentStep.targetMidiNote)
  );

  // Target solfege (show expected vowel when explicitly set)
  if (currentStep.expectedVowel) {
    targetSolfegeElement.textContent =
      `${currentStep.solfegeLabel || ''} [${currentStep.expectedVowel}]`;
  } else {
    targetSolfegeElement.textContent = currentStep.solfegeLabel || '';
  }

  // Detected note and accuracy
  if (detectedMidiNote !== null) {
    detectedNoteElement.textContent = midiNoteToName(
      Math.round(detectedMidiNote)
    );

    // Detected solfege (relative to the exercise tonic)
    detectedSolfegeElement.textContent = midiNoteToSolfege(
      detectedMidiNote,
      selectedBaseMidiNote
    );

    const centsOff = (detectedMidiNote - currentStep.targetMidiNote) * 100;
    const absoluteCents = Math.abs(centsOff);
    const sharpOrFlat = centsOff > 0 ? '\u266F' : centsOff < 0 ? '\u266D' : '';
    centsDisplayElement.textContent = `${sharpOrFlat} ${Math.round(absoluteCents)}\u00A2`;

    if (absoluteCents < 15) {
      accuracyIndicatorElement.className =
        'accuracy-indicator accuracy-excellent';
      accuracyIndicatorElement.textContent = 'On Pitch';
    } else if (absoluteCents < 30) {
      accuracyIndicatorElement.className = 'accuracy-indicator accuracy-good';
      accuracyIndicatorElement.textContent = 'Close';
    } else if (absoluteCents < 50) {
      accuracyIndicatorElement.className = 'accuracy-indicator accuracy-fair';
      accuracyIndicatorElement.textContent = centsOff > 0 ? 'Sharp' : 'Flat';
    } else {
      accuracyIndicatorElement.className = 'accuracy-indicator accuracy-off';
      accuracyIndicatorElement.textContent =
        centsOff > 0 ? 'Too Sharp' : 'Too Flat';
    }
  } else {
    detectedNoteElement.textContent = '\u2014';
    detectedSolfegeElement.textContent = '';
    centsDisplayElement.textContent = '';
    accuracyIndicatorElement.className = 'accuracy-indicator';
    accuracyIndicatorElement.textContent = 'Listening...';
  }

  // Vowel indicator (skip for continuous exercises)
  if (formantResult && vowelCheck) {
    if (vowelCheck.matches) {
      vowelIndicatorElement.textContent = `vowel: ${formantResult.vowel}`;
      vowelIndicatorElement.className = 'vowel-indicator vowel-match';
    } else {
      vowelIndicatorElement.textContent =
        `vowel: ${formantResult.vowel} \u2192 ${vowelCheck.expectedVowel}`;
      vowelIndicatorElement.className = 'vowel-indicator vowel-mismatch';
    }
  } else if (formantResult && activeExerciseDefinition.isContinuous) {
    // For continuous exercises, just show the detected vowel without judgement
    vowelIndicatorElement.textContent = `vowel: ${formantResult.vowel}`;
    vowelIndicatorElement.className = 'vowel-indicator';
  } else {
    vowelIndicatorElement.textContent = '';
    vowelIndicatorElement.className = 'vowel-indicator';
  }

  // Progress bar
  const progressPercent = Math.min((elapsedMs / totalDurationMs) * 100, 100);
  progressBarElement.style.width = `${progressPercent}%`;

  // Volume meter (scale RMS to a usable visual range)
  const normalizedVolume = Math.min(rmsVolume * 5, 1);
  volumeMeterElement.style.width = `${normalizedVolume * 100}%`;
}

// ── Stop / finish ────────────────────────────────────────────────────

document.getElementById('stop-exercise-btn').addEventListener('click', () => {
  isExerciseRunning = false;
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  showScreen(exerciseListScreen);
});

// Preview melody button — plays the full exercise melody
document.getElementById('preview-melody-btn').addEventListener('click', () => {
  if (!activeExerciseSteps) return;

  // Deduplicate consecutive same-note steps for continuous exercises
  const notes = [];
  let lastFreq = null;
  for (const step of activeExerciseSteps) {
    const freq = Math.round(step.targetFrequency);
    if (freq !== lastFreq) {
      notes.push({ frequency: step.targetFrequency, durationMs: step.durationMs });
      lastFreq = freq;
    }
  }
  audioEngine.playMelodyPreview(notes);
});

// Reference tone button during exercise
document.getElementById('play-reference-btn').addEventListener('click', () => {
  if (!isExerciseRunning || !activeExerciseSteps) return;

  // Find the current step and play its reference
  const elapsedMs = performance.now() - exerciseStartTimestamp;
  let accumulatedMs = 0;
  for (const step of activeExerciseSteps) {
    if (elapsedMs >= accumulatedMs && elapsedMs < accumulatedMs + step.durationMs) {
      audioEngine.playReferenceTone(step.targetFrequency, 1.0, 0.15);
      break;
    }
    accumulatedMs += step.durationMs;
  }
});

function finishExercise() {
  isExerciseRunning = false;
  if (animationFrameId) cancelAnimationFrame(animationFrameId);

  // Do a final render with the playhead at the end so the graph is complete
  pitchVisualizer.updatePlayheadPosition(pitchVisualizer.totalDurationMs);
  pitchVisualizer.render();

  // Capture the completed pitch graph as an image
  const canvas = document.getElementById('pitch-canvas');
  const pitchGraphDataUrl = canvas.toDataURL('image/png');

  const feedback = analyzePerformance(
    collectedPitchSamples,
    activeExerciseSteps,
    activeExerciseDefinition.isContinuous
  );

  allRoundsResults.push(feedback);

  // If there are more keys to do, advance to the next round
  const nextRound = keyRepeatCurrent + 1;
  if (nextRound < keyRepeatTotal && !activeExerciseDefinition.isContinuous) {
    launchExercise(activeExerciseDefinition, nextRound, keyRepeatTranspose + 1);
    return;
  }

  // Compute average score across all rounds
  const avgScore = allRoundsResults.reduce(
    (sum, r) => sum + r.overallOnPitchPercent, 0
  ) / allRoundsResults.length;

  // Save to practice history
  saveExerciseResult({
    exerciseId: activeExerciseDefinition.id,
    exerciseName: activeExerciseDefinition.name,
    voiceType: selectedVoiceType,
    score: avgScore,
    rating: feedback.rating,
  });

  displayResults(feedback, pitchGraphDataUrl);
  showScreen(resultsScreen);
}

// ── Vowel accuracy helpers ───────────────────────────────────────────

function computeVowelStatsPerStep(samples, steps) {
  const stats = [];
  let timeOffset = 0;

  for (const step of steps) {
    const stepEnd = timeOffset + step.durationMs;
    const stepSamples = samples.filter(
      (s) => s.timeMs >= timeOffset && s.timeMs < stepEnd && s.detectedVowel
    );

    if (stepSamples.length > 0) {
      const matches = stepSamples.filter((s) => s.vowelMatches).length;

      // Find the most common detected vowel
      const counts = {};
      for (const s of stepSamples) {
        counts[s.detectedVowel] = (counts[s.detectedVowel] || 0) + 1;
      }
      let dominantVowel = null;
      let maxCount = 0;
      for (const [vowel, count] of Object.entries(counts)) {
        if (count > maxCount) {
          maxCount = count;
          dominantVowel = vowel;
        }
      }

      stats.push({
        dominantVowel,
        matchPercent: Math.round((matches / stepSamples.length) * 100),
        hasData: true,
      });
    } else {
      stats.push({ dominantVowel: null, matchPercent: 0, hasData: false });
    }

    timeOffset = stepEnd;
  }

  return stats;
}

// ── Results screen ───────────────────────────────────────────────────

function displayResults(feedback, pitchGraphDataUrl) {
  document.getElementById('results-exercise-name').textContent =
    activeExerciseDefinition.name;

  // Overall score
  const scoreElement = document.getElementById('overall-score');
  scoreElement.textContent = `${Math.round(feedback.overallOnPitchPercent)}%`;
  scoreElement.className = `overall-score rating-${feedback.rating}`;

  // Rating label
  const ratingLabels = {
    excellent: 'Solid',
    good: 'Decent',
    fair: 'Needs Work',
    needs_work: 'Keep Practicing',
    insufficient_data: 'No Data',
  };
  document.getElementById('rating-label').textContent =
    ratingLabels[feedback.rating] || '';

  // Overall vowel accuracy (for non-continuous exercises)
  const vowelScoreElement = document.getElementById('vowel-score');
  if (!activeExerciseDefinition.isContinuous) {
    const vowelSamples = collectedPitchSamples.filter(
      (s) => s.detectedVowel !== null && s.vowelMatches !== null
    );
    if (vowelSamples.length > 0) {
      const vowelMatches = vowelSamples.filter((s) => s.vowelMatches).length;
      const vowelPct = Math.round((vowelMatches / vowelSamples.length) * 100);
      vowelScoreElement.textContent = `${vowelPct}% vowel accuracy`;
      vowelScoreElement.classList.remove('hidden');
    } else {
      vowelScoreElement.classList.add('hidden');
    }
  } else {
    vowelScoreElement.classList.add('hidden');
  }

  // Volume shape score (Messa di Voce)
  const volShapeElement = document.getElementById('volume-shape-score');
  if (feedback.volumeShapeScore !== null && feedback.volumeShapeScore !== undefined) {
    volShapeElement.textContent = `${feedback.volumeShapeScore}% dynamic control`;
    volShapeElement.classList.remove('hidden');
  } else {
    volShapeElement.classList.add('hidden');
  }

  // Pitch graph snapshot
  const graphSection = document.getElementById('results-graph-section');
  const pitchGraphImg = document.getElementById('results-pitch-graph');
  if (pitchGraphDataUrl) {
    pitchGraphImg.src = pitchGraphDataUrl;
    graphSection.classList.remove('hidden');
  } else {
    graphSection.classList.add('hidden');
  }

  // Formant trail chart on results page
  const formantSection = document.getElementById('results-formant-section');
  if (formantTrail.length > 5) {
    formantSection.classList.remove('hidden');
    const formantCanvas = document.getElementById('results-formant-canvas');
    // Set actual pixel dimensions to match displayed size
    formantCanvas.width = formantCanvas.offsetWidth || 320;
    formantCanvas.height = Math.round((formantCanvas.width / 320) * 260);
    renderFormantChart(formantCanvas, null, null, formantTrail);
  } else {
    formantSection.classList.add('hidden');
  }

  // Feedback text
  document.getElementById('feedback-text').textContent = feedback.feedbackText;

  // Per-note breakdown (skip for continuous exercises)
  const breakdownContainer = document.getElementById('note-breakdown');
  const breakdownSection = document.getElementById('note-breakdown-section');
  breakdownContainer.innerHTML = '';

  if (feedback.isContinuousExercise) {
    breakdownSection.classList.add('hidden');
  } else {
    breakdownSection.classList.remove('hidden');

    // Compute per-step vowel stats
    const vowelStats = computeVowelStatsPerStep(
      collectedPitchSamples,
      activeExerciseSteps
    );

    for (let i = 0; i < feedback.perStepResults.length; i++) {
      const stepResult = feedback.perStepResults[i];
      const solfegeLabel = activeExerciseSteps[i]
        ? activeExerciseSteps[i].solfegeLabel || ''
        : '';
      const expectedVowel = (activeExerciseSteps[i] && activeExerciseSteps[i].expectedVowel)
        || (solfegeLabel ? getExpectedVowel(solfegeLabel) : null);
      const vs = vowelStats[i];

      const group = document.createElement('div');
      group.className = 'note-group';

      const accuracyText = stepResult.wasDetected
        ? `${Math.round(stepResult.onPitchPercent)}%`
        : 'No data';

      const centsText =
        stepResult.wasDetected && stepResult.averageCentsOff !== 0
          ? `${stepResult.averageCentsOff > 0 ? '+' : ''}${Math.round(
              stepResult.averageCentsOff
            )}\u00A2`
          : '';

      let barColorClass = 'bar-off';
      if (stepResult.onPitchPercent >= 80) barColorClass = 'bar-excellent';
      else if (stepResult.onPitchPercent >= 60) barColorClass = 'bar-good';
      else if (stepResult.onPitchPercent >= 40) barColorClass = 'bar-fair';

      // Pitch row
      const row = document.createElement('div');
      row.className = 'note-result';
      row.innerHTML = `
        <span class="note-label">${stepResult.noteName}</span>
        <span class="note-solfege">${solfegeLabel}</span>
        <div class="accuracy-bar">
          <div class="accuracy-fill ${barColorClass}"
               style="width: ${stepResult.wasDetected ? stepResult.onPitchPercent : 0}%">
          </div>
        </div>
        <span class="note-accuracy">${accuracyText}</span>
        <span class="note-cents">${centsText}</span>
      `;
      group.appendChild(row);

      // Vowel accuracy bar — always shown when an expected vowel exists
      if (expectedVowel) {
        const vowelRow = document.createElement('div');
        vowelRow.className = 'vowel-result';

        if (vs && vs.hasData) {
          let vowelBarClass = 'bar-off';
          if (vs.matchPercent >= 70) vowelBarClass = 'bar-excellent';
          else if (vs.matchPercent >= 40) vowelBarClass = 'bar-fair';

          const vowelLabel = vs.dominantVowel === expectedVowel
            ? expectedVowel
            : `${vs.dominantVowel}\u2192${expectedVowel}`;

          vowelRow.innerHTML = `
            <span class="vowel-spacer"></span>
            <span class="vowel-tag">vowel</span>
            <div class="accuracy-bar vowel-bar-size">
              <div class="accuracy-fill ${vowelBarClass}"
                   style="width: ${vs.matchPercent}%">
              </div>
            </div>
            <span class="note-accuracy">${vs.matchPercent}%</span>
            <span class="vowel-info">${vowelLabel}</span>
          `;
        } else {
          vowelRow.innerHTML = `
            <span class="vowel-spacer"></span>
            <span class="vowel-tag">vowel</span>
            <div class="accuracy-bar vowel-bar-size">
              <div class="accuracy-fill bar-off" style="width: 0%"></div>
            </div>
            <span class="note-accuracy vowel-no-data">No data</span>
            <span class="vowel-info">${expectedVowel}</span>
          `;
        }
        group.appendChild(vowelRow);
      }

      breakdownContainer.appendChild(group);
    }
  }

  // Wire up action buttons
  document.getElementById('retry-btn').addEventListener(
    'click',
    () => launchExercise(activeExerciseDefinition, 0, 0),
    { once: true }
  );

  const backBtn = document.getElementById('back-to-list-btn');
  if (isGuidedSession && guidedSessionIndex < guidedSessionQueue.length - 1) {
    backBtn.textContent = 'Next Exercise →';
    backBtn.addEventListener(
      'click',
      () => {
        guidedSessionIndex++;
        updateSessionProgress();
        launchExercise(guidedSessionQueue[guidedSessionIndex], 0, 0);
      },
      { once: true }
    );
  } else {
    backBtn.textContent = 'Back to Exercises';
    backBtn.addEventListener(
      'click',
      () => {
        isGuidedSession = false;
        guidedSessionIndex = -1;
        updateSessionProgress();
        showScreen(exerciseListScreen);
      },
      { once: true }
    );
  }
}

// ── Profile screen ───────────────────────────────────────────────────

document.getElementById('profile-btn').addEventListener('click', () => {
  // Remember where we were so we can go back
  profileReturnScreen = null;
  for (const s of allScreens) {
    if (!s.classList.contains('hidden') && s !== profileScreen) {
      profileReturnScreen = s;
      break;
    }
  }

  // Stop exercise if one is running
  if (isExerciseRunning) {
    isExerciseRunning = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    profileReturnScreen = exerciseListScreen;
  }

  showProfile();
});

function showProfile() {
  showScreen(profileScreen);

  // Render streak info
  renderStreakInfo();

  // Render performance graph with current timescale
  const canvas = document.getElementById('performance-canvas');
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  renderPerformanceGraph(canvas, { timescale: currentTimescale });

  // Highlight the active timescale button
  document.querySelectorAll('.timescale-btn').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.timescale === currentTimescale)
  );

  // Render legend (clickable — toggles lines on/off)
  renderPerformanceLegend(document.getElementById('performance-legend'), {
    onToggle: () => {
      const c = document.getElementById('performance-canvas');
      c.width = c.offsetWidth;
      c.height = c.offsetHeight;
      renderPerformanceGraph(c, { timescale: currentTimescale });
    },
  });

  // Render running averages
  renderRunningAverages(document.getElementById('running-averages'));

  // Render history list with delete capability
  renderHistoryList(document.getElementById('history-list'), {
    onDelete: () => showProfile(),
  });
}

// Timescale filter buttons
document.querySelectorAll('.timescale-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentTimescale = btn.dataset.timescale;
    document.querySelectorAll('.timescale-btn').forEach((b) =>
      b.classList.toggle('active', b === btn)
    );
    const canvas = document.getElementById('performance-canvas');
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    renderPerformanceGraph(canvas, { timescale: currentTimescale });
  });
});

document.getElementById('back-from-profile-btn').addEventListener('click', () => {
  if (profileReturnScreen) {
    showScreen(profileReturnScreen);
  } else if (selectedVoiceType) {
    showScreen(exerciseListScreen);
  } else {
    showScreen(setupScreen);
  }
});

// ── Browser compatibility check ──────────────────────────────────────

(function checkBrowserSupport() {
  const missing = [];
  if (!window.AudioContext && !window.webkitAudioContext) {
    missing.push('Web Audio API');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    missing.push('getUserMedia (microphone access)');
  }
  if (missing.length > 0) {
    const notice = document.createElement('div');
    notice.className = 'browser-warning';
    notice.textContent = `Your browser is missing: ${missing.join(', ')}. Please use a modern browser like Chrome, Firefox, or Edge.`;
    document.getElementById('app').prepend(notice);
  }
})();
