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
} from './profile.js';
import {
  analyzeFormants,
  checkVowelForSolfege,
  getExpectedVowel,
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
  document.getElementById('target-solfege').textContent = '';
  document.getElementById('detected-solfege').textContent = '';
  document.getElementById('cents-display').textContent = '';
  document.getElementById('accuracy-indicator').textContent = 'Get ready...';
  document.getElementById('accuracy-indicator').className = 'accuracy-indicator';
  document.getElementById('exercise-progress').style.width = '0%';
  document.getElementById('vowel-indicator').textContent = '';
  document.getElementById('vowel-indicator').className = 'vowel-indicator';

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

  const countdownInterval = setInterval(() => {
    beatsRemaining--;
    if (beatsRemaining > 0) {
      countdownOverlay.textContent = beatsRemaining;
      audioEngine.playCountInClick();
    } else {
      countdownOverlay.classList.add('hidden');
      clearInterval(countdownInterval);
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

  // ── Formant / vowel detection ─────────────────────────────────
  let formantResult = null;
  if (detectedMidiNote !== null) {
    formantResult = analyzeFormants(timeDomainData, audioEngine.getSampleRate());
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

  // ── Check vowel against expected solfege ──────────────────────
  let vowelCheck = null;
  if (formantResult && currentStep.solfegeLabel && !activeExerciseDefinition.isContinuous) {
    vowelCheck = checkVowelForSolfege(formantResult.vowel, currentStep.solfegeLabel);
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

  // Target solfege
  targetSolfegeElement.textContent = currentStep.solfegeLabel || '';

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

  // Save to practice history
  saveExerciseResult({
    exerciseId: activeExerciseDefinition.id,
    exerciseName: activeExerciseDefinition.name,
    voiceType: selectedVoiceType,
    score: feedback.overallOnPitchPercent,
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

  // Pitch graph snapshot
  const graphSection = document.getElementById('results-graph-section');
  const pitchGraphImg = document.getElementById('results-pitch-graph');
  if (pitchGraphDataUrl) {
    pitchGraphImg.src = pitchGraphDataUrl;
    graphSection.classList.remove('hidden');
  } else {
    graphSection.classList.add('hidden');
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
      const expectedVowel = solfegeLabel ? getExpectedVowel(solfegeLabel) : null;
      const vs = vowelStats[i];

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

      // Vowel column
      let vowelHtml = '';
      if (vs && vs.hasData && expectedVowel) {
        const vowelMatchClass =
          vs.dominantVowel === expectedVowel ? 'vowel-match' : 'vowel-mismatch';
        vowelHtml = `<span class="note-vowel ${vowelMatchClass}">${vs.dominantVowel}</span>`;
      } else {
        vowelHtml = '<span class="note-vowel"></span>';
      }

      row.innerHTML = `
        <span class="note-label">${stepResult.noteName}</span>
        <span class="note-solfege">${solfegeLabel}</span>
        ${vowelHtml}
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

  // Render performance graph
  const canvas = document.getElementById('performance-canvas');
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  renderPerformanceGraph(canvas);

  // Render legend
  renderPerformanceLegend(document.getElementById('performance-legend'));

  // Render history list with delete capability
  renderHistoryList(document.getElementById('history-list'), {
    onDelete: () => showProfile(),
  });
}

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
