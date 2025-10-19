// 2D Value-Noise und FBM (Fractal Brownian Motion)
//
// Best Practices:
// - Reine Berechnungslogik getrennt von Rendering/DOM
// - Dokumentierte Parameter

import { PRNG } from './prng.ts';

export class ValueNoise2D {
  private readonly prng: PRNG;
  private readonly perm: Uint16Array;

  constructor(seedStr: string) {
    this.prng = new PRNG(seedStr);
    this.perm = new Uint16Array(512);
    for (let i = 0; i < 256; i += 1) {
      this.perm[i] = i;
    }
    for (let i = 255; i > 0; i -= 1) {
      const j = Math.floor(this.prng.next() * (i + 1));
      const current = this.perm[i]!;
      const swap = this.perm[j]!;
      this.perm[i] = swap;
      this.perm[j] = current;
    }
    for (let i = 0; i < 256; i += 1) {
      this.perm[i + 256] = this.perm[i]!;
    }
  }

  private randomGrid(ix: number, iy: number): number {
    const offset = this.perm[iy & 255]!;
    const n = this.perm[(ix + offset) & 255]!;
    return n / 255;
  }

  private smooth(t: number): number {
    return t * t * (3 - 2 * t);
  }

  noise(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const v00 = this.randomGrid(ix, iy);
    const v10 = this.randomGrid(ix + 1, iy);
    const v01 = this.randomGrid(ix, iy + 1);
    const v11 = this.randomGrid(ix + 1, iy + 1);
    const sx = this.smooth(fx);
    const sy = this.smooth(fy);
    const ix0 = v00 * (1 - sx) + v10 * sx;
    const ix1 = v01 * (1 - sx) + v11 * sx;
    return ix0 * (1 - sy) + ix1 * sy;
  }

  fbm(x: number, y: number, oct = 4, lac = 2, gain = 0.5): number {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < oct; i += 1) {
      sum += amplitude * this.noise(x * frequency, y * frequency);
      norm += amplitude;
      amplitude *= gain;
      frequency *= lac;
    }
    return sum / norm;
  }
}
