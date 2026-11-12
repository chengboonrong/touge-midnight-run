import * as THREE from 'three';
import type { RaceGate, RaceState } from '../race/RaceSession';

/** Painted gates and small roadside boards; visual only, with shared geometry and no shadows. */
export class RaceMarkers {
  private readonly root = new THREE.Group();
  private readonly post = new THREE.BoxGeometry(0.07, 1.1, 0.07);
  private readonly board = new THREE.PlaneGeometry(0.65, 0.8);
  private readonly stripe: THREE.PlaneGeometry;
  private readonly postMaterial = new THREE.MeshBasicMaterial({ color: 0x62716e });
  private readonly lines: THREE.MeshBasicMaterial[] = [];
  private readonly signs: THREE.MeshBasicMaterial[] = [];
  private readonly textures: THREE.CanvasTexture[] = [];
  private state: RaceState | null = null;
  private next = -1;

  constructor(scene: THREE.Scene, gates: readonly RaceGate[], width: number) {
    this.root.name = 'RaceMarkers';
    this.stripe = new THREE.PlaneGeometry(width, 0.4);
    gates.forEach((gate, index) => {
      const finish = index === gates.length - 1;
      const group = new THREE.Group();
      group.position.set(gate.x, gate.y + 0.018, gate.z);
      group.rotation.y = Math.atan2(-gate.tx, -gate.tz);
      const lineMaterial = new THREE.MeshBasicMaterial({
        color: finish ? 0xe5e7dd : 0xed5b46, transparent: true, opacity: 0.45,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      });
      this.lines.push(lineMaterial);
      const line = new THREE.Mesh(this.stripe, lineMaterial);
      line.rotation.x = -Math.PI / 2;
      group.add(line);

      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 160;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('Cannot create race marker');
      ctx.fillStyle = '#0a1217'; ctx.fillRect(0, 0, 128, 160);
      ctx.fillStyle = '#ed5b46'; ctx.fillRect(0, 0, 128, 9);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e5e7dd'; ctx.font = 'bold 52px Arial';
      ctx.fillText(finish ? 'S/F' : String(index + 1).padStart(2, '0'), 64, 67);
      ctx.font = '12px Arial'; ctx.fillText(finish ? 'KUROTAKE' : 'CHECKPOINT', 64, 129);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      this.textures.push(texture);
      const signMaterial = new THREE.MeshBasicMaterial({ map: texture });
      this.signs.push(signMaterial);
      for (const side of [-1, 1]) {
        const x = side * (width / 2 + 1.1);
        const post = new THREE.Mesh(this.post, this.postMaterial);
        post.position.set(x, 0.55, 0);
        const board = new THREE.Mesh(this.board, signMaterial);
        board.position.set(x, 1.0, 0.04);
        group.add(post, board);
      }
      this.root.add(group);
    });
    scene.add(this.root);
  }

  update(state: RaceState, nextCheckpoint: number): void {
    if (state === this.state && nextCheckpoint === this.next) return;
    this.state = state; this.next = nextCheckpoint;
    const timed = state === 'countdown' || state === 'racing';
    for (let i = 0; i < this.lines.length; i++) {
      const active = timed && i === nextCheckpoint;
      this.lines[i].opacity = active ? 0.95 : timed && i < nextCheckpoint ? 0.2 : 0.45;
      this.signs[i].color.setHex(active ? 0xffffff : 0xb0b8b5);
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.post.dispose(); this.board.dispose(); this.stripe.dispose(); this.postMaterial.dispose();
    for (const material of this.lines) material.dispose();
    for (const material of this.signs) material.dispose();
    for (const texture of this.textures) texture.dispose();
  }
}
