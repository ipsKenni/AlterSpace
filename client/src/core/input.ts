// Eingabesteuerung (Tastatur, Maus, Scroll)
//
// Best Practices:
// - Delegation von Ereignissen in die App
// - Keine Geschäftslogik in der Eingabeschicht

import { Camera } from './camera.ts';
import { Vec2 } from './math.ts';

interface TapState {
  t: number;
  x: number;
  y: number;
}

interface PinchState {
  startDist: number;
  lastZoom: number;
  center: { x: number; y: number };
}

export interface InputDelegate {
  onKeyDown?(event: KeyboardEvent): void;
  onDragStart?(event: MouseEvent): void;
  onDrag?(dx: number, dy: number, event: MouseEvent | TouchEvent): boolean | void;
  onDragEnd?(event: MouseEvent | TouchEvent): void;
  onTap?(x: number, y: number): void;
  playerShip?: { target: Vec2 };
}

export class InputController {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: Camera;
  private readonly settings: { zoomSpeed: number };
  private readonly delegate: InputDelegate | null;

  private readonly keys = new Set<string>();
  private dragging = false;
  private last = { x: 0, y: 0 };
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinch: PinchState | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressActive = false;
  private tapStart: TapState | null = null;
  private lastTapTime = 0;

  constructor(canvas: HTMLCanvasElement, camera: Camera, settings: { zoomSpeed: number }, delegate?: InputDelegate) {
    this.canvas = canvas;
    this.camera = camera;
    this.settings = settings;
    this.delegate = delegate ?? null;
    this.bindEvents();
  }

  private bindEvents(): void {
    window.addEventListener('keydown', (event) => {
      this.keys.add(event.key.toLowerCase());
      this.delegate?.onKeyDown?.(event);
    });

    window.addEventListener('keyup', (event) => {
      this.keys.delete(event.key.toLowerCase());
    });

    this.canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return;
      }
      this.dragging = true;
      this.last = { x: event.clientX, y: event.clientY };
      this.delegate?.onDragStart?.(event);
    });

    window.addEventListener('mouseup', (event) => {
      this.dragging = false;
      this.delegate?.onDragEnd?.(event);
    });

    window.addEventListener('mousemove', (event) => {
      if (!this.dragging) {
        return;
      }
      const dx = event.clientX - this.last.x;
      const dy = event.clientY - this.last.y;
      this.last = { x: event.clientX, y: event.clientY };
      const handled = this.delegate?.onDrag?.(dx, dy, event) ?? false;
      if (!handled) {
        this.camera.pos.x -= dx / this.camera.zoom;
        this.camera.pos.y -= dy / this.camera.zoom;
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const zoomFactor = Math.pow(1.1, -event.deltaY / 100) ** this.settings.zoomSpeed;
        const mouse = new Vec2(event.clientX, event.clientY);
        const before = this.camera.screenToWorld(mouse, this.canvas);
        this.camera.zoom = Math.min(this.camera.maxZoom, Math.max(this.camera.minZoom, this.camera.zoom * zoomFactor));
        const after = this.camera.screenToWorld(mouse, this.canvas);
        this.camera.pos.x += before.x - after.x;
        this.camera.pos.y += before.y - after.y;
      },
      { passive: false },
    );

    this.canvas.addEventListener('dblclick', async () => {
      if (!document.fullscreenElement) {
        try {
          await this.canvas.requestFullscreen();
        } catch {
          /* ignore */
        }
      } else {
        try {
          await document.exitFullscreen();
        } catch {
          /* ignore */
        }
      }
    });

    const touchPoint = (touch: Touch) => ({ x: touch.clientX, y: touch.clientY });
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const cancelLongPress = () => {
      if (this.longPressTimer) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
      }
      this.longPressActive = false;
    };

    this.canvas.addEventListener(
      'touchstart',
      (event) => {
        if (event.target !== this.canvas) {
          return;
        }
        event.preventDefault();
        for (const touch of event.changedTouches) {
          this.touches.set(touch.identifier, touchPoint(touch));
        }
        if (this.touches.size === 1) {
          const [point] = [...this.touches.values()];
          if (!point) {
            return;
          }
          this.dragging = true;
          this.last = point;
          this.tapStart = { t: performance.now(), x: point.x, y: point.y };
          cancelLongPress();
            this.longPressTimer = setTimeout(() => {
            this.longPressActive = true;
              if (this.delegate?.playerShip) {
                const world = this.camera.screenToWorld(new Vec2(point.x, point.y), this.canvas);
                this.delegate.playerShip.target = world;
              }
          }, 650);
        } else if (this.touches.size === 2) {
          cancelLongPress();
          const [first, second] = [...this.touches.values()];
          if (!first || !second) {
            return;
          }
          this.pinch = {
            startDist: dist(first, second),
            lastZoom: this.camera.zoom,
            center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
          };
        }
      },
      { passive: false },
    );

    this.canvas.addEventListener(
      'touchmove',
      (event) => {
        if (event.target !== this.canvas) {
          return;
        }
        event.preventDefault();
        for (const touch of event.changedTouches) {
          this.touches.set(touch.identifier, touchPoint(touch));
        }
        if (this.pinch && this.touches.size >= 2) {
          const [first, second] = [...this.touches.values()];
          if (!first || !second) {
            return;
          }
          const distance = dist(first, second);
          const scale = Math.max(0.2, Math.min(5, distance / (this.pinch.startDist || 1)));
          const before = this.camera.screenToWorld(new Vec2(this.pinch.center.x, this.pinch.center.y), this.canvas);
          const targetZoom = this.pinch.lastZoom * scale ** this.settings.zoomSpeed;
          this.camera.zoom = Math.min(this.camera.maxZoom, Math.max(this.camera.minZoom, targetZoom));
          const after = this.camera.screenToWorld(new Vec2(this.pinch.center.x, this.pinch.center.y), this.canvas);
          this.camera.pos.x += before.x - after.x;
          this.camera.pos.y += before.y - after.y;
        } else if (this.dragging && this.touches.size === 1) {
          const [point] = [...this.touches.values()];
          if (!point) {
            return;
          }
          const dx = point.x - this.last.x;
          const dy = point.y - this.last.y;
          this.last = point;
          const handled = this.delegate?.onDrag?.(dx, dy, event) ?? false;
          if (!handled) {
            this.camera.pos.x -= dx / this.camera.zoom;
            this.camera.pos.y -= dy / this.camera.zoom;
          }
          if (this.tapStart && Math.hypot(point.x - this.tapStart.x, point.y - this.tapStart.y) > 8) {
            this.tapStart = null;
          }
        }
      },
      { passive: false },
    );

    const endTouch = (event: TouchEvent) => {
      for (const touch of event.changedTouches) {
        this.touches.delete(touch.identifier);
      }
      if (this.touches.size < 2) {
        this.pinch = null;
      }
      if (this.touches.size === 0) {
        this.dragging = false;
        const tap = this.tapStart;
        const longPress = this.longPressActive;
        cancelLongPress();
        if (tap && !longPress) {
          const now = performance.now();
          const dt = now - tap.t;
          if (dt < 300) {
            if (now - this.lastTapTime < 350) {
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
              this.lastTapTime = 0;
            } else {
              this.lastTapTime = now;
              const point = this.last ?? tap;
              this.delegate?.onTap?.(point.x, point.y);
            }
          }
        }
        this.tapStart = null;
      }
      this.delegate?.onDragEnd?.(event);
    };

    this.canvas.addEventListener('touchend', endTouch, { passive: false });
    this.canvas.addEventListener('touchcancel', endTouch, { passive: false });
  }

  update(dt: number): void {
    const speed = 800 / this.camera.zoom;
    if (this.keys.has('arrowup') || this.keys.has('w')) {
      this.camera.pos.y -= speed * dt;
    }
    if (this.keys.has('arrowdown') || this.keys.has('s')) {
      this.camera.pos.y += speed * dt;
    }
    if (this.keys.has('arrowleft') || this.keys.has('a')) {
      this.camera.pos.x -= speed * dt;
    }
    if (this.keys.has('arrowright') || this.keys.has('d')) {
      this.camera.pos.x += speed * dt;
    }
  }
}
