/**
 * Shared simulation constants and tuning.
 *
 * Tuning for systems that do not exist yet (track, HUD, production camera) is
 * added with those systems.
 *
 * This file has no imports on purpose: the Node tests transpile it standalone.
 *
 * Conventions used everywhere: +Y is up, a vehicle's local -Z is forward and
 * its local +X is right. Units are SI (m, kg, s, N, rad).
 */

/** Fixed simulation rate in Hz. The game loop and Rapier must agree on it. */
export const PHYSICS_HZ = 60;

/** Fixed simulation step in seconds. */
export const FIXED_DT = 1 / PHYSICS_HZ;

/** World gravity in m/s^2. */
export const GRAVITY = { x: 0, y: -9.81, z: 0 } as const;

/** Tuning for physics/RaycastVehicle.ts (and the placeholder car mesh). */
export interface VehicleTuning {
  // --- Chassis ---------------------------------------------------------------
  /** Chassis mass in kg. The centre of mass is the centre of the chassis box. */
  mass: number;
  /** Half extents of the chassis box collider. */
  chassisHalfExtents: { x: number; y: number; z: number };
  /** Rapier linear damping: a little speed-proportional drag. */
  linearDamping: number;
  /** Rapier angular damping: calms yaw, pitch and roll. */
  angularDamping: number;
  /**
   * Chassis origin at spawn/reset, unrotated. Keep it high enough that the
   * suspension rays do not reach the ground yet, so the car drops onto its
   * springs instead of starting compressed.
   */
  spawn: { x: number; y: number; z: number };

  // --- Wheel layout (chassis-local) -----------------------------------------
  wheelRadius: number;
  /** Visual only. */
  wheelWidth: number;
  /** Lateral distance from the centre line to each wheel. */
  halfTrack: number;
  /** Local z of the front axle (negative: forward is -Z). */
  frontAxleZ: number;
  /** Local z of the rear axle. */
  rearAxleZ: number;
  /** Local y of the suspension mounts, where the rays start. */
  suspensionMountY: number;

  // --- Suspension ------------------------------------------------------------
  /** Mount to wheel-centre distance with the spring unloaded. */
  suspensionRestLength: number;
  /** Spring rate per wheel, N/m. */
  suspensionStiffness: number;
  /** Damper rate per wheel, N*s/m. */
  suspensionDamping: number;
  /** Upper bound on one wheel's suspension force, N. */
  suspensionMaxForce: number;

  // --- Tires -----------------------------------------------------------------
  /** Longitudinal friction coefficient (drive and brake). */
  gripLongitudinal: number;
  /** Peak lateral friction coefficient, front wheels. */
  gripLateralFront: number;
  /** Peak lateral friction coefficient, rear wheels (a bit higher = stable). */
  gripLateralRear: number;
  /**
   * Slip angle at which a front tire's lateral force peaks, rad. Smaller =
   * sharper response and an earlier breakaway. Must be above 0.
   */
  tirePeakSlipAngleFront: number;
  /** Slip angle at which a rear tire's lateral force peaks, rad. Above 0. */
  tirePeakSlipAngleRear: number;
  /**
   * Lateral force far beyond the peak slip angle, as a fraction of the peak
   * force, 0..1. Keep it above 0 so a sliding tire still grips.
   */
  tireSlidingGrip: number;
  /**
   * Slip angles are measured against at least this rolling speed, m/s, so
   * they fade to zero at a standstill instead of jumping to 90 degrees.
   */
  slipAngleMinSpeed: number;
  /**
   * Upper bound on tire forces: the fraction of a contact's slip velocity a
   * tire may cancel per step. Below 1 because the four tires act together.
   * It keeps the tires dissipative, limits the brakes near standstill and is
   * the lateral response at low speed and tiny slip; the slip-angle curve
   * takes over wherever it asks for less.
   */
  slipResponse: number;
  /** Rolling resistance per wheel, N per m/s of rolling speed. */
  rollingDrag: number;

  // --- Drive and brakes ------------------------------------------------------
  /** Peak drive force on the rear axle, N. */
  engineForce: number;
  /** Forward speed at which the drive force has tapered to zero, m/s. */
  topSpeed: number;
  /** Peak reverse drive force on the rear axle, N. */
  reverseForce: number;
  /** Reverse speed at which the reverse force has tapered to zero, m/s. */
  reverseTopSpeed: number;
  /**
   * Below this speed against the pedal's direction, the pedal drives instead
   * of braking (S: brake -> reverse, W: brake -> forward), m/s.
   */
  directionChangeSpeed: number;
  /** Peak foot-brake force over all four wheels, N. */
  brakeForce: number;
  /** Share of the foot-brake force on the front axle, 0..1. */
  brakeFrontBias: number;
  /** Peak handbrake force on the rear axle, N. */
  handbrakeForce: number;
  /** Rear lateral grip multiplier while the handbrake is held, 0..1. */
  handbrakeRearGripScale: number;
  /**
   * Time constant in s with which rear lateral grip returns after the
   * handbrake is released: about 63 % of the missing grip is back after this
   * long, 95 % after three times as long. 0 = instantly.
   */
  handbrakeGripRecoveryTime: number;

  // --- Steering --------------------------------------------------------------
  /** Front wheel lock angle at standstill, rad. */
  maxSteerAngle: number;
  /** How fast the front wheels turn towards the requested angle, rad/s. */
  steerRate: number;
  /** Speed at which the lock angle has shrunk to highSpeedSteerScale, m/s. */
  steerSpeedRef: number;
  /** Lock angle multiplier at and above steerSpeedRef, 0..1. */
  highSpeedSteerScale: number;

  // --- Powertrain ------------------------------------------------------------
  // Arcade model: in gear the engine speed follows road speed (never below
  // idle, as if the clutch slipped). There is no wheelspin. engineForce and
  // reverseForce above stay the upper bounds on what the gearing may deliver,
  // and topSpeed / reverseTopSpeed still fade the drive force to zero.
  /** Peak crankshaft torque at full throttle, Nm. */
  enginePeakTorque: number;
  /** Engine power limit, W: torque is capped at power / angular speed. */
  enginePeakPower: number;
  /** Idle speed, rev/min. Also the lowest engine speed while in gear. */
  engineIdleRpm: number;
  /** Engine speed from which the full peak torque is available, rev/min. */
  enginePeakTorqueRpm: number;
  /** Rev limiter, rev/min: no drive torque at or above it. */
  engineRedlineRpm: number;
  /**
   * Torque at idle as a fraction of the peak, 0..1. It rises linearly to 1 at
   * enginePeakTorqueRpm. Keep it high enough for a responsive launch.
   */
  engineIdleTorqueFraction: number;
  /** Time constant in s of free revving in neutral. 0 = instantly. */
  engineRevTime: number;
  /** Forward gear ratios, first gear first, each lower than the one before. */
  gearRatios: readonly number[];
  /** Reverse gear ratio. */
  reverseGearRatio: number;
  /** Final drive ratio, multiplies every gear ratio. */
  finalDrive: number;
  /** Engine speed at which the automatic gearbox shifts up, rev/min. */
  upshiftRpm: number;
  /**
   * Engine speed at which it shifts down, rev/min. Keep it below upshiftRpm
   * times the smallest ratio step, or the gearbox hunts between two gears.
   */
  downshiftRpm: number;
  /** Torque interruption of one gear change, s. */
  shiftTime: number;
}

export const VEHICLE: VehicleTuning = {
  mass: 1200,
  chassisHalfExtents: { x: 0.96, y: 0.3, z: 2.0 },
  linearDamping: 0.02,
  angularDamping: 0.5,
  spawn: { x: -2.25, y: 0.8, z: 0 },

  wheelRadius: 0.33,
  wheelWidth: 0.22,
  halfTrack: 0.86,
  frontAxleZ: -1.25,
  rearAxleZ: 1.25,
  suspensionMountY: 0,

  suspensionRestLength: 0.3,
  suspensionStiffness: 26000,
  suspensionDamping: 3000,
  suspensionMaxForce: 20000,

  gripLongitudinal: 1.5,
  gripLateralFront: 1.05,
  gripLateralRear: 1.2,
  // The next five tire/handbrake values are tuning hypotheses until driven.
  tirePeakSlipAngleFront: 0.14,
  tirePeakSlipAngleRear: 0.12,
  tireSlidingGrip: 0.8,
  slipAngleMinSpeed: 1,
  slipResponse: 0.45,
  rollingDrag: 6,

  engineForce: 6500,
  topSpeed: 50,
  reverseForce: 4000,
  reverseTopSpeed: 10,
  directionChangeSpeed: 0.5,
  brakeForce: 12000,
  brakeFrontBias: 0.68,
  handbrakeForce: 6000,
  handbrakeRearGripScale: 0.35,
  handbrakeGripRecoveryTime: 0.15,

  maxSteerAngle: 0.55,
  steerRate: 2.5,
  steerSpeedRef: 40,
  highSpeedSteerScale: 0.2,

  // Powertrain values are tuning hypotheses until driven.
  enginePeakTorque: 340,
  enginePeakPower: 180000,
  engineIdleRpm: 900,
  enginePeakTorqueRpm: 3800,
  engineRedlineRpm: 7200,
  engineIdleTorqueFraction: 0.6,
  engineRevTime: 0.25,
  gearRatios: [3.2, 2.1, 1.5, 1.15, 0.92],
  reverseGearRatio: 3.0,
  finalDrive: 4.1,
  upshiftRpm: 6500,
  downshiftRpm: 3000,
  shiftTime: 0.18,
};

/** Tuning for render/ChaseCamera.ts. */
export const CHASE_CAMERA = {
  /** Horizontal distance behind the car, m. */
  distance: 7.5,
  /** Height above the car's origin, m. */
  height: 2.65,
  /** Height above the car's origin that the camera looks at, m. */
  lookHeight: 0.6,
  /** Offset towards the car's right, m. */
  rightOffset: 1.35,
  /** Distance ahead of the car that the camera looks at, m. */
  lookAhead: 5,
  /**
   * Response of the camera's offset around the car, 1/s. Higher = tighter.
   * It filters the offset, not the position, so speed adds no distance.
   */
  stiffness: 5,
  /** Response of the acceleration, cornering, roll and FOV effects, 1/s. */
  effectResponse: 3,
  /** Extra distance per unit of forward acceleration, m per m/s^2. */
  accelOffset: 0.08,
  /** Limit of the acceleration/braking offset in either direction, m. */
  maxAccelOffset: 1,
  /** Sideways shift per unit of yaw rate, m per rad/s. */
  cornerOffset: 0.5,
  /** Limit of the cornering shift in either direction, m. */
  maxCornerOffset: 0.6,
  /** Camera roll per unit of sideslip angle, rad per rad. */
  rollGain: 0.25,
  /** Limit of the camera roll, rad (2 degrees). */
  maxRoll: 0.0349,
  /** Vertical field of view at standstill, degrees. */
  fovMin: 63,
  /** Vertical field of view at and above fovSpeed, degrees. */
  fovMax: 72,
  /** Speed at which the field of view reaches fovMax, m/s. */
  fovSpeed: 50,
} as const;
