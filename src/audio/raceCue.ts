/** Pure plans for the short original race tones. No Web Audio here, so they can be tested directly. */
export type RaceCueKind = 'countdown' | 'go' | 'checkpoint' | 'improved' | 'finish' | 'personalBest';
/** One tone: start offset s, frequency Hz, time until release starts s, peak level 0..1. */
export type CueTone = readonly [at: number, hz: number, hold: number, level: number];

export const CUE_ATTACK = 0.008;
export const CUE_RELEASE = 0.06;

export const RACE_CUES: Readonly<Record<RaceCueKind, readonly CueTone[]>> = {
  countdown: [[0, 700, 0.09, 0.22]],
  go: [[0, 1050, 0.34, 0.24]],
  checkpoint: [[0, 1320, 0.06, 0.18]],
  improved: [[0, 990, 0.07, 0.18], [0.14, 1485, 0.12, 0.18]],
  finish: [[0, 660, 0.09, 0.2], [0.17, 880, 0.09, 0.2], [0.34, 990, 0.24, 0.2]],
  personalBest: [[0, 740, 0.08, 0.2], [0.16, 932, 0.08, 0.2], [0.32, 1109, 0.08, 0.2], [0.48, 1480, 0.3, 0.2]],
};
