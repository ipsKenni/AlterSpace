// Base class for isometric canvas views with unified input and helpers
// Responsibilities:
// - Manage canvas/context, DPR resize
// - Pan/zoom via mouse/touch, hover tracking
// - Click routing to _handleClick(mx,my) implemented by subclass
// - Keyboard movement (arrows/WASD + diagonals q/e/z/c) routed to _tryStep(dx,dy)
// - Escape routed to onEscape

import { Iso } from './iso.ts';

export interface IsoTile {
  x: number;
  y: number;
}

export interface BaseIsoViewOptions {
  onEscape?: () => void;
}

export abstract class BaseIsoView {
  protected readonly canvas: HTMLCanvasElement;
  protected readonly ctx: CanvasRenderingContext2D;
  protected active = false;
  protected scale = 1;
  protected offset: { x: number; y: number } = { x: 0, y: 40 };
  protected hover: IsoTile | null = null;
  protected grid?: number[][];
  protected readonly onEscape: (() => void) | null;

  protected constructor(canvas: HTMLCanvasElement, opts: BaseIsoViewOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D context unavailable');
    }
    this.ctx = ctx;
    this.onEscape = typeof opts.onEscape === 'function' ? opts.onEscape : null;
    this.bindEvents();
    this.resize();
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  protected walkable(x: number, y: number): boolean {
    const g = this.grid;
    if (!g || !g[0]) {
      return true;
    }
    if (y < 0 || x < 0 || y >= g.length) {
      return false;
    }
    const row = g[y];
    if (!row || x >= row.length) {
      return false;
    }
    return row[x] !== 1;
  }

  protected abstract handleClick(mx: number, my: number): void;

  protected abstract tryStep(dx: number, dy: number): void;

  protected getAvatarTile(): IsoTile {
    return { x: 0, y: 0 };
  }

  protected bindEvents(): void {
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.active) {
          return;
        }
        event.preventDefault();
        const factor = Math.pow(1.1, -event.deltaY / 100);
        const before = this.screenToWorld(event.clientX, event.clientY);
        this.scale = Math.max(0.6, Math.min(3.0, this.scale * factor));
        const after = this.screenToWorld(event.clientX, event.clientY);
        this.offset.x += (after.x - before.x) * Iso.tileW * 0.5 * this.scale;
        this.offset.y += (after.y - before.y) * Iso.tileH * 0.5 * this.scale;
      },
      { passive: false },
    );

    let dragging = false;
    let last: { x: number; y: number } | null = null;
    this.canvas.addEventListener('mousedown', (event) => {
      if (!this.active || event.button !== 0) {
        return;
      }
      dragging = true;
      last = { x: event.clientX, y: event.clientY };
    });

    window.addEventListener('mousemove', (event) => {
      if (!this.active || !dragging || !last) {
        return;
      }
      this.offset.x += event.clientX - last.x;
      this.offset.y += event.clientY - last.y;
      last = { x: event.clientX, y: event.clientY };
    });

    window.addEventListener('mouseup', () => {
      dragging = false;
      last = null;
    });

    this.canvas.addEventListener('click', (event) => {
      if (!this.active) {
        return;
      }
      this.handleClick(event.clientX, event.clientY);
    });

    this.canvas.addEventListener('mousemove', (event) => {
      if (!this.active) {
        return;
      }
      const { ix, iy } = this.screenToIso(event.clientX, event.clientY);
      this.hover = { x: ix, y: iy };
    });

    window.addEventListener('keydown', (event) => {
      if (!this.active) {
        return;
      }
      if (event.key === 'Escape') {
        this.onEscape?.();
        return;
      }
      const map: Record<string, [number, number]> = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        w: [0, -1],
        s: [0, 1],
        a: [-1, 0],
        d: [1, 0],
        q: [-1, -1],
        e: [1, -1],
        z: [-1, 1],
        c: [1, 1],
      };
      const delta = map[event.key];
      if (!delta) {
        return;
      }
      const diag = Math.abs(delta[0]) + Math.abs(delta[1]) === 2;
      const current = this.getAvatarTile();
      const nx = current.x + delta[0];
      const ny = current.y + delta[1];
      const ok = diag
        ? this.walkable(nx, current.y) && this.walkable(current.x, ny) && this.walkable(nx, ny)
        : this.walkable(nx, ny);
      if (ok) {
        this.tryStep(delta[0], delta[1]);
      }
    });

    if ('ontouchstart' in window) {
      let touchDragging = false;
      let lastTouch: { x: number; y: number } | null = null;
      let pinch: { distance: number; scale: number; center: { x: number; y: number } } | null = null;
      let tapStart: { t: number; x: number; y: number } | null = null;
      let lastTapTime = 0;
      const toPoint = (touch: Touch) => ({ x: touch.clientX, y: touch.clientY });
      const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

      this.canvas.addEventListener(
        'touchstart',
        (event) => {
          if (!this.active) {
            return;
          }
          event.preventDefault();
          if (event.touches.length === 1) {
            touchDragging = true;
            lastTouch = toPoint(event.touches[0]!);
            tapStart = { t: performance.now(), ...lastTouch };
          }
          if (event.touches.length === 2) {
            const p1 = toPoint(event.touches[0]!);
            const p2 = toPoint(event.touches[1]!);
            pinch = {
              distance: distance(p1, p2),
              scale: this.scale,
              center: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
            };
          }
        },
        { passive: false },
      );

      this.canvas.addEventListener(
        'touchmove',
        (event) => {
          if (!this.active) {
            return;
          }
          event.preventDefault();
          if (pinch && event.touches.length === 2) {
            const p1 = toPoint(event.touches[0]!);
            const p2 = toPoint(event.touches[1]!);
            const factor = distance(p1, p2) / (pinch.distance || 1);
            const scale = Math.max(0.6, Math.min(2.5, pinch.scale * factor));
            const before = this.screenToWorld(pinch.center.x, pinch.center.y);
            this.scale = scale;
            const after = this.screenToWorld(pinch.center.x, pinch.center.y);
            this.offset.x += (after.x - before.x) * Iso.tileW * 0.5 * this.scale;
            this.offset.y += (after.y - before.y) * Iso.tileH * 0.5 * this.scale;
          } else if (touchDragging && event.touches.length === 1 && lastTouch) {
            const point = toPoint(event.touches[0]!);
            this.offset.x += point.x - lastTouch.x;
            this.offset.y += point.y - lastTouch.y;
            lastTouch = point;
            if (tapStart && Math.hypot(point.x - tapStart.x, point.y - tapStart.y) > 8) {
              tapStart = null;
            }
          }
        },
        { passive: false },
      );

      const end = () => {
        if (tapStart) {
          const dt = performance.now() - tapStart.t;
          if (dt < 280) {
            if (performance.now() - lastTapTime < 350) {
              (async () => {
                try {
                  if (!document.fullscreenElement) {
                    await this.canvas.requestFullscreen();
                  } else {
                    await document.exitFullscreen();
                  }
                } catch {
                  /* ignore */
                }
              })();
              lastTapTime = 0;
            } else {
              lastTapTime = performance.now();
              this.handleClick(tapStart.x, tapStart.y);
            }
          }
        }
        tapStart = null;
        touchDragging = false;
        pinch = null;
        lastTouch = null;
      };

      this.canvas.addEventListener('touchend', end, { passive: false });
      this.canvas.addEventListener('touchcancel', end, { passive: false });
    }
  }

  protected screenToWorld(mx: number, my: number): { x: number; y: number } {
    return {
      x: (mx - this.canvas.width / 2) / this.scale - this.offset.x,
      y: (my - this.canvas.height / 2) / this.scale - this.offset.y,
    };
  }

  protected screenToIso(mx: number, my: number): { ix: number; iy: number } {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const sx = (mx - w / 2) / this.scale - this.offset.x;
    const sy = (my - h / 2) / this.scale - this.offset.y;
    const tw = Iso.tileW / 2;
    const th = Iso.tileH / 2;
    const ix = Math.round((sy / th + sx / tw) / 2);
    const iy = Math.round((sy / th - sx / tw) / 2);
    return { ix, iy };
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const vv = window.visualViewport || { width: window.innerWidth, height: window.innerHeight };
    this.canvas.width = Math.floor(vv.width * dpr);
    this.canvas.height = Math.floor(vv.height * dpr);
  }
}
