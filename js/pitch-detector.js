/**
 * Pitch detection using the YIN algorithm.
 *
 * Reference:
 *   "YIN, a fundamental frequency estimator for speech and music"
 *   Alain de Cheveigne and Hideki Kawahara, 2002.
 *
 * The YIN algorithm estimates the fundamental frequency of a monophonic
 * audio signal by computing a modified autocorrelation (the "cumulative
 * mean normalized difference function") and finding its first dip below
 * a confidence threshold.
 */

const YIN_CONFIDENCE_THRESHOLD = 0.15;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Chromatic solfege syllables (movable Do, mixed enharmonic names)
const SOLFEGE_SYLLABLES = ['Do', 'Di', 'Re', 'Me', 'Mi', 'Fa', 'Fi', 'Sol', 'Le', 'La', 'Te', 'Ti'];

/**
 * Detect the fundamental frequency in a buffer of audio samples.
 *
 * @param {Float32Array} sampleBuffer - Raw time-domain audio samples
 * @param {number} sampleRate - Audio sample rate in Hz (e.g. 44100)
 * @returns {{ frequency: number, confidence: number } | null}
 *          The detected frequency and a 0-1 confidence score, or null
 *          if no clear pitch was found.
 */
export function detectPitch(sampleBuffer, sampleRate) {
  const bufferLength = sampleBuffer.length;
  const halfBufferLength = Math.floor(bufferLength / 2);

  // Step 1: Difference function
  // For each lag tau, sum the squared differences between the signal
  // and a shifted copy of itself.
  const differenceFunction = new Float32Array(halfBufferLength);
  for (let lag = 0; lag < halfBufferLength; lag++) {
    let squaredDifferenceSum = 0;
    for (let sampleIndex = 0; sampleIndex < halfBufferLength; sampleIndex++) {
      const delta = sampleBuffer[sampleIndex] - sampleBuffer[sampleIndex + lag];
      squaredDifferenceSum += delta * delta;
    }
    differenceFunction[lag] = squaredDifferenceSum;
  }

  // Step 2: Cumulative mean normalized difference function (CMNDF)
  // Normalizes the difference function so that dips correspond to
  // high-confidence period estimates rather than just low energy.
  const cumulativeMeanNormalizedDifference = new Float32Array(halfBufferLength);
  cumulativeMeanNormalizedDifference[0] = 1;
  let runningSum = 0;

  for (let lag = 1; lag < halfBufferLength; lag++) {
    runningSum += differenceFunction[lag];
    cumulativeMeanNormalizedDifference[lag] =
      differenceFunction[lag] * lag / runningSum;
  }

  // Step 3: Absolute threshold
  // Find the first lag where the CMNDF drops below the threshold,
  // then walk forward to the local minimum.
  let estimatedLag = -1;

  for (let lag = 2; lag < halfBufferLength; lag++) {
    if (cumulativeMeanNormalizedDifference[lag] < YIN_CONFIDENCE_THRESHOLD) {
      while (
        lag + 1 < halfBufferLength &&
        cumulativeMeanNormalizedDifference[lag + 1] <
          cumulativeMeanNormalizedDifference[lag]
      ) {
        lag++;
      }
      estimatedLag = lag;
      break;
    }
  }

  if (estimatedLag === -1) {
    return null;
  }

  // Step 4: Parabolic interpolation
  // Refine the lag estimate to sub-sample accuracy by fitting a
  // parabola through the CMNDF at (lag-1, lag, lag+1).
  let refinedLag;
  const previousLag = estimatedLag >= 1 ? estimatedLag - 1 : estimatedLag;
  const nextLag =
    estimatedLag + 1 < halfBufferLength ? estimatedLag + 1 : estimatedLag;

  if (previousLag === estimatedLag) {
    refinedLag =
      cumulativeMeanNormalizedDifference[estimatedLag] <=
      cumulativeMeanNormalizedDifference[nextLag]
        ? estimatedLag
        : nextLag;
  } else if (nextLag === estimatedLag) {
    refinedLag =
      cumulativeMeanNormalizedDifference[estimatedLag] <=
      cumulativeMeanNormalizedDifference[previousLag]
        ? estimatedLag
        : previousLag;
  } else {
    const valueBefore = cumulativeMeanNormalizedDifference[previousLag];
    const valueAtLag = cumulativeMeanNormalizedDifference[estimatedLag];
    const valueAfter = cumulativeMeanNormalizedDifference[nextLag];
    refinedLag =
      estimatedLag +
      (valueAfter - valueBefore) / (2 * (2 * valueAtLag - valueAfter - valueBefore));
  }

  const detectedFrequency = sampleRate / refinedLag;
  const confidenceScore = 1 - cumulativeMeanNormalizedDifference[estimatedLag];

  return { frequency: detectedFrequency, confidence: confidenceScore };
}

// ── Note / MIDI / Cents conversion utilities ─────────────────────────

/**
 * Convert a frequency in Hz to a (fractional) MIDI note number.
 * A4 = 440 Hz = MIDI 69.
 */
export function frequencyToMidiNote(frequency) {
  return 69 + 12 * Math.log2(frequency / 440);
}

/**
 * Convert a MIDI note number to a frequency in Hz.
 */
export function midiNoteToFrequency(midiNote) {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

/**
 * Convert a MIDI note number to a human-readable name like "C4" or "F#3".
 * Rounds to the nearest integer MIDI note.
 */
export function midiNoteToName(midiNote) {
  const roundedNote = Math.round(midiNote);
  const noteIndex = ((roundedNote % 12) + 12) % 12; // handle negatives
  const octave = Math.floor(roundedNote / 12) - 1;
  return NOTE_NAMES[noteIndex] + octave;
}

/**
 * Calculate how many cents the detected frequency is away from a
 * target MIDI note. Positive = sharp, negative = flat.
 * 100 cents = 1 semitone.
 */
export function getCentsFromTarget(detectedFrequency, targetMidiNote) {
  const targetFrequency = midiNoteToFrequency(targetMidiNote);
  return 1200 * Math.log2(detectedFrequency / targetFrequency);
}

/**
 * Convert a MIDI note to its solfege syllable relative to a tonic.
 * Uses movable Do — the interval between the note and the tonic
 * determines the syllable.
 */
export function midiNoteToSolfege(midiNote, baseMidiNote) {
  const interval = ((Math.round(midiNote) - Math.round(baseMidiNote)) % 12 + 12) % 12;
  return SOLFEGE_SYLLABLES[interval];
}
