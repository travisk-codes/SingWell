/**
 * Formant analysis for vowel detection in singing.
 *
 * Uses Linear Predictive Coding (LPC) with signal downsampling to
 * accurately estimate vocal-tract formants (F1, F2) from the
 * microphone's time-domain buffer.
 *
 * Signal processing pipeline:
 *   1. Extract a centered window from the raw buffer
 *   2. 4th-order Butterworth high-pass at 120 Hz (cascaded biquads,
 *      24 dB/oct) to remove fundamental & proximity-effect bass
 *   3. Anti-aliased decimate 4× (~44100 → ~11025 Hz) using a
 *      101-tap Hamming-windowed sinc FIR low-pass filter
 *   4. Pre-emphasize (first-order high-pass, coeff 0.97)
 *   5. Apply Hamming window
 *   6. Autocorrelation → Levinson-Durbin (order 14) → LPC coeffs
 *   7. Evaluate LPC spectral envelope and find peaks
 *   8. Select F1 (lowest peak 150–1100 Hz) and F2 (strongest
 *      peak ≥ F1+200 Hz, up to 3200 Hz)
 *   9. 5-frame median filter to reject outlier estimates
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
const HP_CUTOFF_HZ = 120;
const AA_TAPS = 101;
const MEDIAN_WINDOW = 5;

// Pre-compute anti-aliasing FIR coefficients (Hamming-windowed sinc,
// cutoff at π/DECIMATION_FACTOR so we reject everything above the
// decimated Nyquist before down-sampling).  101 taps gives >40 dB
// stopband attenuation with a ~3500 Hz transition band.
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

// ── Temporal smoothing state (median filter) ────────────────────────

const f1Buffer = [];
const f2Buffer = [];

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

// 4th-order Butterworth high-pass (two cascaded 2nd-order biquads).
// 24 dB/oct rolloff aggressively removes the fundamental while
// F1 for "ee" (~310 Hz) sees < 1 dB of attenuation.
function applyHighPass4(signal, cutoffHz, sampleRate) {
  const omega = 2 * Math.PI * cutoffHz / sampleRate;
  const cosW = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * 0.7071);
  const a0 = 1 + alpha;
  const b0 = ((1 + cosW) / 2) / a0;
  const b1 = (-(1 + cosW)) / a0;
  const b2 = b0;
  const a1 = (-2 * cosW) / a0;
  const a2 = (1 - alpha) / a0;
  const N = signal.length;
  // First pass
  const mid = new Float32Array(N);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < N; i++) {
    mid[i] = b0 * signal[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = signal[i];
    y2 = y1; y1 = mid[i];
  }
  // Second pass (cascade)
  const out = new Float32Array(N);
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  for (let i = 0; i < N; i++) {
    out[i] = b0 * mid[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = mid[i];
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

// ── Temporal smoothing (median filter) ───────────────────────────────
// A median filter is far better than exponential smoothing at rejecting
// outlier frames where LPC poles jump to harmonic positions.

function medianOf(arr) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function smoothFormants(f1, f2) {
  f1Buffer.push(f1);
  f2Buffer.push(f2);
  if (f1Buffer.length > MEDIAN_WINDOW) f1Buffer.shift();
  if (f2Buffer.length > MEDIAN_WINDOW) f2Buffer.shift();
  return { f1: Math.round(medianOf(f1Buffer)), f2: Math.round(medianOf(f2Buffer)) };
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

  // 4th-order high-pass → anti-alias + decimate → pre-emphasize → Hamming
  const highPassed = applyHighPass4(window, HP_CUTOFF_HZ, sampleRate);
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

  // Pick F2: strongest peak at least 200 Hz above F1, up to 3200 Hz.
  // Preferring the highest-amplitude candidate means we lock onto
  // true formant resonances rather than weak spurious LPC peaks.
  let f2Peak = null;
  for (const p of peaks) {
    if (p.frequency >= f1Peak.frequency + 200 && p.frequency <= 3200) {
      if (!f2Peak || p.amplitude > f2Peak.amplitude) {
        f2Peak = p;
      }
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
  f1Buffer.length = 0;
  f2Buffer.length = 0;
}
