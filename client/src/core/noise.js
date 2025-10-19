// 2D Value-Noise und FBM (Fractal Brownian Motion)
//
// Best Practices:
// - Reine Berechnungslogik getrennt von Rendering/DOM
// - Dokumentierte Parameter

import { PRNG } from './prng.js';

export class ValueNoise2D {
  constructor(seedStr) {
    this.prng = new PRNG(seedStr);
    this.perm = new Uint16Array(512);
    for (let i = 0; i < 256; i++) this.perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(this.prng.next() * (i + 1));
      const t = this.perm[i];
      this.perm[i] = this.perm[j];
      this.perm[j] = t;
    }
    for (let i = 0; i < 256; i++) this.perm[i + 256] = this.perm[i];
  }
  _randomGrid(ix, iy) { const n = this.perm[(ix + this.perm[iy & 255]) & 255]; return n / 255; }
  _smooth(t) { return t * t * (3 - 2 * t); }
  noise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const v00 = this._randomGrid(ix, iy), v10 = this._randomGrid(ix + 1, iy);
    const v01 = this._randomGrid(ix, iy + 1), v11 = this._randomGrid(ix + 1, iy + 1);
    const sx = this._smooth(fx), sy = this._smooth(fy);
    const ix0 = v00 * (1 - sx) + v10 * sx;
    const ix1 = v01 * (1 - sx) + v11 * sx;
    return ix0 * (1 - sy) + ix1 * sy;
  }
  fbm(x, y, oct = 4, lac = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lac;
    }
    return sum / norm;
  }
}
