/**
 * SingWell — main application controller.
 *
 * Manages the four screens (setup, exercise list, active exercise,
 * results), coordinates audio capture with pitch detection, drives
 * the exercise timer, and updates the UI on every animation frame.
 */

import {
  detectPitch,
  frequencyToMidiNote,
  midiNoteToName,
  midiNoteToFrequency,
} from './pitch-detector.js';
import { AudioEngine } from './audio-engine.js';
import {
  WARMUP_EXERCISES,
  VOICE_TYPE_BASE_NOTES,
} from './exercises.js';
import { PitchVisualizer } from './visualizer.js';
import { analyzePerformance } from './feedback.js';

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

const allScreens = [
  setupScreen,
  exerciseListScreen,
  activeExerciseScreen,
  resultsScreen,
];

// ── Screen management ────────────────────────────────────────────────

function showScreen(screen) {
  for (const s of allScreens) {
    s.classList.add('hidden');
  }
  screen.classList.remove('hidden');
}

// ── Setup screen ─────────────────────────────────────────────────────

const voiceTypeGrid = document.querySelector('.voice-type-grid');
const startButton = document.getElementById('start-btn');

voiceTypeGrid.addEventListener('click', (event) => {
  const button = event.target.closest('.voice-type-btn');
  if (!button) return;

  selectedVoiceType = button.getAttribute('data-voice-type');
  selectedBaseMidiNote = VOICE_TYPE_BASE_NOTES[selectedVoiceType];

  for (const btn of voiceTypeGrid.querySelectorAll('.voice-type-btn')) {
    if (btn === button) {
      btn.classList.add('selected');
    } else {
      btn.classList.remove('selected');
    }
  }

  startButton.disabled = false;
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

// ── Active exercise screen ───────────────────────────────────────────

function launchExercise(exerciseDefinition) {
  activeExerciseDefinition = exerciseDefinition;
  activeExerciseSteps = exerciseDefinition.createSteps(selectedBaseMidiNote);
  collectedPitchSamples = [];
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
  document.getElementById('cents-display').textContent = '';
  document.getElementById('accuracy-indicator').textContent = 'Get ready...';
  document.getElementById('accuracy-indicator').className = 'accuracy-indicator';
  document.getElementById('exercise-progress').style.width = '0%';

  runCountIn();
}

function runCountIn() {
  const countdownOverlay = document.getElementById('countdown');
  countdownOverlay.classList.remove('hidden');

  let beatsRemaining = 3;
  countdownOverlay.textContent = beatsRemaining;
  audioEngine.playCountInClick();

  const countdownInterval = setInterval(() => {
    beatsRemaining--;
    if (beatsRemaining > 0) {
      countdownOverlay.textContent = beatsRemaining;
      audioEngine.playCountInClick();
    } else {
      countdownOverlay.classList.add('hidden');
      clearInterval(countdownInterval);

      // Play the first target note as a reference
      const firstStep = activeExerciseSteps[0];
      audioEngine.playReferenceTone(firstStep.targetFrequency, 0.8, 0.12);

      beginExerciseLoop();
    }
  }, 1000);
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
  // (skip for continuous exercises — the slide is the point)
  if (
    currentStepIndex !== previousStepIndex &&
    !activeExerciseDefinition.isContinuous
  ) {
    audioEngine.playReferenceTone(currentStep.targetFrequency, 0.5, 0.08);
    previousStepIndex = currentStepIndex;
  } else if (activeExerciseDefinition.isContinuous) {
    previousStepIndex = currentStepIndex;
  }

  // ── Record sample ────────────────────────────────────────────
  const rmsVolume = audioEngine.computeRmsVolume();

  if (detectedMidiNote !== null) {
    collectedPitchSamples.push({
      timeMs: elapsedMs,
      midiNote: detectedMidiNote,
      rmsVolume,
    });
  }

  // ── Update visualization ─────────────────────────────────────
  pitchVisualizer.recordPitchSample(elapsedMs, detectedMidiNote);
  pitchVisualizer.render();

  // ── Update live readout ──────────────────────────────────────
  updateLiveDisplay(currentStep, detectedMidiNote, rmsVolume, elapsedMs, totalDurationMs);

  animationFrameId = requestAnimationFrame(exerciseLoop);
}

function updateLiveDisplay(
  currentStep,
  detectedMidiNote,
  rmsVolume,
  elapsedMs,
  totalDurationMs
) {
  const targetNoteElement = document.getElementById('target-note');
  const detectedNoteElement = document.getElementById('detected-note');
  const centsDisplayElement = document.getElementById('cents-display');
  const accuracyIndicatorElement = document.getElementById('accuracy-indicator');
  const progressBarElement = document.getElementById('exercise-progress');
  const volumeMeterElement = document.getElementById('volume-meter');

  // Target note
  targetNoteElement.textContent = midiNoteToName(
    Math.round(currentStep.targetMidiNote)
  );

  // Detected note and accuracy
  if (detectedMidiNote !== null) {
    detectedNoteElement.textContent = midiNoteToName(
      Math.round(detectedMidiNote)
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
    centsDisplayElement.textContent = '';
    accuracyIndicatorElement.className = 'accuracy-indicator';
    accuracyIndicatorElement.textContent = 'Listening...';
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

  const feedback = analyzePerformance(
    collectedPitchSamples,
    activeExerciseSteps,
    activeExerciseDefinition.isContinuous
  );

  displayResults(feedback);
  showScreen(resultsScreen);
}

// ── Results screen ───────────────────────────────────────────────────

function displayResults(feedback) {
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

    for (const stepResult of feedback.perStepResults) {
      const row = document.createElement('div');
      row.className = 'note-result';

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

      row.innerHTML = `
        <span class="note-label">${stepResult.noteName}</span>
        <div class="accuracy-bar">
          <div class="accuracy-fill ${barColorClass}"
               style="width: ${stepResult.wasDetected ? stepResult.onPitchPercent : 0}%">
          </div>
        </div>
        <span class="note-accuracy">${accuracyText}</span>
        <span class="note-cents">${centsText}</span>
      `;
      breakdownContainer.appendChild(row);
    }
  }

  // Wire up action buttons
  document.getElementById('retry-btn').addEventListener(
    'click',
    () => launchExercise(activeExerciseDefinition),
    { once: true }
  );
  document.getElementById('back-to-list-btn').addEventListener(
    'click',
    () => showScreen(exerciseListScreen),
    { once: true }
  );
}

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
