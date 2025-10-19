// Datenmodelle: Sterne, Planeten, Monde, Schiffe
//
// Best Practices:
// - Reine Datenklassen ohne DOM- oder Renderlogik
// - Methoden kapseln zusammengehörige Funktionalität

import { Vec2 } from '../core/math.js';
import { ValueNoise2D } from '../core/noise.js';
import { PRNG } from '../core/prng.js';
import { PlanetNameGen } from '../core/names.js';

export class Star {
  constructor(pos, size, color) {
    this.pos = pos;
    this.size = size;
    this.color = color;
    this.planets = [];
  }
}

export class Planet {
  constructor(pos, radius, seed) {
    this.pos = pos;
    this.radius = radius;
    this.seed = seed;
    this.moons = [];
    this.rot = 0;
    this.userSpin = 0;
    this._tex = null;
    this._lastSize = 0;
    this._noise = new ValueNoise2D('planet-' + seed);
    this._cityPRNG = new PRNG('city-' + seed);
    this._cityCache = null;
    this._initAttributes();
    this.userSpinVel = 0;
  }
  _initAttributes() {
    const rng = new PRNG('attrs-' + this.seed);
    const types = ['Gesteinsplanet', 'Gasriese', 'Eisplanet', 'Ozeanplanet'];
    this.type = types[Math.floor(rng.float() * types.length)];
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
    }
    this.name = PlanetNameGen.generate('p-' + this.seed);
  }
  ensureTexture(size) {
    size = Math.max(64, Math.min(4096, Math.floor(size)));
    if (this._tex && this._lastSize === size) return;
    this._lastSize = size;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const prng = new PRNG('palette-' + this.seed);
    const oceans = `hsl(${prng.int(180,210)}, ${prng.int(40,70)}%, ${prng.int(25,45)}%)`;
    const land = `hsl(${prng.int(40,140)}, ${prng.int(30,65)}%, ${prng.int(35,60)}%)`;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const scale = 3;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x / size - 0.5) * scale, ny = (y / size - 0.5) * scale;
        const e = this._noise.fbm(nx + 1.3, ny - 0.7, 5, 2.1, 0.55) - 0.08 + 0.12 * Math.sin(nx * 1.7) + 0.08 * Math.cos(ny * 1.3);
        const isLand = e > 0.0;
        const color = isLand ? land : oceans;
        const m = /hsl\((\d+),\s*(\d+)%\,\s*(\d+)%\)/.exec(color);
        let h = +m[1], s = +m[2] / 100, l = +m[3] / 100;
        const shade = 0.15 * (y / size - 0.5);
        const hT = this._noise.fbm(nx * 3.2, ny * 3.2, 5, 2.1, 0.5);
        const ridge = 1 - Math.abs(this._noise.noise(nx * 5.0, ny * 5.0) - 0.5) * 2;
        const micro = isLand ? (0.6 * hT + 0.4 * ridge) : (0.2 * hT);
        l = Math.min(1, Math.max(0, l - shade + (isLand ? (micro - 0.5) * 0.18 : (micro - 0.5) * 0.08)));
        const c1 = (1 - Math.abs(2 * l - 1)) * s;
        const x1 = c1 * (1 - Math.abs(((h / 60) % 2) - 1));
        const m1 = l - c1 / 2;
        let r = 0, g = 0, b = 0;
        if (h < 60) { r = c1; g = x1; b = 0; }
        else if (h < 120) { r = x1; g = c1; b = 0; }
        else if (h < 180) { r = 0; g = c1; b = x1; }
        else if (h < 240) { r = 0; g = x1; b = c1; }
        else if (h < 300) { r = x1; g = 0; b = c1; }
        else { r = c1; g = 0; b = x1; }
        r = (r + m1); g = (g + m1); b = (b + m1);
        const i = (y * size + x) * 4;
        data[i] = Math.round(r * 255);
        data[i + 1] = Math.round(g * 255);
        data[i + 2] = Math.round(b * 255);
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.35, size / 2, size / 2, size * 0.52);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(160,220,255,0.25)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.5, 0, Math.PI * 2);
    ctx.fill();
    this._tex = c;
  }
  ensureCities() {
    if (this._cityCache) return;
    const dots = [];
    const n = 60 + this._cityPRNG.int(0, 180);
    for (let i = 0; i < n; i++) {
      const lat = this._cityPRNG.float(-Math.PI / 2, Math.PI / 2);
      const lon = this._cityPRNG.float(-Math.PI, Math.PI);
      const size = this._cityPRNG.float(0.4, 1.8);
      dots.push({ lat, lon, size, phase: this._cityPRNG.float(0, Math.PI * 2) });
    }
    this._cityCache = dots;
  }
}

export class Ship {
  constructor(pos, target) {
    this.pos = pos.clone();
    this.target = target.clone();
    this.speed = 120;
    this.phase = Math.random() * Math.PI * 2;
    this.isPlayer = false;
  }
  update(dt) {
    const to = Vec2.sub(this.target, this.pos);
    const d = to.len();
    if (d < 8) {
      this.target = Vec2.add(this.target, Vec2.fromPolar(800 + Math.random() * 1200, Math.random() * Math.PI * 2));
      return;
    }
    to.norm();
    this.pos.add(to.scale(this.speed * dt));
    this.phase += dt;
  }
}

export class PlayerShip extends Ship {
  constructor(pos) { super(pos, pos.clone()); this.isPlayer = true; }
  update(dt) {
    const to = Vec2.sub(this.target, this.pos);
    const d = to.len();
    if (d < 2) { return; }
    to.norm();
    this.pos.add(to.scale(this.speed * dt));
    this.phase += dt;
  }
}
