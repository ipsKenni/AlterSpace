// Kamera (Welt <-> Bildschirm) und Transformationen
//
// Best Practices:
// - Keine DOM-Logik, nur Berechnung
// - Grenzen für Zoom sauber definiert

import { Vec2 } from './math.ts';

export class Camera {
  readonly pos: Vec2 = new Vec2(0, 0);
  zoom = 1;
  readonly minZoom = 0.008;
  readonly maxZoom = 500;

  screenToWorld(pt: Vec2, canvas: HTMLCanvasElement): Vec2 {
    const dpr = window.devicePixelRatio || 1;
    const cx = canvas.width / dpr;
    const cy = canvas.height / dpr;
    const x = (pt.x - cx / 2) / this.zoom + this.pos.x;
    const y = (pt.y - cy / 2) / this.zoom + this.pos.y;
    return new Vec2(x, y);
  }

  worldToScreen(pt: Vec2, canvas: HTMLCanvasElement): Vec2 {
    const dpr = window.devicePixelRatio || 1;
    const cx = canvas.width / dpr;
    const cy = canvas.height / dpr;
    const x = (pt.x - this.pos.x) * this.zoom + cx / 2;
    const y = (pt.y - this.pos.y) * this.zoom + cy / 2;
    return new Vec2(x, y);
  }

  apply(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(this.zoom * dpr, 0, 0, this.zoom * dpr, canvas.width / 2, canvas.height / 2);
    ctx.translate(-this.pos.x, -this.pos.y);
  }
}
