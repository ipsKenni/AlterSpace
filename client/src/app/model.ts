// Datenmodelle: Sterne, Planeten, Monde, Schiffe
//
// Best Practices:
// - Reine Datenklassen ohne DOM- oder Renderlogik
// - Methoden kapseln zusammengehörige Funktionalität

import { Vec2 } from '../core/math.ts';
import { ValueNoise2D } from '../core/noise.ts';
import { PRNG } from '../core/prng.ts';
import { PlanetNameGen } from '../core/names.ts';

export type PlanetType = 'Gesteinsplanet' | 'Gasriese' | 'Eisplanet' | 'Ozeanplanet';

export interface Moon {
  r: number;
  dist: number;
  ang: number;
  speed: number;
  index: number;
  id: string;
}

export interface CityDot {
  lat: number;
  lon: number;
  size: number;
  phase: number;
}

export class Star {
  readonly pos: Vec2;
  readonly size: number;
  readonly color: string;
  readonly planets: Planet[] = [];

  type: string = '';
  lum = 1;
  radiusSolar = 1;
  systemExtent = 0;
  starSpacing = 0;
  ix = 0;
  iy = 0;
  index = 0;
  id = '';

  constructor(pos: Vec2, size: number, color: string) {
    this.pos = pos;
    this.size = size;
    this.color = color;
  }
}

export class Planet {
  readonly pos: Vec2;
  readonly radius: number;
  readonly seed: string;
  readonly moons: Moon[] = [];

  rot = 0;
  userSpin = 0;
  userSpinVel = 0;

  star?: Star;
  starIx = 0;
  starIy = 0;
  starIndex = 0;
  index = 0;
  id = '';

  orbitCenter?: Vec2;
  orbitRadius = 0;
  orbitAngle = 0;
  orbitSpeed = 0;

  name = '';
  type: PlanetType = 'Gesteinsplanet';
  mass = 0;
  gravity = 0;
  temperature = 0;
  dayLength = 0;
  axialTilt = 0;
  atmosphere = '';
  hasRings = false;

  private readonly noise: ValueNoise2D;
  private readonly cityPRNG: PRNG;
  private cityCache: CityDot[] | null = null;
  private texture: HTMLCanvasElement | null = null;
  private lastSize = 0;

  constructor(pos: Vec2, radius: number, seed: string) {
    this.pos = pos;
    this.radius = radius;
    this.seed = seed;
    this.noise = new ValueNoise2D(`planet-${seed}`);
    this.cityPRNG = new PRNG(`city-${seed}`);
    this.initAttributes();
  }

  private initAttributes(): void {
    const rng = new PRNG(`attrs-${this.seed}`);
    const types: PlanetType[] = ['Gesteinsplanet', 'Gasriese', 'Eisplanet', 'Ozeanplanet'];
    this.type = types[Math.floor(rng.float() * types.length)] ?? 'Gesteinsplanet';
    switch (this.type) {
      case 'Gasriese':
        this.mass = rng.float(30, 300);
        this.gravity = rng.float(10, 35);
        this.temperature = rng.float(60, 160) + rng.float(0, 200);
        this.dayLength = rng.float(8, 20);
        this.axialTilt = rng.float(0, 10);
        this.atmosphere = 'H/He, Spuren CH4';
        this.hasRings = rng.bool(0.35);
        break;
      case 'Eisplanet':
        this.mass = rng.float(0.1, 5);
        this.gravity = rng.float(2, 12);
        this.temperature = rng.float(30, 120);
        this.dayLength = rng.float(10, 60);
        this.axialTilt = rng.float(0, 45);
        this.atmosphere = rng.bool(0.7) ? 'Dünn (N2/CO2)' : 'Keine';
        this.hasRings = rng.bool(0.1);
        break;
      case 'Ozeanplanet':
        this.mass = rng.float(0.5, 8);
        this.gravity = rng.float(5, 14);
        this.temperature = rng.float(250, 320);
        this.dayLength = rng.float(14, 40);
        this.axialTilt = rng.float(0, 35);
        this.atmosphere = 'N2/O2, hohe Feuchte';
        this.hasRings = rng.bool(0.05);
        break;
      default:
        this.mass = rng.float(0.3, 12);
        this.gravity = rng.float(4, 18);
        this.temperature = rng.float(180, 350);
        this.dayLength = rng.float(12, 48);
        this.axialTilt = rng.float(0, 35);
        this.atmosphere = rng.bool(0.8) ? 'N2/O2' : 'Dünn (CO2)';
        this.hasRings = rng.bool(0.05);
        break;
    }
    this.name = PlanetNameGen.generate(`p-${this.seed}`);
  }

  getTexture(size: number): HTMLCanvasElement {
    this.ensureTexture(size);
    if (!this.texture) {
      throw new Error('Planet texture generation failed');
    }
    return this.texture;
  }

  ensureCities(): CityDot[] {
    if (this.cityCache) {
      return this.cityCache;
    }
    const dots: CityDot[] = [];
    const n = 60 + this.cityPRNG.int(0, 180);
    for (let i = 0; i < n; i += 1) {
      const lat = this.cityPRNG.float(-Math.PI / 2, Math.PI / 2);
      const lon = this.cityPRNG.float(-Math.PI, Math.PI);
      const size = this.cityPRNG.float(0.4, 1.8);
      dots.push({ lat, lon, size, phase: this.cityPRNG.float(0, Math.PI * 2) });
    }
    this.cityCache = dots;
    return dots;
  }

  private ensureTexture(size: number): void {
    const resolvedSize = Math.max(64, Math.min(4096, Math.floor(size)));
    if (this.texture && this.lastSize === resolvedSize) {
      return;
    }
    this.lastSize = resolvedSize;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = resolvedSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D context unavailable for planet texture');
    }
    const prng = new PRNG(`palette-${this.seed}`);
    const oceans = `hsl(${prng.int(180, 210)}, ${prng.int(40, 70)}%, ${prng.int(25, 45)}%)`;
    const land = `hsl(${prng.int(40, 140)}, ${prng.int(30, 65)}%, ${prng.int(35, 60)}%)`;
    const img = ctx.createImageData(resolvedSize, resolvedSize);
    const data = img.data;
    const scale = 3;
    for (let y = 0; y < resolvedSize; y += 1) {
      for (let x = 0; x < resolvedSize; x += 1) {
        const nx = (x / resolvedSize - 0.5) * scale;
        const ny = (y / resolvedSize - 0.5) * scale;
        const e = this.noise.fbm(nx + 1.3, ny - 0.7, 5, 2.1, 0.55) - 0.08 + 0.12 * Math.sin(nx * 1.7) + 0.08 * Math.cos(ny * 1.3);
        const isLand = e > 0.0;
        const color = isLand ? land : oceans;
        const match = /hsl\((\d+),\s*(\d+)%\,\s*(\d+)%\)/.exec(color);
        const h = match ? Number(match[1]) : 0;
        const s = match ? Number(match[2]) / 100 : 0;
        let l = match ? Number(match[3]) / 100 : 0;
        const shade = 0.15 * (y / resolvedSize - 0.5);
        const hT = this.noise.fbm(nx * 3.2, ny * 3.2, 5, 2.1, 0.5);
        const ridge = 1 - Math.abs(this.noise.noise(nx * 5.0, ny * 5.0) - 0.5) * 2;
        const micro = isLand ? 0.6 * hT + 0.4 * ridge : 0.2 * hT;
        l = Math.min(1, Math.max(0, l - shade + (isLand ? (micro - 0.5) * 0.18 : (micro - 0.5) * 0.08)));
        const c1 = (1 - Math.abs(2 * l - 1)) * s;
        const x1 = c1 * (1 - Math.abs(((h / 60) % 2) - 1));
        const m1 = l - c1 / 2;
        let r = 0;
        let g = 0;
        let b = 0;
        if (h < 60) {
          r = c1;
          g = x1;
        } else if (h < 120) {
          r = x1;
          g = c1;
        } else if (h < 180) {
          g = c1;
          b = x1;
        } else if (h < 240) {
          g = x1;
          b = c1;
        } else if (h < 300) {
          r = x1;
          b = c1;
        } else {
          r = c1;
          b = x1;
        }
        r += m1;
        g += m1;
        b += m1;
        const i = (y * resolvedSize + x) * 4;
        data[i] = Math.round(r * 255);
        data[i + 1] = Math.round(g * 255);
        data[i + 2] = Math.round(b * 255);
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const grad = ctx.createRadialGradient(resolvedSize / 2, resolvedSize / 2, resolvedSize * 0.35, resolvedSize / 2, resolvedSize / 2, resolvedSize * 0.52);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(160,220,255,0.25)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(resolvedSize / 2, resolvedSize / 2, resolvedSize * 0.5, 0, Math.PI * 2);
    ctx.fill();
    this.texture = canvas;
  }
}

export interface ShipLike {
  pos: Vec2;
  target: Vec2;
  speed: number;
  phase: number;
  isPlayer: boolean;
}

export class Ship implements ShipLike {
  readonly pos: Vec2;
  target: Vec2;
  speed = 120;
  phase = Math.random() * Math.PI * 2;
  isPlayer = false;

  constructor(pos: Vec2, target: Vec2) {
    this.pos = pos.clone();
    this.target = target.clone();
  }

  update(dt: number): void {
    const to = Vec2.sub(this.target, this.pos);
    const distance = to.len();
    if (distance < 8) {
      this.target = Vec2.add(this.target, Vec2.fromPolar(800 + Math.random() * 1200, Math.random() * Math.PI * 2));
      return;
    }
    to.norm();
    this.pos.add(to.scale(this.speed * dt));
    this.phase += dt;
  }
}

export class PlayerShip extends Ship {
  constructor(pos: Vec2) {
    super(pos, pos.clone());
    this.isPlayer = true;
  }

  override update(dt: number): void {
    const to = Vec2.sub(this.target, this.pos);
    const distance = to.len();
    if (distance < 2) {
      return;
    }
    to.norm();
    this.pos.add(to.scale(this.speed * dt));
    this.phase += dt;
  }
}
