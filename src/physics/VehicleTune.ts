/**
 * Development practice tuning: the editable subset of VehicleTuning with pure
 * clone / parse / apply helpers. No DOM and no runtime imports (the import
 * below is erased), so the Node tests transpile this file standalone.
 */
import type { VehicleTuning } from '../config';

/** [key, label, unit, min, max] in display units. Gear bounds are exclusive, all others inclusive. */
export const TUNE_FIELDS = [
  ['enginePeakTorque', 'PEAK ENGINE TORQUE', 'Nm', 150, 600],
  ['enginePeakPowerKw', 'ENGINE POWER LIMIT', 'kW', 80, 350],
  ['finalDrive', 'FINAL DRIVE', 'ratio', 2.5, 5.5],
  ['gear1', 'GEAR 1', 'ratio', 0.3, 6],
  ['gear2', 'GEAR 2', 'ratio', 0.3, 6],
  ['gear3', 'GEAR 3', 'ratio', 0.3, 6],
  ['gear4', 'GEAR 4', 'ratio', 0.3, 6],
  ['gear5', 'GEAR 5', 'ratio', 0.3, 6],
  ['gripLateralFront', 'FRONT LATERAL GRIP', 'mu', 0.6, 1.8],
  ['gripLateralRear', 'REAR LATERAL GRIP', 'mu', 0.6, 1.8],
  ['steerRate', 'STEERING RATE', 'rad/s', 0.8, 5],
  ['handbrakeRearGripScale', 'HANDBRAKE REAR GRIP', 'x rear grip', 0.1, 1],
  ['handbrakeGripRecoveryTime', 'HANDBRAKE GRIP RECOVERY', 's', 0.05, 0.6],
  ['suspensionStiffness', 'SPRING RATE PER WHEEL', 'N/m', 18000, 42000],
  ['mass', 'CHASSIS MASS', 'kg', 900, 1600],
  ['centerOfMassY', 'CENTRE OF MASS Y OFFSET', 'm', -0.2, 0.1],
] as const;

export type TuneKey = (typeof TUNE_FIELDS)[number][0];

/** The tunable fields in simulation units. */
export type TunePatch = Pick<VehicleTuning,
  'enginePeakTorque' | 'enginePeakPower' | 'finalDrive' | 'gripLateralFront' | 'gripLateralRear' | 'steerRate' |
  'handbrakeRearGripScale' | 'handbrakeGripRecoveryTime' | 'suspensionStiffness' | 'mass'> &
  { gearRatios: number[]; centerOfMassY: number };

export type TuneResult = { ok: true; patch: TunePatch } | { ok: false; error: string };

/** A copy deep enough that no nested object or array is shared with the source. */
export function cloneTuning(t: VehicleTuning): VehicleTuning {
  return { ...t, chassisHalfExtents: { ...t.chassisHalfExtents }, spawn: { ...t.spawn }, gearRatios: [...t.gearRatios] };
}

/** The tunable fields of t, with its own gear array. */
export function tunePatch(t: VehicleTuning): TunePatch {
  return {
    enginePeakTorque: t.enginePeakTorque, enginePeakPower: t.enginePeakPower, finalDrive: t.finalDrive,
    gearRatios: [...t.gearRatios], gripLateralFront: t.gripLateralFront, gripLateralRear: t.gripLateralRear,
    steerRate: t.steerRate, handbrakeRearGripScale: t.handbrakeRearGripScale,
    handbrakeGripRecoveryTime: t.handbrakeGripRecoveryTime, suspensionStiffness: t.suspensionStiffness,
    mass: t.mass, centerOfMassY: t.centerOfMassY ?? 0,
  };
}

/** Writes a patch into target. The gear array is copied, so the patch stays independent. */
export function applyTune(target: VehicleTuning, patch: TunePatch): void {
  Object.assign(target, patch, { gearRatios: [...patch.gearRatios] });
}

/** The tunable fields in display units (power in kW, one entry per gear). */
export function tuneDisplay(t: VehicleTuning): Record<TuneKey, number> {
  const [gear1 = NaN, gear2 = NaN, gear3 = NaN, gear4 = NaN, gear5 = NaN] = t.gearRatios;
  return {
    enginePeakTorque: t.enginePeakTorque, enginePeakPowerKw: t.enginePeakPower / 1000, finalDrive: t.finalDrive,
    gear1, gear2, gear3, gear4, gear5, gripLateralFront: t.gripLateralFront, gripLateralRear: t.gripLateralRear,
    steerRate: t.steerRate, handbrakeRearGripScale: t.handbrakeRearGripScale,
    handbrakeGripRecoveryTime: t.handbrakeGripRecoveryTime, suspensionStiffness: t.suspensionStiffness,
    mass: t.mass, centerOfMassY: t.centerOfMassY ?? 0,
  };
}

const fail = (error: string): TuneResult => ({ ok: false, error });

/**
 * Validates every display value and returns a complete patch or one error;
 * never a partial result. base supplies the untouched shift points: a gear
 * step that would land at or below the downshift speed is rejected, because
 * the gearbox would hunt.
 */
export function parseTune(raw: Readonly<Record<string, unknown>>, base: VehicleTuning): TuneResult {
  const v = {} as Record<TuneKey, number>;
  for (const [key, label, unit, min, max] of TUNE_FIELDS) {
    const text = String(raw[key] ?? '').trim();
    const n = text === '' ? NaN : Number(text);
    if (!Number.isFinite(n)) return fail(`${label}: enter a finite number.`);
    const gear = key.startsWith('gear');
    if (gear ? !(n > min && n < max) : n < min || n > max) {
      return fail(`${label}: must be ${gear ? `above ${min} and below ${max}` : `${min} to ${max}`} ${unit}.`);
    }
    v[key] = n;
  }
  const gearRatios = [v.gear1, v.gear2, v.gear3, v.gear4, v.gear5];
  let previous = Infinity;
  let index = 0;
  for (const ratio of gearRatios) {
    index++;
    if (!(ratio < previous)) return fail(`GEAR ${index}: must be lower than GEAR ${index - 1}.`);
    if (index > 1 && (ratio / previous) * base.upshiftRpm <= base.downshiftRpm) {
      return fail(`GEAR ${index}: too far below GEAR ${index - 1}; the gearbox would hunt.`);
    }
    previous = ratio;
  }
  return {
    ok: true,
    patch: {
      enginePeakTorque: v.enginePeakTorque, enginePeakPower: v.enginePeakPowerKw * 1000, finalDrive: v.finalDrive,
      gearRatios, gripLateralFront: v.gripLateralFront, gripLateralRear: v.gripLateralRear, steerRate: v.steerRate,
      handbrakeRearGripScale: v.handbrakeRearGripScale, handbrakeGripRecoveryTime: v.handbrakeGripRecoveryTime,
      suspensionStiffness: v.suspensionStiffness, mass: v.mass, centerOfMassY: v.centerOfMassY,
    },
  };
}
