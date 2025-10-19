// Mathematische Hilfsfunktionen und Vektorklasse
//
// Best Practices:
// - Kleine, wiederverwendbare Module
// - Eindeutige deutsche Kommentare zur Intention

export class Vec2 {
  constructor(public x = 0, public y = 0) {}

  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  add(v: Vec2): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  sub(v: Vec2): this {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }

  len(): number {
    return Math.hypot(this.x, this.y);
  }

  norm(): this {
    const length = this.len() || 1;
    this.x /= length;
    this.y /= length;
    return this;
  }

  static add(a: Vec2, b: Vec2): Vec2 {
    return new Vec2(a.x + b.x, a.y + b.y);
  }

  static sub(a: Vec2, b: Vec2): Vec2 {
    return new Vec2(a.x - b.x, a.y - b.y);
  }

  static fromPolar(r: number, ang: number): Vec2 {
    return new Vec2(r * Math.cos(ang), r * Math.sin(ang));
  }
}
