import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CHASE_CAMERA, FIXED_DT, PHYSICS_HZ, VEHICLE } from './config';
import { GameLoop } from './core/GameLoop';
import { Input } from './core/Input';
import { Car } from './entities/Car';
import { ImpactFeedback, impactThresholdForce } from './physics/ImpactFeedback';
import { NearMiss } from './physics/NearMiss';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { RaycastVehicle, type VehicleInput } from './physics/RaycastVehicle';
import { ChaseCamera } from './render/ChaseCamera';
import { DrivingEffects } from './render/DrivingEffects';
import { MangaFeedback } from './render/MangaFeedback';
import { createScene } from './render/SceneSetup';
import { loadPassAsset } from './render/loadPassAsset';
import { GameAudio } from './audio/GameAudio';
import { addAudioControls } from './ui/AudioControls';
import { Hud } from './ui/Hud';
import { RaceHud } from './ui/RaceHud';
import { DriftScore } from './race/DriftScore';
import { RACE_MUSIC, RaceSession } from './race/RaceSession';
import type { RaceState } from './race/RaceSession';
import { browserStorage, courseKey, loadBestLap, saveBestLap } from './race/RaceRecords';
import { RaceMarkers } from './world/RaceMarkers';
import { Options, loadQuality } from './ui/Options';
import { TouchControls } from './ui/TouchControls';
import { addPassColliders, readRoute } from './world/MountainPass';
import './styles.css';

async function bootstrap(): Promise<void> {
  const initialQuality = loadQuality();
  const { renderer, scene, camera, setQuality } = createScene(initialQuality);
  const loader = new GLTFLoader();
  const [physics, coupe, pass, route] = await Promise.all([
    PhysicsWorld.create(),
    loader.loadAsync('/assets/touge/coupe.glb'),
    loadPassAsset(loader),
    fetch('/assets/touge/route.json').then(async response => {
      if (!response.ok) throw Error(`Cannot load route (${response.status})`);
      return readRoute(await response.json());
    }),
  ]);
  scene.add(pass.scene);
  pass.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial && material.map) {
        material.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      }
    }
  });
  addPassColliders(pass.scene, physics.world);
  const vehicle = new RaycastVehicle(RAPIER, physics.world, VEHICLE);
  const car = new Car(vehicle, coupe.scene);
  // Tire smoke and skid marks. Null after a real unload, so the loop must use `effects?.`.
  let effects: DrivingEffects | null = new DrivingEffects(scene, vehicle, initialQuality);
  // Edge streaks, impact strokes and the near-miss word. Null after a real unload.
  let manga: MangaFeedback | null = new MangaFeedback(document, initialQuality);
  const nearMiss = new NearMiss(RAPIER, physics.world, vehicle.body, vehicle.collider, VEHICLE.chassisHalfExtents.x);
  let nearPending = false;
  // Collision feedback: contact-force events on the chassis collider only, drained every fixed step.
  const vehicleCollider = vehicle.collider;
  vehicleCollider.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
  vehicleCollider.setContactForceEventThreshold(impactThresholdForce(VEHICLE.mass, FIXED_DT));
  const vehicleHandle = vehicleCollider.handle;
  const impacts = new ImpactFeedback();
  let contactEvents: RAPIER.EventQueue | null = new RAPIER.EventQueue(true);
  const onContactForce = (event: RAPIER.TempContactForceEvent): void => {
    impacts.contact(event.collider1(), event.collider2(), vehicleHandle, event.totalForceMagnitude(), FIXED_DT, VEHICLE.mass);
  };
  window.addEventListener('pagehide', event => {
    // A page kept in the back/forward cache keeps its queue; only a real unload frees the WASM memory.
    if (event.persisted) return;
    contactEvents?.free();
    contactEvents = null;
    effects?.dispose();
    effects = null;
    manga?.dispose();
    manga = null;
  });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  scene.add(car.root);

  for (const x of [-0.54, 0.54]) {
    const light = new THREE.SpotLight(0xffe3b0, 650, 65, 0.32, 0.7, 2);
    light.position.set(x, 0.05, -2.02);
    light.target.position.set(x, -0.48, -35);
    car.root.add(light, light.target);
  }
  const brakeLight = new THREE.PointLight(0xff2417, 0.35, 3.5, 2);
  brakeLight.position.set(0, 0.1, 2.05);
  car.root.add(brakeLight);
  const tailMaterials: THREE.MeshStandardMaterial[] = [];
  car.root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial && material.name === 'TailLamp') {
        material.emissive.setHex(0xff180f);
        tailMaterials.push(material);
      }
    }
  });

  const input = new Input(window);
  const hud = new Hud(route.points, route.length);
  let touch: TouchControls | undefined;
  // Touch screens, including hybrid laptops; the keyboard keeps working.
  if (navigator.maxTouchPoints > 0 || matchMedia('(any-pointer: coarse)').matches) {
    document.body.dataset.touch = 'true';
    touch = new TouchControls(input, document, window);
  }
  const audio = new GameAudio(window, document);
  // Opening and closing both drop every hold, so nothing stays stuck across the pause.
  const options = new Options(document, initialQuality, quality => {
    setQuality(quality);
    effects?.setQuality(quality);
    manga?.setQuality(quality);
  }, open => {
    input.clearAll();
    touch?.clear();
    touch?.setDisabled(open);
    audio.setPaused(open);
  });
  addAudioControls(document, options.panel, audio);
  const controls: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const chase = new ChaseCamera(camera, CHASE_CAMERA);
  let snapCamera = true;

  // Time attack: free practice is the default; a timed run starts from the OPTIONS menu.
  const recordStore = browserStorage();
  const bestKey = courseKey('kurotake', route.length, route.points.length);
  const race = new RaceSession(route.points, route.width, VEHICLE.spawn, loadBestLap(recordStore, bestKey));
  const drift = new DriftScore();
  const raceHud = new RaceHud(document);
  const markers = new RaceMarkers(scene, race.gates, route.width);
  const SESSION_LABEL: Record<RaceState, string> = {
    practice: 'NIGHT PRACTICE / 01', countdown: 'COUNTDOWN / 01', racing: 'TIME ATTACK / 01', finished: 'RESULTS / 01',
  };
  let shownState: RaceState | null = null;
  /** Drains race events to HUD, audio and storage, then mirrors a state change to music and the session label. */
  const pump = (): void => {
    for (const event of race.drainEvents()) {
      raceHud.handleEvent(event);
      switch (event.type) {
        case 'countdown': audio.raceCue('countdown'); break;
        case 'go': audio.raceCue('go'); break;
        case 'checkpoint': audio.raceCue(event.delta !== null && event.delta < 0 ? 'improved' : 'checkpoint'); break;
        case 'finish': drift.stop(); audio.raceCue(event.personalBest ? 'personalBest' : 'finish'); break;
        case 'personalBest': saveBestLap(recordStore, bestKey, race.best); break;
        default: break;
      }
    }
    if (race.state !== shownState) {
      shownState = race.state;
      audio.setMusicState(RACE_MUSIC[shownState]);
      hud.setSessionLabel(SESSION_LABEL[shownState]);
    }
  };
  const resetRun = (): void => { car.reset(); snapCamera = true; impacts.reset(); drift.reset(); effects?.reset(); manga?.reset(); nearMiss.reset(); nearPending = false; };
  /** R or FREE PRACTICE: drops the current lap, keeps the best. Held keys are left as they are. */
  const toPractice = (): void => {
    resetRun();
    race.cancel(vehicle.body.translation());
    pump();
  };
  const menuButton = (text: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.style.minHeight = '48px';
    button.addEventListener('click', onClick);
    return button;
  };
  options.panel.prepend(
    menuButton('START TIME ATTACK', () => {
      input.clearAll();
      touch?.clear();
      resetRun();
      options.root.open = false;
      // The toggle event arrives later; unpause now so the first countdown beep is scheduled, not dropped.
      audio.setPaused(false);
      race.start(vehicle.body.translation());
      pump();
    }),
    menuButton('FREE PRACTICE', () => {
      input.clearAll();
      touch?.clear();
      toPractice();
      options.root.open = false;
    }),
  );
  pump();

  // Compile even currently invisible smoke/skid materials before the first driving frame.
  await renderer.compileAsync(scene, camera);

  document.body.dataset.ready = 'true';
  const loop = new GameLoop({
    fixedUpdate: dt => {
      // Paused: no forces and no world step. Both interpolation endpoints become the current pose.
      if (options.isOpen) { input.clearAll(); car.savePreviousPose(); return; }
      if (input.consumeReset()) toPractice();
      const phase = race.state;
      if (phase === 'practice' || phase === 'racing') {
        controls.throttle = input.isHeld('KeyW') ? 1 : 0;
        controls.brake = input.isHeld('KeyS') ? 1 : 0;
        controls.steer = Number(input.isHeld('KeyD')) - Number(input.isHeld('KeyA'));
        controls.handbrake = input.isHeld('Space');
      } else {
        // Countdown: neutral while the world still steps. Finished: foot brake to a stop without engaging reverse.
        controls.throttle = 0;
        controls.steer = 0;
        controls.handbrake = false;
        controls.brake = phase === 'finished' && vehicle.forwardSpeed > 0.5 ? 1 : 0;
      }
      car.savePreviousPose();
      vehicle.update(controls, dt);
      impacts.step(dt);
      const queue = contactEvents;
      if (queue) {
        physics.step(queue);
        queue.drainContactForceEvents(onContactForce);
      } else physics.step();
      car.readPhysicsPose();
      effects?.fixedUpdate(dt);
      race.update(dt, vehicle.body.translation());
      const after = race.state;
      if (after === 'practice' || after === 'racing') {
        // Chassis-local velocity: forward is local -Z, right is local +X.
        const q = vehicle.body.rotation(), v = vehicle.body.linvel();
        const forward = -(v.x * 2 * (q.x * q.z + q.w * q.y) + v.y * 2 * (q.y * q.z - q.w * q.x) + v.z * (1 - 2 * (q.x * q.x + q.y * q.y)));
        const side = v.x * (1 - 2 * (q.y * q.y + q.z * q.z)) + v.y * 2 * (q.x * q.y + q.w * q.z) + v.z * 2 * (q.x * q.z - q.w * q.y);
        const wheels = vehicle.wheels;
        let loaded = 0, rearSlip = 0;
        for (let i = 0; i < wheels.length; i++) {
          const wheel = wheels[i]!;
          if (!wheel.grounded || !(wheel.load > 100)) continue;
          loaded++;
          // Assumes wheel order FL, FR, RL, RR.
          if (i >= 2) rearSlip = Math.max(rearSlip, Math.abs(wheel.slipSpeed));
        }
        drift.update(dt, forward, side, loaded, rearSlip);
        if (nearMiss.update(dt, loaded)) nearPending = true;
      }
      pump();
    },
    render: (alpha, frameDt) => {
      car.render(alpha);
      const velocity = vehicle.body.linvel();
      const impact = impacts.consume();
      if (impact > 0) {
        if (!reducedMotion.matches) chase.impact(impact);
        audio.impact(impact);
        manga?.impact(impact);
      }
      // A near miss in the same frame as a real impact is dropped; the flag never outlives one frame.
      if (nearPending && !(impact > 0)) { manga?.nearMiss(); audio.nearMiss(); }
      nearPending = false;
      chase.update(car.root, velocity, vehicle.body.angvel().y, frameDt, snapCamera);
      snapCamera = false;
      const braking = controls.brake > 0 || controls.handbrake;
      brakeLight.intensity = braking ? 1.2 : 0.35;
      for (const material of tailMaterials) material.emissiveIntensity = braking ? 2.8 : 0.8;
      effects?.render(options.isOpen ? 1 : alpha, renderer.domElement.height);
      renderer.render(scene, camera);
      manga?.render(frameDt, Math.hypot(velocity.x, velocity.z), options.isOpen);
      hud.update(Math.hypot(velocity.x, velocity.z) * 3.6, car.root.position,
        Math.atan2(chase.forward.x, -chase.forward.z), controls.handbrake, vehicle.forwardSpeed < -0.5, vehicle.engine);
      audio.update(vehicle.engine, vehicle.wheels, Math.hypot(velocity.x, velocity.z),
        vehicle.engine.gear < 0 ? controls.brake : controls.throttle, controls.handbrake);
      raceHud.render(race, drift, frameDt, options.isOpen);
      markers.update(race.state, race.checkpoint);
    },
  }, { fixedHz: PHYSICS_HZ });
  loop.start();
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  const loading = document.querySelector('#loading span');
  if (loading) loading.textContent = `Could not load the pass. ${String(error)}`;
});
