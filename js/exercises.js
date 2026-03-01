/**
 * Vocal warmup exercise definitions.
 *
 * Each exercise generates a sequence of "steps" — target pitches with
 * durations — based on a starting MIDI note determined by voice type.
 *
 * These are standard, widely-used vocal warmup patterns drawn from
 * classical and choral training traditions.
 */

import { midiNoteToFrequency, midiNoteToName } from './pitch-detector.js';

// ── Voice type configuration ─────────────────────────────────────────

/**
 * Comfortable low starting notes for each voice type.
 * Exercises build upward from these notes.
 */
export const VOICE_TYPE_BASE_NOTES = {
  soprano: 60, // C4
  alto: 55, // G3
  tenor: 48, // C3
  bass: 45, // A2
};

// ── Helper ───────────────────────────────────────────────────────────

function buildDiscreteSteps(baseMidiNote, semitoneIntervals, noteDurationMs) {
  return semitoneIntervals.map((interval) => {
    const midiNote = baseMidiNote + interval;
    return {
      targetMidiNote: midiNote,
      targetFrequency: midiNoteToFrequency(midiNote),
      noteName: midiNoteToName(midiNote),
      durationMs: noteDurationMs,
    };
  });
}

// ── Exercise definitions ─────────────────────────────────────────────

export const WARMUP_EXERCISES = [
  {
    id: 'sustained-tone',
    name: 'Sustained Tone',
    description:
      'Hold a single pitch as steadily as you can for 6 seconds. ' +
      'This is about breath support and pitch stability — the foundation of everything else.',
    isContinuous: false,
    evaluationMetrics: ['pitch_accuracy', 'pitch_stability'],

    createSteps(baseMidiNote) {
      const targetNote = baseMidiNote + 4; // major 3rd above base
      return [
        {
          targetMidiNote: targetNote,
          targetFrequency: midiNoteToFrequency(targetNote),
          noteName: midiNoteToName(targetNote),
          durationMs: 6000,
        },
      ];
    },
  },

  {
    id: 'five-tone-scale',
    name: 'Five-Tone Scale',
    description:
      'Do-Re-Mi-Fa-Sol-Fa-Mi-Re-Do. The single most common vocal warmup. ' +
      'Sing each note clearly before moving to the next.',
    isContinuous: false,
    evaluationMetrics: ['pitch_accuracy'],

    createSteps(baseMidiNote) {
      //                Do  Re  Mi  Fa  Sol Fa  Mi  Re  Do
      const intervals = [0, 2, 4, 5, 7, 5, 4, 2, 0];
      return buildDiscreteSteps(baseMidiNote, intervals, 1800);
    },
  },

  {
    id: 'major-arpeggio',
    name: 'Major Arpeggio',
    description:
      'Root-3rd-5th-Octave and back down (1-3-5-8-5-3-1). ' +
      'The wider intervals will expose any accuracy problems — that is the point.',
    isContinuous: false,
    evaluationMetrics: ['pitch_accuracy'],

    createSteps(baseMidiNote) {
      const intervals = [0, 4, 7, 12, 7, 4, 0];
      return buildDiscreteSteps(baseMidiNote, intervals, 2000);
    },
  },

  {
    id: 'octave-siren',
    name: 'Octave Siren',
    description:
      'Slide smoothly from a note up one octave, then back down. ' +
      'Do not jump between notes — glide continuously. This opens up your range.',
    isContinuous: true,
    evaluationMetrics: ['pitch_accuracy'],

    createSteps(baseMidiNote) {
      const totalDurationMs = 8000;
      const numberOfSlices = 40;
      const sliceDurationMs = totalDurationMs / numberOfSlices;
      const steps = [];

      for (let i = 0; i < numberOfSlices; i++) {
        const progress = i / (numberOfSlices - 1);
        // Ascend for the first half, descend for the second half
        const semitoneOffset =
          progress <= 0.5 ? progress * 24 : (1 - progress) * 24;
        const midiNote = baseMidiNote + semitoneOffset;

        steps.push({
          targetMidiNote: midiNote,
          targetFrequency: midiNoteToFrequency(midiNote),
          noteName: midiNoteToName(Math.round(midiNote)),
          durationMs: sliceDurationMs,
        });
      }

      return steps;
    },
  },

  {
    id: 'triad-pattern',
    name: '1-3-5-3-1 Triad',
    description:
      'A quick triad pattern used in virtually every choral rehearsal. ' +
      'Keep each note distinct and centred.',
    isContinuous: false,
    evaluationMetrics: ['pitch_accuracy'],

    createSteps(baseMidiNote) {
      const intervals = [0, 4, 7, 4, 0];
      return buildDiscreteSteps(baseMidiNote, intervals, 1500);
    },
  },

  {
    id: 'messa-di-voce',
    name: 'Messa di Voce',
    description:
      'Hold one note for 8 seconds. Start softly, crescendo to full ' +
      'volume at the midpoint, then decrescendo back to soft. ' +
      'The challenge is keeping your pitch steady as your volume changes.',
    isContinuous: false,
    evaluationMetrics: ['pitch_accuracy', 'pitch_stability', 'volume_control'],

    createSteps(baseMidiNote) {
      const targetNote = baseMidiNote + 7; // a 5th above base
      return [
        {
          targetMidiNote: targetNote,
          targetFrequency: midiNoteToFrequency(targetNote),
          noteName: midiNoteToName(targetNote),
          durationMs: 8000,
          volumeShape: 'crescendo-decrescendo',
        },
      ];
    },
  },
];
