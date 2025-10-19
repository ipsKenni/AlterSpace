// Kamera (Welt <-> Bildschirm) und Transformationen
//
// Best Practices:
// - Keine DOM-Logik, nur Berechnung
// - Grenzen für Zoom sauber definiert

import { Vec2 } from './math.js';

export class Camera {
  constructor() {
    this.pos = new Vec2(0, 0);
    this.zoom = 1;
    this.minZoom = 0.008;
    this.maxZoom = 500;
  }
  screenToWorld(pt, canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cx = canvas.width / dpr, cy = canvas.height / dpr;
    const x = (pt.x - cx / 2) / this.zoom + this.pos.x;
    const y = (pt.y - cy / 2) / this.zoom + this.pos.y;
    return new Vec2(x, y);
  }
  worldToScreen(pt, canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cx = canvas.width / dpr, cy = canvas.height / dpr;
    const x = (pt.x - this.pos.x) * this.zoom + cx / 2;
    const y = (pt.y - this.pos.y) * this.zoom + cy / 2;
    return new Vec2(x, y);
  }
  apply(ctx, canvas) {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(this.zoom * dpr, 0, 0, this.zoom * dpr, canvas.width / 2, canvas.height / 2);
    ctx.translate(-this.pos.x, -this.pos.y);
  }
}
