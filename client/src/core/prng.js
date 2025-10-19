// Pseudozufallszahlengeneratoren
//
// Best Practices:
// - Deterministische PRNGs für reproduzierbare Ergebnisse
// - Export kleiner, fokussierter Werkzeuge

export class PRNG {
  static xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  static sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
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
  constructor(seedStr = "seed") {
    const seed = PRNG.xmur3(seedStr);
    this._rand = PRNG.sfc32(seed(), seed(), seed(), seed());
  }
  next() { return this._rand(); }
  float(min = 0, max = 1) { return min + (max - min) * this.next(); }
  int(min, max) { return Math.floor(this.float(min, max + 1)); }
  pick(arr) { return arr[this.int(0, arr.length - 1)]; }
  bool(p = 0.5) { return this.next() < p; }
}
