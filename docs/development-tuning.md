# Development tuning

A practice-only tuning panel for development builds (`import.meta.env.DEV`). It is not created in production builds.

## Use

OPTIONS -> DEVELOPMENT TUNING. Edit the numeric fields, then:

- APPLY & RESET PRACTICE validates every field together. One invalid field (not a finite number, out of range, gears not strictly descending, or a gear step that would make the gearbox hunt) shows an error and changes nothing. A valid set is applied, any race is cancelled and the car resets into practice. Options stays open (paused) so you can iterate.
- RESTORE STOCK writes the stock values back and resets practice.
- START TIME ATTACK always restores stock values and mass properties before the countdown, and the panel shows stock again. Custom tuning therefore never affects a personal best. R and FREE PRACTICE keep the current tuning.

Nothing is saved: tuning lasts for the page session only.

## Fields

| Field | Unit | Range |
| --- | --- | --- |
| Peak engine torque | Nm | 150 to 600 |
| Engine power limit | kW (stored as W) | 80 to 350 |
| Final drive | ratio | 2.5 to 5.5 |
| Gears 1 to 5 | ratio | above 0.3, below 6, strictly descending |
| Front / rear lateral grip | friction coefficient | 0.6 to 1.8 |
| Steering rate | rad/s | 0.8 to 5 |
| Handbrake rear grip | multiplier on rear lateral grip | 0.1 to 1 |
| Handbrake grip recovery | s | 0.05 to 0.6 |
| Spring rate per wheel | N/m | 18000 to 42000 |
| Chassis mass | kg | 900 to 1600 |
| Centre of mass Y offset | m from the chassis box centre | -0.2 to 0.1 |

Wheel layout, damping, idle and redline are not editable, to avoid model discontinuities.

## Physics notes and tradeoffs

- Force formulas and stock values are unchanged. `VEHICLE` is never mutated; the game drives a session copy.
- Mass and centre of mass are real Rapier mass properties, set by `RaycastVehicle.applyMassProperties()` at construction and on apply, not per step. The inertia is that of a uniform box with the chassis half extents, prescribed about the shifted centre of mass. It is not computed from the render model.
- At stock (offset 0) this is intended to equal the previous `collider.setMass` result; any difference is float rounding only.
- The drive force is still capped by `engineForce` and faded by `topSpeed`, so more torque or shorter gearing may show little gain in low gears.
- The damper rate is fixed, so a much stiffer or softer spring changes the damping ratio. Mass also scales the low-speed tire force cap and the impact threshold.
- There is no drift-assist or yaw control: only the physical parameters above.

## Verification status

Automated: `test/vehicle-tune.test.mjs` covers the parse/validate/clone helpers and real Rapier 0.14 mass, centre of mass and impulse response. Typecheck and the production build pass;218 tests pass including the host-added mass/COM/spring range-corner acceleration/braking test. Native stock inertia matches the old setMass-only body;1500kg responds to1200Ns with0.8m/s immediately.

Chrome checks:

- [ ] Panel appears under Options in `npm run dev` and is absent from a production build.
- [x] At320x480 all16 inputs are280x48px, inside the viewport; both bottom actions can be reached by scrolling.
- [x] Mass1700 with torque400 shows an error; the actual body stays1200kg/340Nm and its mass-property apply count stays1.
- [x] Applying from title updates the actual body to1500kg/COM -0.15m/400Nm, resets Practice, and keeps Options open.
- [ ] Human judgment of roll/pitch/drift at different settings. Native range corners settle supported, accelerate, brake below1m/s and remain upright.
- [x] START TIME ATTACK restores actual1200kg/COM0/340Nm and the panel shows stock during the neutral countdown.
- [x] RESTORE STOCK shows stock values and cancels to Practice.
