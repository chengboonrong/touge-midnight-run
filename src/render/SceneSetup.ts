import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export function createScene(): {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
} {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15252d);
  scene.fog = new THREE.FogExp2(0x15252d, 0.009);
  scene.add(new THREE.HemisphereLight(0x9fb6c1, 0x25271f, 0.3));

  const moon = new THREE.DirectionalLight(0xb6ccd7, 0.65);
  moon.position.set(-90, 170, 80);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  Object.assign(moon.shadow.camera, { left: -190, right: 190, top: 190, bottom: -190, near: 1, far: 450 });
  moon.shadow.normalBias = 0.025;
  moon.shadow.bias = -0.0001;
  scene.add(moon);

  const generator = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = generator.fromScene(room, 0.035).texture;
  scene.environmentIntensity = 0.23;
  room.dispose();
  generator.dispose();

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1000, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        zenith: { value: new THREE.Color(0x081217) },
        horizon: { value: new THREE.Color(0x1b2d36) },
      },
      vertexShader: 'varying vec3 vSky; void main(){vSky=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `
        uniform vec3 zenith; uniform vec3 horizon; varying vec3 vSky;
        void main(){
          float height=pow(max(normalize(vSky).y,0.0),0.45);
          gl_FragColor=vec4(mix(horizon,zenith,height),1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -1;
  scene.add(sky);

  const camera = new THREE.PerspectiveCamera(63, window.innerWidth / window.innerHeight, 0.1, 1400);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  return { renderer, scene, camera };
}
