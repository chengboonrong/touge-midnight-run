# Guardrail scrape

A sustained scrape sound while the chassis slides along a guardrail. It is a temporary, original synthesized layer: the shared seeded noise buffer through one band-pass filter. No audio asset is used.

## Signal

`src/physics/GuardrailScrape.ts` runs once per fixed step, after the world step. It reads the chassis contact pairs and looks only at colliders made from the `Guardrails` collision mesh. `addPassColliders` reports each created collider and its mesh name through an optional third callback, and `main.ts` keeps the `Guardrails` handles in a set.

A contact manifold counts only if all of these hold:

- it has solver contacts (a broad-phase candidate alone is not a contact);
- its normal is not road-like (`|normal.y| <= 0.4`);
- the summed positive normal impulse is above zero;
- the chassis contact point slides along the surface faster than 2 m/s.

The level is `speed01 * sqrt(pressure01)` for the strongest manifold:

- `speed01` rises linearly from 2 m/s to 15 m/s of sliding speed;
- `pressure01` is `impulse / (body.mass() * dt)` in m/s^2, divided by 6 and capped at 1.

The detector applies no forces and has no timers. The level is 0 on the first step without a real sliding contact, and after `reset()`.

## Sound

`GameAudio.update` takes the level as an optional sixth argument (default 0). It drives one gain, at most 0.12 linear, at the existing 30 Hz throttle with a 0.04 s time constant. The branch goes through the SFX master, so mute and SFX volume apply. Pause and a hidden page zero the branch at once.

## Verification and remaining checks

- Manual mix check in the browser: level against tire and engine, filter frequency and Q.
- Gameplay tuning of the constants in `GUARDRAIL_SCRAPE` against real rail contacts on the pass.
- Physical hidden-tab/mobile behavior still needs a device check.

Typecheck, all233 tests and the production build pass. Native tests include the
actual exported Guardrails GLB collider: sliding contact produces level0.615,
while a broad-phase-only candidate produces0. Light/heavy bodies pushed at the
same acceleration produce the same level. Detector reads never change the body.

Chrome normal W then W+A driving produced real scrape level up to1 across76
initial positive render frames, with a nonzero actual scrape gain. The graph
stayed at14 gains/6 filters/5 oscillators/5 noise sources/2 media sources over
111s, including later contacts and reset. Reset/contact end returned the level
to0; Options immediately zeroed its gain. Global mute produced RMS0/peak0, and
the prior unmuted preference was restored. Console was clear. Human mix quality
and physical-phone/background behavior remain manual; the above does not claim
professional recorded engine or scrape assets.

The pass's ray-hit corrugation has |normal.y|0.581. A separate GLB regression
exposed NearMiss's old0.4 cutoff; its steep-face cutoff is now0.8, with a shallow
road-slope rejection regression. Actual driving then produced one CLOSE CALL at
93.55km/h, four loaded wheels, two broad-phase pairs and zero solver contacts.
See [evidence](evidence/near-miss.json) and [image](evidence/validated-near-miss.png).
