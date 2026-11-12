interface MapPoint { x: number; z: number }

export class Hud {
  private readonly speed: HTMLElement;
  private readonly status: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly rpm: HTMLElement;
  private readonly rev: HTMLElement;
  private readonly root: HTMLElement;
  private readonly map: CanvasRenderingContext2D;
  private readonly routeColor: string;
  private readonly carColor: string;
  private readonly route: readonly MapPoint[];
  private readonly scale: number;
  private readonly offsetX: number;
  private readonly offsetZ: number;
  private readonly session: HTMLElement;
  private lastUpdate = -Infinity;

  constructor(route: readonly MapPoint[], lengthMeters: number) {
    this.route = route;
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <header class="identity"><span class="identity__rule"></span><div>
        <h1>TOUGE</h1><p>MIDNIGHT RUN</p>
      </div></header>
      <aside class="route"><div class="route__caption"><span>KUROTAKE PASS</span><span class="route__length"></span></div>
        <canvas width="176" height="176" aria-label="Route map and current car position"></canvas>
        <span class="route__session">NIGHT PRACTICE / 01</span>
      </aside>
      <div class="controls" aria-label="Keyboard controls">
        <div><kbd>W</kbd><kbd>S</kbd><span>ACCELERATE / BRAKE</span></div>
        <div><kbd>A</kbd><kbd>D</kbd><span>STEER</span></div>
        <div><kbd class="key-wide">SPACE</kbd><span>HANDBRAKE</span></div>
        <div><kbd>R</kbd><span>RESET</span></div>
      </div>
      <section class="speedometer" aria-label="Speed">
        <div class="speedometer__head"><span class="speedometer__gear" aria-label="Gear">N</span><span class="speedometer__rpm">RPM</span><span class="speedometer__status">NIGHT RUN</span></div>
        <div class="speedometer__value"><span class="speedometer__number">000</span><span class="speedometer__unit">KM/H</span></div>
        <div class="speedometer__rule" role="meter" aria-label="Engine RPM" aria-valuemin="0"><span class="speedometer__rev"></span></div>
      </section>`;
    document.body.appendChild(this.root);
    const colors = getComputedStyle(this.root);
    this.routeColor = colors.getPropertyValue('--map-route').trim();
    this.carColor = colors.getPropertyValue('--accent').trim();
    this.speed = this.root.querySelector('.speedometer__number')!;
    this.status = this.root.querySelector('.speedometer__status')!;
    this.gear = this.root.querySelector('.speedometer__gear')!;
    this.rpm = this.root.querySelector('.speedometer__rpm')!;
    this.rev = this.root.querySelector('.speedometer__rev')!;
    this.session = this.root.querySelector('.route__session')!;
    this.root.querySelector('.route__length')!.textContent = `${(lengthMeters / 1000).toFixed(2)} KM`;
    const context = this.root.querySelector('canvas')!.getContext('2d');
    if (!context) throw Error('Cannot create route map');
    this.map = context;
    const xs = route.map(point => point.x);
    const zs = route.map(point => point.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    this.scale = 136 / Math.max(maxX - minX, maxZ - minZ, 1);
    this.offsetX = 88 - ((minX + maxX) / 2) * this.scale;
    this.offsetZ = 88 - ((minZ + maxZ) / 2) * this.scale;
  }

  /** Session line under the route map. Call only when it changes. */
  setSessionLabel(text: string): void {
    this.session.textContent = text;
  }

  update(kmh: number, position: MapPoint, heading: number, handbrake: boolean, reverse: boolean,
    engine: { rpm: number; gear: number; redlineRpm: number; limiting: boolean }): void {
    const now = performance.now();
    if (now - this.lastUpdate < 80) return;
    this.lastUpdate = now;
    this.speed.textContent = Math.round(kmh).toString().padStart(3, '0');
    this.status.textContent = handbrake ? 'HANDBRAKE' : reverse ? 'REVERSE' : 'NIGHT RUN';
    this.root.classList.toggle('hud--braking', handbrake);
    this.gear.textContent = engine.gear < 0 ? 'R' : engine.gear === 0 ? 'N' : String(engine.gear);
    this.rpm.textContent = `${Math.round(engine.rpm)} RPM`;
    this.rev.parentElement!.setAttribute('aria-valuenow', String(Math.round(engine.rpm)));
    this.rev.parentElement!.setAttribute('aria-valuemax', String(engine.redlineRpm));
    this.rev.style.transform = `scaleX(${Math.min(1, engine.rpm / engine.redlineRpm).toFixed(3)})`;
    this.root.classList.toggle('hud--limit', engine.limiting);
    this.root.classList.toggle('hud--moving', kmh > 15);
    const ctx = this.map;
    ctx.clearRect(0, 0, 176, 176);
    ctx.beginPath();
    this.route.forEach((point, i) => {
      const x = point.x * this.scale + this.offsetX;
      const y = point.z * this.scale + this.offsetZ;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = this.routeColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.save();
    ctx.translate(position.x * this.scale + this.offsetX, position.z * this.scale + this.offsetZ);
    ctx.rotate(heading);
    ctx.beginPath();
    ctx.moveTo(0, -6); ctx.lineTo(4, 4); ctx.lineTo(0, 2); ctx.lineTo(-4, 4); ctx.closePath();
    ctx.fillStyle = this.carColor;
    ctx.fill();
    ctx.restore();
  }
}
