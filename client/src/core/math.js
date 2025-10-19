// Mathematische Hilfsfunktionen und Vektorklasse
//
// Best Practices:
// - Kleine, wiederverwendbare Module
// - Eindeutige deutsche Kommentare zur Intention

export class Vec2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  clone() { return new Vec2(this.x, this.y); }
  add(v) { this.x += v.x; this.y += v.y; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; return this; }
  scale(s) { this.x *= s; this.y *= s; return this; }
  len() { return Math.hypot(this.x, this.y); }
  norm() { const l = this.len() || 1; this.x /= l; this.y /= l; return this; }
  static add(a, b) { return new Vec2(a.x + b.x, a.y + b.y); }
  static sub(a, b) { return new Vec2(a.x - b.x, a.y - b.y); }
  static fromPolar(r, ang) { return new Vec2(r * Math.cos(ang), r * Math.sin(ang)); }
}
