/**
 * Post-exercise analysis and feedback generation.
 *
 * This module evaluates pitch accuracy, stability, and tendencies,
 * then produces honest, constructive text feedback. It does not
 * sugarcoat poor results — the user asked for that explicitly.
 */

// A "cent" is 1/100th of a semitone.
// 30 cents off is noticeably wrong to most listeners.
const ON_PITCH_THRESHOLD_CENTS = 30;

/**
 * Analyze the singer's pitch data against the exercise targets.
 *
 * @param {Array<{timeMs: number, midiNote: number, rmsVolume?: number}>} pitchSamples
 * @param {Array<{targetMidiNote: number, durationMs: number, noteName: string}>} exerciseSteps
 * @param {boolean} isContinuousExercise - if true, skip per-note breakdown
 * @returns {object} Analysis results including per-step breakdown, overall stats, and feedback text
 */
export function analyzePerformance(
  pitchSamples,
  exerciseSteps,
  isContinuousExercise = false
) {
  const perStepResults = evaluateEachStep(pitchSamples, exerciseSteps);
  const stepsWithData = perStepResults.filter((r) => r.wasDetected);

  const overallOnPitchPercent =
    stepsWithData.length > 0
      ? stepsWithData.reduce((sum, r) => sum + r.onPitchPercent, 0) /
        stepsWithData.length
      : 0;

  const overallAverageCentsOff =
    stepsWithData.length > 0
      ? stepsWithData.reduce((sum, r) => sum + Math.abs(r.averageCentsOff), 0) /
        stepsWithData.length
      : 0;

  const overallPitchStability =
    stepsWithData.length > 0
      ? stepsWithData.reduce((sum, r) => sum + r.stabilityStdDev, 0) /
        stepsWithData.length
      : 0;

  const rating = determineRating(
    pitchSamples.length,
    overallOnPitchPercent,
    overallAverageCentsOff
  );

  const feedbackText = buildFeedbackText(
    pitchSamples.length,
    stepsWithData,
    overallOnPitchPercent,
    overallAverageCentsOff,
    overallPitchStability,
    rating,
    isContinuousExercise
  );

  return {
    perStepResults,
    overallOnPitchPercent,
    overallAverageCentsOff,
    overallPitchStability,
    rating,
    feedbackText,
    isContinuousExercise,
  };
}

// ── Per-step evaluation ──────────────────────────────────────────────

function evaluateEachStep(pitchSamples, exerciseSteps) {
  const results = [];
  let stepStartTimeMs = 0;

  for (const step of exerciseSteps) {
    const stepEndTimeMs = stepStartTimeMs + step.durationMs;
    const samplesInStep = pitchSamples.filter(
      (s) => s.timeMs >= stepStartTimeMs && s.timeMs < stepEndTimeMs
    );

    if (samplesInStep.length === 0) {
      results.push({
        noteName: step.noteName,
        targetMidiNote: step.targetMidiNote,
        wasDetected: false,
        onPitchPercent: 0,
        averageCentsOff: 0,
        stabilityStdDev: 0,
        sampleCount: 0,
      });
    } else {
      const centsOffValues = samplesInStep.map(
        (s) => (s.midiNote - step.targetMidiNote) * 100
      );
      const absoluteCentsValues = centsOffValues.map(Math.abs);

      const onPitchCount = absoluteCentsValues.filter(
        (c) => c < ON_PITCH_THRESHOLD_CENTS
      ).length;
      const onPitchPercent = (onPitchCount / samplesInStep.length) * 100;

      const averageCentsOff =
        centsOffValues.reduce((a, b) => a + b, 0) / centsOffValues.length;

      // Standard deviation of cents = pitch stability
      const meanCents = averageCentsOff;
      const variance =
        centsOffValues.reduce((sum, c) => sum + (c - meanCents) ** 2, 0) /
        centsOffValues.length;
      const stabilityStdDev = Math.sqrt(variance);

      results.push({
        noteName: step.noteName,
        targetMidiNote: step.targetMidiNote,
        wasDetected: true,
        onPitchPercent,
        averageCentsOff,
        stabilityStdDev,
        sampleCount: samplesInStep.length,
      });
    }

    stepStartTimeMs += step.durationMs;
  }

  return results;
}

// ── Rating ───────────────────────────────────────────────────────────

function determineRating(totalSamples, onPitchPercent, averageCentsOff) {
  if (totalSamples < 10) return 'insufficient_data';
  if (onPitchPercent >= 85 && averageCentsOff < 15) return 'excellent';
  if (onPitchPercent >= 70 && averageCentsOff < 30) return 'good';
  if (onPitchPercent >= 50) return 'fair';
  return 'needs_work';
}

// ── Feedback text ────────────────────────────────────────────────────

function buildFeedbackText(
  totalSamples,
  stepsWithData,
  onPitchPercent,
  averageCentsOff,
  pitchStability,
  rating,
  isContinuousExercise
) {
  const lines = [];

  // Not enough data
  if (totalSamples < 10) {
    lines.push(
      'Not enough audio was detected. Make sure your microphone is working ' +
        "and you're singing loud enough for it to pick up."
    );
    return lines.join(' ');
  }

  // Overall accuracy assessment — honest, not flattering
  switch (rating) {
    case 'excellent':
      lines.push(
        'Solid accuracy. Your pitch was consistently close to the targets.'
      );
      break;
    case 'good':
      lines.push(
        'Decent pitch accuracy, with room to tighten up. ' +
          'You were in the right neighbourhood on most notes but not always locked in.'
      );
      break;
    case 'fair':
      lines.push(
        'You hit the general area on some notes, but your accuracy needs real work. ' +
          "Don't rush through the notes — take time to find each pitch."
      );
      break;
    case 'needs_work':
      lines.push(
        "This was rough. That's fine — warmups exist for exactly this reason. " +
          'Slow down, listen to the reference tone, and try matching it before moving on.'
      );
      break;
  }

  // Tendency: sharp or flat
  const sharpSteps = stepsWithData.filter((r) => r.averageCentsOff > 15);
  const flatSteps = stepsWithData.filter((r) => r.averageCentsOff < -15);

  if (sharpSteps.length > 0 && sharpSteps.length > flatSteps.length * 2) {
    lines.push(
      'You tend to sing sharp. Try relaxing your throat and supporting from your diaphragm ' +
        'rather than pushing the pitch up with tension.'
    );
  } else if (flatSteps.length > 0 && flatSteps.length > sharpSteps.length * 2) {
    lines.push(
      'You tend to sing flat. Focus on engaging your breath support and ' +
        "lifting your soft palate. Think of the pitch as something you're placing, not reaching for."
    );
  }

  // Pitch stability (wobble)
  if (pitchStability > 40) {
    lines.push(
      'Your pitch wanders noticeably within held notes. ' +
        'Work on sustaining a steady stream of air — uneven breath causes uneven pitch.'
    );
  } else if (pitchStability > 25) {
    lines.push(
      'There is some wobble in your sustained notes. ' +
        'Breath control exercises (like sustained hissing) can help stabilize this.'
    );
  }

  // Identify specific weak notes (skip for continuous exercises)
  if (!isContinuousExercise) {
    const weakNotes = stepsWithData.filter((r) => r.onPitchPercent < 40);
    if (weakNotes.length > 0 && weakNotes.length <= 3) {
      const weakNoteNames = weakNotes.map((r) => r.noteName).join(', ');
      lines.push(
        `You struggled most with: ${weakNoteNames}. ` +
          'Try isolating those notes — play the reference tone and match it before attempting the full exercise.'
      );
    }
  }

  return lines.join(' ');
}
