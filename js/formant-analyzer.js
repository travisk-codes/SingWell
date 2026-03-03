/**
 * Formant analysis for vowel detection in singing.
 *
 * Uses Linear Predictive Coding (LPC) with signal downsampling to
 * accurately estimate vocal-tract formants (F1, F2) from the
 * microphone's time-domain buffer.
 *
 * Signal processing pipeline:
 *   1. Extract a centered window from the raw buffer
 *   2. Downsample 4× (~44100 → ~11025 Hz) with block averaging
 *      so the LPC model concentrates on the formant-relevant range
 *   3. Pre-emphasize (first-order high-pass, coeff 0.97)
 *   4. Apply Hamming window
 *   5. Autocorrelation → Levinson-Durbin (order 12) → LPC coeffs
 *   6. Evaluate LPC spectral envelope and find peaks
 *   7. Filter out peaks near F0 harmonics (avoids pitch artefacts)
 *   8. Classify vowel from (F1, F2) using nearest-center matching
 *   9. Temporal smoothing to reduce frame-to-frame jitter
 *
 * Vowel → solfege mapping:
 *   ee  → Mi, Ti   (and chromatic Di, Fi)
 *   eh  → Re       (and chromatic Me, Le, Te)
 *   ah  → Fa, La
 *   oh  → Do, Sol
 */

// ── Configuration ───────────────────────────────────────────────────

/** LPC model order. At ~11 kHz effective rate, 12 gives ~6 pole pairs. */
const LPC_ORDER = 12;

/** High-pass pre-emphasis to flatten the spectral tilt of speech. */
const PRE_EMPHASIS = 0.97;

/** Number of points to evaluate in the LPC spectral envelope. */
const SPECTRUM_POINTS = 512;

/** Window size (samples) to extract from the raw buffer before downsampling. */
const ANALYSIS_WINDOW = 2048;

/** Decimation factor. 44100 / 4 ≈ 11025 Hz — ideal for formant work. */
const DECIMATION_FACTOR = 4;

/** Exponential smoothing weight for new formant estimates (0–1). */
const SMOOTHING_ALPHA = 0.4;

// ── Vowel classification centres ────────────────────────────────────
//
// Average formant frequencies (Hz) across male/female singing voices.
// Classification uses the nearest centre in normalised (F1, F2) space.

const VOWEL_CENTERS = [
  { label: 'ee', f1: 310, f2: 2300 },
  { label: 'eh', f1: 600, f2: 1800 },
  { label: 'ah', f1: 750, f2: 1200 },
  { label: 'oh', f1: 500, f2: 900 },
];

// ── Vowel / solfege mapping ─────────────────────────────────────────

const VOWEL_GROUPS = {
  ee: { label: 'ee', example: 'as in "see"', solfege: ['Mi', 'Ti', 'Di', 'Fi'] },
  eh: { label: 'eh', example: 'as in "set"', solfege: ['Re', 'Me', 'Le', 'Te'] },
  ah: { label: 'ah', example: 'as in "saw"', solfege: ['Fa', 'La'] },
  oh: { label: 'oh', example: 'as in "so"',  solfege: ['Do', 'Sol'] },
};

const SOLFEGE_TO_VOWEL = {
  Do: 'oh', Di: 'ee',
  Re: 'eh', Me: 'eh',
  Mi: 'ee', Fa: 'ah',
  Fi: 'ee', Sol: 'oh',
  Le: 'eh', La: 'ah',
  Te: 'eh', Ti: 'ee',
};

// ── Temporal smoothing state ────────────────────────────────────────

let smoothedF1 = null;
let smoothedF2 = null;

// ── Signal processing primitives ────────────────────────────────────

/**
 * Block-average decimation.  Acts as a crude low-pass anti-aliasing
 * filter (first null at fs/factor) followed by downsampling.
 */
function downsample(signal, factor) {
  const len = Math.floor(signal.length / factor);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) {
      sum += signal[base + j];
    }
    out[i] = sum / factor;
  }
  return out;
}

function preEmphasize(signal) {
  const N = signal.length;
  const out = new Float32Array(N);
  out[0] = signal[0];
  for (let i = 1; i < N; i++) {
    out[i] = signal[i] - PRE_EMPHASIS * signal[i - 1];
  }
  return out;
}

function applyHammingWindow(signal) {
  const N = signal.length;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = signal[i] * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  return out;
}

function computeAutocorrelation(signal, maxLag) {
  const r = new Float64Array(maxLag + 1);
  const N = signal.length;
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < N - lag; i++) {
      sum += signal[i] * signal[i + lag];
    }
    r[lag] = sum;
  }
  return r;
}

// ── Levinson-Durbin recursion ───────────────────────────────────────
//
// Solves the Toeplitz system from the autocorrelation to produce
// LPC coefficients that model the vocal-tract filter.

function levinsonDurbin(autocorr, order) {
  const a = new Float64Array(order + 1);
  const aPrev = new Float64Array(order + 1);
  let error = autocorr[0];

  if (error <= 0) return null;

  for (let m = 1; m <= order; m++) {
    let lambda = autocorr[m];
    for (let j = 1; j < m; j++) {
      lambda -= a[j] * autocorr[m - j];
    }
    lambda /= error;

    for (let j = 1; j < m; j++) {
      aPrev[j] = a[j];
    }

    for (let j = 1; j < m; j++) {
      a[j] = aPrev[j] - lambda * aPrev[m - j];
    }
    a[m] = lambda;

    error *= 1 - lambda * lambda;
    if (error <= 0) return null;
  }

  return a;
}

// ── LPC spectrum evaluation ─────────────────────────────────────────
//
// Evaluates |1 / A(e^jw)|² — the transfer function magnitude of
// the all-pole vocal-tract model.  Peaks are the formants.

function evaluateLpcSpectrum(coefficients, numPoints) {
  const spectrum = new Float64Array(numPoints);

  for (let k = 0; k < numPoints; k++) {
    const omega = (Math.PI * k) / numPoints;
    let re = 1;
    let im = 0;

    for (let i = 1; i < coefficients.length; i++) {
      re -= coefficients[i] * Math.cos(omega * i);
      im += coefficients[i] * Math.sin(omega * i);
    }

    spectrum[k] = 1 / (re * re + im * im + 1e-12);
  }

  return spectrum;
}

// ── Formant peak detection ──────────────────────────────────────────

function findFormantPeaks(spectrum, sampleRate) {
  const binHz = (sampleRate / 2) / spectrum.length;
  const peaks = [];

  // Search between 150 Hz and 3500 Hz
  const minBin = Math.max(1, Math.floor(150 / binHz));
  const maxBin = Math.min(spectrum.length - 1, Math.ceil(3500 / binHz));

  for (let i = minBin; i < maxBin; i++) {
    if (spectrum[i] > spectrum[i - 1] && spectrum[i] > spectrum[i + 1]) {
      // Parabolic interpolation for sub-bin accuracy
      const lnA = Math.log(spectrum[i - 1] + 1e-12);
      const lnB = Math.log(spectrum[i] + 1e-12);
      const lnC = Math.log(spectrum[i + 1] + 1e-12);
      const denom = lnA - 2 * lnB + lnC;
      const p = denom !== 0 ? 0.5 * (lnA - lnC) / denom : 0;

      peaks.push({
        frequency: (i + p) * binHz,
        amplitude: spectrum[i],
      });
    }
  }

  peaks.sort((a, b) => a.frequency - b.frequency);
  return peaks;
}

/**
 * Remove peaks that fall within ±12% of the fundamental or its
 * first few harmonics, which would otherwise be mis-identified
 * as formants.
 */
function filterHarmonicPeaks(peaks, fundamentalHz) {
  if (!fundamentalHz || fundamentalHz <= 0) return peaks;

  return peaks.filter((peak) => {
    for (let h = 1; h <= 4; h++) {
      const harmonicHz = fundamentalHz * h;
      if (Math.abs(peak.frequency - harmonicHz) < harmonicHz * 0.12) {
        return false;
      }
    }
    return true;
  });
}

// ── Vowel classification ────────────────────────────────────────────
//
// Nearest-centre classifier using both F1 (open–close) and F2
// (front–back), normalised by their typical ranges so that neither
// axis dominates.

function classifyVowel(f1, f2) {
  let bestLabel = 'ah';
  let bestDist = Infinity;

  for (const v of VOWEL_CENTERS) {
    const d1 = (f1 - v.f1) / 300;   // F1 range ~300–900
    const d2 = (f2 - v.f2) / 800;   // F2 range ~700–2800
    const dist = d1 * d1 + d2 * d2;
    if (dist < bestDist) {
      bestDist = dist;
      bestLabel = v.label;
    }
  }

  return bestLabel;
}

// ── Temporal smoothing ──────────────────────────────────────────────

function smoothFormants(f1, f2) {
  if (smoothedF1 === null) {
    smoothedF1 = f1;
    smoothedF2 = f2;
  } else {
    smoothedF1 = SMOOTHING_ALPHA * f1 + (1 - SMOOTHING_ALPHA) * smoothedF1;
    smoothedF2 = SMOOTHING_ALPHA * f2 + (1 - SMOOTHING_ALPHA) * smoothedF2;
  }
  return { f1: Math.round(smoothedF1), f2: Math.round(smoothedF2) };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Analyze formants from a time-domain audio buffer.
 *
 * @param {Float32Array} timeDomainData - Raw audio samples (4096+ preferred)
 * @param {number} sampleRate - e.g. 44100
 * @param {number} [fundamentalHz] - Detected pitch (Hz) to filter harmonics
 * @returns {{ f1: number, f2: number, vowel: string } | null}
 */
export function analyzeFormants(timeDomainData, sampleRate, fundamentalHz) {
  // Extract a centred window
  const winSize = Math.min(ANALYSIS_WINDOW, timeDomainData.length);
  const start = Math.floor((timeDomainData.length - winSize) / 2);
  const window = timeDomainData.slice(start, start + winSize);

  // Reject silence
  let energy = 0;
  for (let i = 0; i < window.length; i++) {
    energy += window[i] * window[i];
  }
  if (energy / window.length < 1e-6) return null;

  // ── Downsample → pre-emphasize → Hamming ──────────────────────
  const decimated = downsample(window, DECIMATION_FACTOR);
  const effectiveSampleRate = sampleRate / DECIMATION_FACTOR;
  const processed = applyHammingWindow(preEmphasize(decimated));

  // ── LPC analysis ──────────────────────────────────────────────
  const autocorr = computeAutocorrelation(processed, LPC_ORDER);
  const lpcCoeffs = levinsonDurbin(autocorr, LPC_ORDER);
  if (!lpcCoeffs) return null;

  // ── Spectral envelope → formant peaks ─────────────────────────
  const spectrum = evaluateLpcSpectrum(lpcCoeffs, SPECTRUM_POINTS);
  let peaks = findFormantPeaks(spectrum, effectiveSampleRate);

  // Filter out peaks that coincide with fundamental / harmonics
  if (fundamentalHz) {
    peaks = filterHarmonicPeaks(peaks, fundamentalHz);
  }

  if (peaks.length < 2) return null;

  const rawF1 = peaks[0].frequency;
  const rawF2 = peaks[1].frequency;

  // Sanity checks — reject implausible formant values
  if (rawF1 < 150 || rawF1 > 1100) return null;
  if (rawF2 < 500 || rawF2 > 3200) return null;
  if (rawF2 - rawF1 < 200) return null;

  // Apply temporal smoothing
  const { f1, f2 } = smoothFormants(rawF1, rawF2);

  return {
    f1,
    f2,
    vowel: classifyVowel(f1, f2),
  };
}

/**
 * Check if a detected vowel matches the expected solfege syllable.
 *
 * @param {string} detectedVowel - 'ee' | 'eh' | 'ah' | 'oh'
 * @param {string} expectedSolfege - e.g. 'Do', 'Mi', 'La'
 * @returns {{ matches: boolean, expectedVowel: string, possibleSyllables: string[] }}
 */
export function checkVowelForSolfege(detectedVowel, expectedSolfege) {
  const expectedVowel = SOLFEGE_TO_VOWEL[expectedSolfege] || null;
  const matches = detectedVowel === expectedVowel;
  const group = VOWEL_GROUPS[detectedVowel];
  return {
    matches,
    expectedVowel,
    possibleSyllables: group ? group.solfege : [],
  };
}

/**
 * Get the expected vowel group for a solfege syllable.
 */
export function getExpectedVowel(solfege) {
  return SOLFEGE_TO_VOWEL[solfege] || null;
}

/**
 * Reset the temporal smoothing state.
 * Call when starting a new exercise so stale state doesn't bleed in.
 */
export function resetFormantSmoothing() {
  smoothedF1 = null;
  smoothedF2 = null;
}
