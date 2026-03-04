/**
 * Formant analysis for vowel detection in singing.
 *
 * Uses Linear Predictive Coding (LPC) with signal downsampling to
 * accurately estimate vocal-tract formants (F1, F2) from the
 * microphone's time-domain buffer.
 *
 * Signal processing pipeline:
 *   1. Extract a centered window from the raw buffer
 *   2. 2nd-order Butterworth high-pass at 80 Hz to remove sub-
 *      fundamental rumble (proximity effect, room noise)
 *   3. Anti-aliased decimate 4× (~44100 → ~11025 Hz) using a
 *      41-tap Hamming-windowed sinc FIR low-pass filter
 *   4. Pre-emphasize (first-order high-pass, coeff 0.97)
 *   5. Apply Hamming window
 *   6. Autocorrelation → Levinson-Durbin (order 14) → LPC coeffs
 *   7. Evaluate LPC spectral envelope and find peaks
 *   8. Select F1 (lowest-freq peak in 150–1100 Hz) and F2 (first
 *      peak ≥ F1+200 Hz, up to 3200 Hz) from the LPC envelope
 *   9. Temporal smoothing to reduce frame-to-frame jitter
 *  10. Classify vowel from (F1, F2) using nearest-center matching
 *
 * Vowel → solfege mapping:
 *   ee  → Mi, Ti   (and chromatic Di, Fi)
 *   eh  → Re       (and chromatic Me, Le, Te)
 *   ah  → Fa, La
 *   oh  → Do, Sol
 */

// ── Configuration ───────────────────────────────────────────────────

const LPC_ORDER = 14;
const PRE_EMPHASIS = 0.97;
const SPECTRUM_POINTS = 512;
const ANALYSIS_WINDOW = 4096;
const DECIMATION_FACTOR = 4;
const SMOOTHING_ALPHA = 0.3;
const HP_CUTOFF_HZ = 80;
const AA_TAPS = 41;

// Pre-compute anti-aliasing FIR coefficients (Hamming-windowed sinc,
// cutoff at π/DECIMATION_FACTOR so we reject everything above the
// decimated Nyquist before down-sampling)
const AA_COEFFS = (() => {
  const N = AA_TAPS;
  const cutoff = Math.PI / DECIMATION_FACTOR;
  const h = new Float64Array(N);
  const mid = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    const n = i - mid;
    h[i] = n === 0 ? cutoff / Math.PI : Math.sin(cutoff * n) / (Math.PI * n);
    h[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1));
  }
  let sum = 0;
  for (let i = 0; i < N; i++) sum += h[i];
  for (let i = 0; i < N; i++) h[i] /= sum;
  return h;
})();

// ── Vowel classification centres ────────────────────────────────────

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

function antiAliasDecimate(signal, factor) {
  const len = Math.floor(signal.length / factor);
  const M = AA_COEFFS.length;
  const mid = Math.floor(M / 2);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const center = i * factor;
    let sum = 0;
    for (let j = 0; j < M; j++) {
      const idx = center - mid + j;
      if (idx >= 0 && idx < signal.length) {
        sum += signal[idx] * AA_COEFFS[j];
      }
    }
    out[i] = sum;
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

function applyHighPass(signal, cutoffHz, sampleRate) {
  const omega = 2 * Math.PI * cutoffHz / sampleRate;
  const cosW = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * 0.7071); // Q = 0.707 (Butterworth)
  const a0 = 1 + alpha;
  const b0 = ((1 + cosW) / 2) / a0;
  const b1 = (-(1 + cosW)) / a0;
  const b2 = b0;
  const a1 = (-2 * cosW) / a0;
  const a2 = (1 - alpha) / a0;
  const N = signal.length;
  const out = new Float32Array(N);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < N; i++) {
    out[i] = b0 * signal[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = signal[i];
    y2 = y1; y1 = out[i];
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

  const minBin = Math.max(1, Math.floor(150 / binHz));
  const maxBin = Math.min(spectrum.length - 1, Math.ceil(3500 / binHz));

  for (let i = minBin; i < maxBin; i++) {
    if (spectrum[i] > spectrum[i - 1] && spectrum[i] > spectrum[i + 1]) {
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

function classifyVowel(f1, f2) {
  let bestLabel = 'ah';
  let bestDist = Infinity;

  for (const v of VOWEL_CENTERS) {
    const d1 = (f1 - v.f1) / 300;
    const d2 = (f2 - v.f2) / 800;
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

export function analyzeFormants(timeDomainData, sampleRate) {
  const winSize = Math.min(ANALYSIS_WINDOW, timeDomainData.length);
  const start = Math.floor((timeDomainData.length - winSize) / 2);
  const window = timeDomainData.slice(start, start + winSize);

  let energy = 0;
  for (let i = 0; i < window.length; i++) {
    energy += window[i] * window[i];
  }
  if (energy / window.length < 1e-6) return null;

  // High-pass → anti-alias + decimate → pre-emphasize → Hamming
  const highPassed = applyHighPass(window, HP_CUTOFF_HZ, sampleRate);
  const decimated = antiAliasDecimate(highPassed, DECIMATION_FACTOR);
  const effectiveSampleRate = sampleRate / DECIMATION_FACTOR;
  const processed = applyHammingWindow(preEmphasize(decimated));

  // LPC analysis
  const autocorr = computeAutocorrelation(processed, LPC_ORDER);
  const lpcCoeffs = levinsonDurbin(autocorr, LPC_ORDER);
  if (!lpcCoeffs) return null;

  // Spectral envelope → formant peaks
  const spectrum = evaluateLpcSpectrum(lpcCoeffs, SPECTRUM_POINTS);
  const peaks = findFormantPeaks(spectrum, effectiveSampleRate);

  // Pick F1: lowest-frequency peak in 150–1100 Hz.
  // Peaks are frequency-sorted and come from a smooth LPC envelope
  // (order 14 → at most 7 peaks), so the first in range is F1.
  let f1Peak = null;
  for (const p of peaks) {
    if (p.frequency >= 150 && p.frequency <= 1100) {
      f1Peak = p;
      break;
    }
  }
  if (!f1Peak) return null;

  // Pick F2: first peak at least 200 Hz above F1, up to 3200 Hz
  let f2Peak = null;
  for (const p of peaks) {
    if (p.frequency >= f1Peak.frequency + 200 && p.frequency <= 3200) {
      f2Peak = p;
      break;
    }
  }
  if (!f2Peak) return null;

  const { f1, f2 } = smoothFormants(f1Peak.frequency, f2Peak.frequency);

  return {
    f1,
    f2,
    vowel: classifyVowel(f1, f2),
  };
}

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

export function getExpectedVowel(solfege) {
  return SOLFEGE_TO_VOWEL[solfege] || null;
}

export function resetFormantSmoothing() {
  smoothedF1 = null;
  smoothedF2 = null;
}
