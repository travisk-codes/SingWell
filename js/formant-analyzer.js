/**
 * Formant analysis for vowel detection in singing.
 *
 * Uses cepstral spectral-envelope estimation with signal downsampling
 * to accurately estimate vocal-tract formants (F1, F2) from the
 * microphone's time-domain buffer.  Cepstral liftering cleanly
 * separates the vocal-tract shape (formants) from the excitation
 * source (harmonics), which LPC cannot do when harmonics are strong
 * (e.g. studio condenser microphones).
 *
 * Signal processing pipeline:
 *   1. Extract a centered window from the raw buffer
 *   2. 4th-order Butterworth high-pass at 120 Hz (cascaded biquads,
 *      24 dB/oct) to remove fundamental & proximity-effect bass
 *   3. Anti-aliased decimate 4× (~44100 → ~11025 Hz) using a
 *      101-tap Hamming-windowed sinc FIR low-pass filter
 *   4. Pre-emphasize (first-order high-pass, coeff 0.97)
 *   5. Apply Hamming window
 *   6. FFT → log magnitude → IFFT → cepstrum → lifter (keep 20
 *      low-quefrency coefficients) → FFT → exp → smooth envelope
 *   7. Find prominent peaks (≥ 1.4× local minimum within ±150 Hz)
 *   8. Select F1 (lowest significant peak 150–1100 Hz) and F2
 *      (vowel-guided: best (F1,F2) vowel-centre fit, up to 2800 Hz)
 *   9. Two-stage smoothing: 7-frame median → exponential (α=0.4)
 *  10. Classify vowel from (F1, F2) using nearest-center matching
 *
 * Vowel → solfege mapping:
 *   ee  → Mi, Ti   (and chromatic Di, Fi)
 *   eh  → Re       (and chromatic Me, Le, Te)
 *   ah  → Fa, La
 *   oh  → Do, Sol
 */

// ── Configuration ───────────────────────────────────────────────────

const PRE_EMPHASIS = 0.97;
const ANALYSIS_WINDOW = 4096;
const DECIMATION_FACTOR = 4;
const HP_CUTOFF_HZ = 120;
const AA_TAPS = 101;
const MEDIAN_WINDOW = 7;
const CEPSTRAL_LIFTER = 20;
const SMOOTH_ALPHA = 0.4;

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

// ── Temporal smoothing state ─────────────────────────────────────────

const f1Buffer = [];
const f2Buffer = [];
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

// ── FFT / Cepstral envelope ─────────────────────────────────────────
// Radix-2 FFT replaces LPC for spectral-envelope estimation.
// Cepstral liftering cleanly separates the vocal-tract shape
// (formants) from the excitation source (harmonics), which LPC
// fundamentally cannot do when harmonics are strong.

function fft(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= N; len *= 2) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      const half = len / 2;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe; im[a] += tIm;
        const tmp = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmp;
      }
    }
  }
}

function ifft(re, im) {
  const N = re.length;
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Compute cepstrally-smoothed spectral envelope.
// 1. FFT → log magnitude → IFFT → cepstrum
// 2. Zero high-quefrency bins (harmonic fine structure)
// 3. FFT → exp → smooth magnitude envelope
// Returns N/2 bins covering 0 to Nyquist.
function computeCepstralEnvelope(signal) {
  const N = nextPow2(signal.length);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < signal.length; i++) re[i] = signal[i];

  fft(re, im);

  // Log magnitude
  for (let i = 0; i < N; i++) {
    re[i] = Math.log(Math.sqrt(re[i] * re[i] + im[i] * im[i]) + 1e-12);
    im[i] = 0;
  }

  // IFFT → cepstrum
  ifft(re, im);

  // Lifter: keep low-quefrency coefficients (spectral envelope)
  // and their symmetric counterparts; zero everything else
  for (let i = CEPSTRAL_LIFTER + 1; i < N - CEPSTRAL_LIFTER; i++) {
    re[i] = 0;
    im[i] = 0;
  }

  // FFT back → smoothed log spectrum → exponentiate
  fft(re, im);

  const halfN = Math.floor(N / 2);
  const envelope = new Float64Array(halfN);
  for (let i = 0; i < halfN; i++) envelope[i] = Math.exp(re[i]);
  return envelope;
}

// ── Formant peak detection ──────────────────────────────────────────

function findFormantPeaks(spectrum, sampleRate) {
  const binHz = (sampleRate / 2) / spectrum.length;
  const peaks = [];

  const minBin = Math.max(1, Math.floor(150 / binHz));
  const maxBin = Math.min(spectrum.length - 1, Math.ceil(3500 / binHz));
  const searchRadius = Math.ceil(150 / binHz); // ±150 Hz neighbourhood

  for (let i = minBin; i < maxBin; i++) {
    if (spectrum[i] > spectrum[i - 1] && spectrum[i] > spectrum[i + 1]) {
      // Prominence: peak must be ≥ 1.4× the local minimum within ±150 Hz.
      // Rejects small cepstral ripples that aren't true formant resonances.
      let localMin = spectrum[i];
      for (let j = Math.max(0, i - searchRadius); j <= Math.min(spectrum.length - 1, i + searchRadius); j++) {
        if (spectrum[j] < localMin) localMin = spectrum[j];
      }
      if (spectrum[i] < localMin * 1.4) continue;

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

// ── Temporal smoothing (two-stage: median → exponential) ─────────────
// Stage 1: median filter rejects outlier frames (wrong peak picked).
// Stage 2: exponential smoothing gives continuous, jitter-free output.

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

  const medF1 = medianOf(f1Buffer);
  const medF2 = medianOf(f2Buffer);

  if (smoothedF1 === null) {
    smoothedF1 = medF1;
    smoothedF2 = medF2;
  } else {
    smoothedF1 = SMOOTH_ALPHA * medF1 + (1 - SMOOTH_ALPHA) * smoothedF1;
    smoothedF2 = SMOOTH_ALPHA * medF2 + (1 - SMOOTH_ALPHA) * smoothedF2;
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

  // 4th-order high-pass → anti-alias + decimate → pre-emphasize → Hamming
  const highPassed = applyHighPass4(window, HP_CUTOFF_HZ, sampleRate);
  const decimated = antiAliasDecimate(highPassed, DECIMATION_FACTOR);
  const effectiveSampleRate = sampleRate / DECIMATION_FACTOR;
  const processed = applyHammingWindow(preEmphasize(decimated));

  // Cepstral spectral envelope → formant peaks
  const envelope = computeCepstralEnvelope(processed);
  const peaks = findFormantPeaks(envelope, effectiveSampleRate);

  // Pick F1: lowest-frequency SIGNIFICANT peak in 150–1100 Hz.
  // Must have amplitude ≥ 50% of the strongest F1 candidate,
  // so a tiny cepstral ripple can't steal F1 from the real formant.
  const f1Candidates = peaks.filter(p => p.frequency >= 150 && p.frequency <= 1100);
  if (f1Candidates.length === 0) return null;
  const maxF1Amp = Math.max(...f1Candidates.map(p => p.amplitude));
  const f1Peak = f1Candidates.find(p => p.amplitude >= maxF1Amp * 0.5) || f1Candidates[0];

  // Pick F2: vowel-guided selection.  For each candidate peak above
  // F1+200 Hz, score how well the (F1, candidate) pair matches any
  // known vowel centre.  This prevents F3 or spurious high-frequency
  // peaks from being chosen over the true F2.
  let f2Peak = null;
  let bestVowelDist = Infinity;
  for (const p of peaks) {
    if (p.frequency >= f1Peak.frequency + 200 && p.frequency <= 2800) {
      for (const v of VOWEL_CENTERS) {
        const d1 = (f1Peak.frequency - v.f1) / 300;
        const d2 = (p.frequency - v.f2) / 800;
        const dist = d1 * d1 + d2 * d2;
        if (dist < bestVowelDist) {
          bestVowelDist = dist;
          f2Peak = p;
        }
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
  smoothedF1 = null;
  smoothedF2 = null;
}
