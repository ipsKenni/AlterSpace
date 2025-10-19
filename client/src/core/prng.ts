// Pseudozufallszahlengeneratoren
//
// Best Practices:
// - Deterministische PRNGs für reproduzierbare Ergebnisse
// - Export kleiner, fokussierter Werkzeuge

type PRNGCore = () => number;

export class PRNG {
  private readonly rand: PRNGCore;

  static xmur3(str: string): PRNGCore {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i += 1) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  static sfc32(a: number, b: number, c: number, d: number): PRNGCore {
    return () => {
      a >>>= 0;
      b >>>= 0;
      c >>>= 0;
      d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  constructor(seedStr = 'seed') {
    const seed = PRNG.xmur3(seedStr);
    this.rand = PRNG.sfc32(seed(), seed(), seed(), seed());
  }

  next(): number {
    return this.rand();
  }

  float(min = 0, max = 1): number {
    return min + (max - min) * this.next();
  }

  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) {
      throw new Error('PRNG.pick requires a non-empty array');
    }
  const idx = this.int(0, arr.length - 1);
  return arr[idx]!;
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}
