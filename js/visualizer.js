/**
 * PitchVisualizer renders a scrolling pitch-vs-time display on a
 * <canvas> element. It shows:
 *
 *   - Target pitch regions as semi-transparent gold bands
 *   - The singer's detected pitch as a colour-coded trail
 *   - A vertical playhead line at the current time position
 *   - Semitone grid lines for spatial reference
 *
 * The full exercise timeline is mapped to the canvas width so the
 * user can see where they are in the exercise at a glance.
 */

import { midiNoteToName } from './pitch-detector.js';

// Accuracy colour thresholds (in cents)
const EXCELLENT_THRESHOLD_CENTS = 15;
const GOOD_THRESHOLD_CENTS = 30;
const FAIR_THRESHOLD_CENTS = 50;

// Colours
const COLOR_EXCELLENT = '#4ade80';
const COLOR_GOOD = '#a3e635';
const COLOR_FAIR = '#facc15';
const COLOR_OFF = '#f87171';
const COLOR_BACKGROUND = '#1a1a1a';
const COLOR_GRID_LINE = 'rgba(255, 255, 255, 0.06)';
const COLOR_TARGET_BAND_OUTER = 'rgba(212, 175, 55, 0.10)';
const COLOR_TARGET_BAND_INNER = 'rgba(212, 175, 55, 0.22)';
const COLOR_TARGET_LINE = 'rgba(212, 175, 55, 0.65)';
const COLOR_NOTE_LABEL = 'rgba(255, 255, 255, 0.65)';
const COLOR_PLAYHEAD = 'rgba(255, 255, 255, 0.45)';

export class PitchVisualizer {
  /**
   * @param {HTMLCanvasElement} canvasElement
   */
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.exerciseSteps = [];
    this.totalDurationMs = 0;
    this.lowestMidiNote = 0;
    this.highestMidiNote = 0;
    this.pitchSamples = [];
    this.currentTimeMs = 0;
  }

  /**
   * Prepare the visualizer for a new exercise. Computes the vertical
   * range from the exercise's target pitches.
   *
   * @param {Array} steps - exercise step objects with targetMidiNote, durationMs
   */
  configureForExercise(steps) {
    this.exerciseSteps = steps;
    this.totalDurationMs = steps.reduce((sum, s) => sum + s.durationMs, 0);
    this.pitchSamples = [];
    this.currentTimeMs = 0;

    const targetMidiNotes = steps.map((s) => s.targetMidiNote);
    const minimumTarget = Math.min(...targetMidiNotes);
    const maximumTarget = Math.max(...targetMidiNotes);

    // Add margin above and below the target range
    this.lowestMidiNote = minimumTarget - 6;
    this.highestMidiNote = maximumTarget + 6;
  }

  /**
   * Record a detected pitch at a specific time.
   *
   * @param {number} timeMs - elapsed time since exercise start
   * @param {number|null} detectedMidiNote - detected pitch as MIDI note, or null if none
   */
  recordPitchSample(timeMs, detectedMidiNote) {
    this.currentTimeMs = timeMs;
    if (detectedMidiNote !== null) {
      this.pitchSamples.push({ timeMs, midiNote: detectedMidiNote });
    }
  }

  /** Update the playhead position without adding a sample. */
  updatePlayheadPosition(timeMs) {
    this.currentTimeMs = timeMs;
  }

  // ── Coordinate mapping ──────────────────────────────────────────

  /** Map a MIDI note number to a Y pixel coordinate (higher pitch = higher on screen). */
  midiNoteToYPosition(midiNote) {
    const midiRange = this.highestMidiNote - this.lowestMidiNote;
    const normalizedPosition = (midiNote - this.lowestMidiNote) / midiRange;
    return this.canvas.height * (1 - normalizedPosition);
  }

  /** Map milliseconds to an X pixel coordinate. */
  timeToXPosition(timeMs) {
    return (timeMs / this.totalDurationMs) * this.canvas.width;
  }

  /** The pixel height of one semitone in the current view. */
  get semitonePixelHeight() {
    const midiRange = this.highestMidiNote - this.lowestMidiNote;
    return this.canvas.height / midiRange;
  }

  // ── Rendering ───────────────────────────────────────────────────

  /** Redraw the entire canvas. Call this on every animation frame. */
  render() {
    const ctx = this.ctx;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    // Background
    ctx.fillStyle = COLOR_BACKGROUND;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    this.drawSemitoneGrid(ctx, canvasWidth, canvasHeight);
    this.drawTargetPitchRegions(ctx);
    this.drawDetectedPitchTrail(ctx);
    this.drawPlayhead(ctx, canvasHeight);
  }

  drawSemitoneGrid(ctx, canvasWidth, canvasHeight) {
    ctx.strokeStyle = COLOR_GRID_LINE;
    ctx.lineWidth = 1;

    for (
      let midi = Math.ceil(this.lowestMidiNote);
      midi <= Math.floor(this.highestMidiNote);
      midi++
    ) {
      const y = this.midiNoteToYPosition(midi);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvasWidth, y);
      ctx.stroke();
    }
  }

  drawTargetPitchRegions(ctx) {
    const semiHeight = this.semitonePixelHeight;
    let timeOffsetMs = 0;

    for (const step of this.exerciseSteps) {
      const xStart = this.timeToXPosition(timeOffsetMs);
      const xEnd = this.timeToXPosition(timeOffsetMs + step.durationMs);
      const regionWidth = xEnd - xStart;
      const targetY = this.midiNoteToYPosition(step.targetMidiNote);

      // Outer tolerance band (+/- 1 semitone)
      ctx.fillStyle = COLOR_TARGET_BAND_OUTER;
      ctx.fillRect(xStart, targetY - semiHeight, regionWidth, semiHeight * 2);

      // Inner tolerance band (+/- 50 cents)
      const halfSemitoneHeight = semiHeight * 0.5;
      ctx.fillStyle = COLOR_TARGET_BAND_INNER;
      ctx.fillRect(
        xStart,
        targetY - halfSemitoneHeight,
        regionWidth,
        halfSemitoneHeight * 2
      );

      // Center line at exact target pitch
      ctx.strokeStyle = COLOR_TARGET_LINE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xStart, targetY);
      ctx.lineTo(xEnd, targetY);
      ctx.stroke();

      // Solfege / note label
      if (step.solfegeLabel) {
        ctx.fillStyle = 'rgba(212, 175, 55, 0.65)';
        ctx.font = 'bold 11px monospace';
        ctx.fillText(step.solfegeLabel, xStart + 4, targetY - 8);
      } else {
        ctx.fillStyle = COLOR_NOTE_LABEL;
        ctx.font = '11px monospace';
        ctx.fillText(step.noteName, xStart + 4, targetY - 8);
      }

      timeOffsetMs += step.durationMs;
    }
  }

  drawDetectedPitchTrail(ctx) {
    if (this.pitchSamples.length < 2) return;

    ctx.lineWidth = 3;

    for (let i = 1; i < this.pitchSamples.length; i++) {
      const previousSample = this.pitchSamples[i - 1];
      const currentSample = this.pitchSamples[i];

      // Determine accuracy by comparing to the target at this time
      const centsOff = this.getCentsOffAtTime(
        currentSample.timeMs,
        currentSample.midiNote
      );
      const absoluteCents = Math.abs(centsOff);

      let trailColor;
      if (absoluteCents < EXCELLENT_THRESHOLD_CENTS) trailColor = COLOR_EXCELLENT;
      else if (absoluteCents < GOOD_THRESHOLD_CENTS) trailColor = COLOR_GOOD;
      else if (absoluteCents < FAIR_THRESHOLD_CENTS) trailColor = COLOR_FAIR;
      else trailColor = COLOR_OFF;

      ctx.strokeStyle = trailColor;
      ctx.beginPath();
      ctx.moveTo(
        this.timeToXPosition(previousSample.timeMs),
        this.midiNoteToYPosition(previousSample.midiNote)
      );
      ctx.lineTo(
        this.timeToXPosition(currentSample.timeMs),
        this.midiNoteToYPosition(currentSample.midiNote)
      );
      ctx.stroke();
    }
  }

  drawPlayhead(ctx, canvasHeight) {
    const playheadX = this.timeToXPosition(this.currentTimeMs);
    ctx.strokeStyle = COLOR_PLAYHEAD;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, canvasHeight);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * Find the target step at a given time and compute the deviation
   * in cents between the detected MIDI note and the target.
   */
  getCentsOffAtTime(timeMs, detectedMidiNote) {
    let elapsedMs = 0;
    for (const step of this.exerciseSteps) {
      if (timeMs >= elapsedMs && timeMs < elapsedMs + step.durationMs) {
        return (detectedMidiNote - step.targetMidiNote) * 100;
      }
      elapsedMs += step.durationMs;
    }
    // Past the end — compare to the last step
    const lastStep = this.exerciseSteps[this.exerciseSteps.length - 1];
    return (detectedMidiNote - lastStep.targetMidiNote) * 100;
  }
}
