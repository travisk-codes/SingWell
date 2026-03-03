/**
 * Formant analysis for vowel detection in singing.
 *
 * Uses Linear Predictive Coding (LPC) to estimate the spectral envelope
 * of the vocal tract, then finds formant peaks (F1, F2) and classifies
 * the detected vowel.
 *
 * This allows partial solfege syllable verification: we can distinguish
 * vowel groups (ee, eh, ah, oh) but NOT consonants (D vs F vs L vs S).
 *
 * Vowel → solfege mapping:
 *   ee  → Mi, Ti   (and chromatic Di, Fi)
 *   eh  → Re       (and chromatic Me, Le, Te)
 *   ah  → Fa, La
 *   oh  → Do, Sol
 *
 * Known limitations:
 *   - Cannot distinguish syllables within the same vowel group
 *     (Do vs Sol, Mi vs Ti, Fa vs La)
 *   - Accuracy degrades at high pitches (soprano above ~C5) where
 *     the fundamental frequency interferes with F1
 *   - Speaker variation means thresholds are approximate
 *   - Consonant detection is not attempted
 */

// ── Configuration ───────────────────────────────────────────────────

/** LPC model order. 12–14 resolves F1/F2 without overfitting. */
const LPC_ORDER = 14;

/** High-pass pre-emphasis to flatten the spectral tilt of speech. */
const PRE_EMPHASIS = 0.97;

/** Number of points to evaluate in the LPC spectral envelope. */
const SPECTRUM_POINTS = 512;

/** Window size (samples) to use from the input buffer. */
const ANALYSIS_WINDOW = 2048;

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

// ── Signal processing primitives ────────────────────────────────────

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
// LPC coefficients. These coefficients model the vocal-tract filter.

function levinsonDurbin(autocorr, order) {
  const a = new Float64Array(order + 1);
  const aPrev = new Float64Array(order + 1);
  let error = autocorr[0];

  if (error <= 0) return null;

  for (let m = 1; m <= order; m++) {
    // Compute reflection coefficient
    let lambda = autocorr[m];
    for (let j = 1; j < m; j++) {
      lambda -= a[j] * autocorr[m - j];
    }
    lambda /= error;

    // Store previous coefficients
    for (let j = 1; j < m; j++) {
      aPrev[j] = a[j];
    }

    // Update coefficients
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
// Evaluates |1 / A(e^jw)|^2 — the transfer function magnitude of
// the all-pole vocal-tract model. Peaks in this curve are the formants.

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

  // Search between 200 Hz and 3500 Hz
  const minBin = Math.max(1, Math.floor(200 / binHz));
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

// ── Vowel classification ────────────────────────────────────────────
//
// Uses F2 as the primary axis (front–back vowel dimension).
// F1 (open–close) provides secondary confirmation.
//
// Approximate F2 boundaries (aggregated across male/female voices):
//   > 1800 Hz  →  front close  ("ee")
//   1400–1800  →  front mid    ("eh")
//   900–1400   →  open central ("ah")
//   < 900      →  back rounded ("oh")

function classifyVowel(f1, f2) {
  if (f2 > 1800) return 'ee';
  if (f2 > 1400) return 'eh';
  if (f2 > 900) return 'ah';
  return 'oh';
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Analyze formants from a time-domain audio buffer.
 *
 * @param {Float32Array} timeDomainData - Raw audio samples (4096+ preferred)
 * @param {number} sampleRate - e.g. 44100
 * @returns {{ f1: number, f2: number, vowel: string } | null}
 */
export function analyzeFormants(timeDomainData, sampleRate) {
  // Extract a centered window
  const winSize = Math.min(ANALYSIS_WINDOW, timeDomainData.length);
  const start = Math.floor((timeDomainData.length - winSize) / 2);
  const window = timeDomainData.slice(start, start + winSize);

  // Reject silence
  let energy = 0;
  for (let i = 0; i < window.length; i++) {
    energy += window[i] * window[i];
  }
  if (energy / window.length < 1e-6) return null;

  // Pre-emphasize → Hamming window
  const processed = applyHammingWindow(preEmphasize(window));

  // LPC analysis
  const autocorr = computeAutocorrelation(processed, LPC_ORDER);
  const lpcCoeffs = levinsonDurbin(autocorr, LPC_ORDER);
  if (!lpcCoeffs) return null;

  // Evaluate LPC spectral envelope and find peaks
  const spectrum = evaluateLpcSpectrum(lpcCoeffs, SPECTRUM_POINTS);
  const peaks = findFormantPeaks(spectrum, sampleRate);

  if (peaks.length < 2) return null;

  const f1 = peaks[0].frequency;
  const f2 = peaks[1].frequency;

  // Sanity checks — reject implausible formant values
  if (f1 < 150 || f1 > 1100) return null;
  if (f2 < 500 || f2 > 3200) return null;
  if (f2 - f1 < 200) return null;

  return {
    f1: Math.round(f1),
    f2: Math.round(f2),
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
