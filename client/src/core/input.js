// Eingabesteuerung (Tastatur, Maus, Scroll)
//
// Best Practices:
// - Delegation von Ereignissen in die App
// - Keine Geschäftslogik in der Eingabeschicht

import { Vec2 } from './math.js';

export class InputController {
  constructor(canvas, camera, settings, delegate) {
    this.canvas = canvas;
    this.camera = camera;
    this.settings = settings;
    this.delegate = delegate;
    this.keys = new Set();
    this.dragging = false;
    this.last = { x: 0, y: 0 };
  // Touch state
  this.touches = new Map();
  this._pinch = null; // {startDist, lastZoom}
  this._longPressTimer = null;
  this._longPressActive = false;
  this._tapStart = null; // {t, x, y}
  this._lastTapTime = 0;
    this._bind();
  }
  _bind() {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
      if (this.delegate && this.delegate.onKeyDown) this.delegate.onKeyDown(e);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.last = { x: e.clientX, y: e.clientY };
      if (this.delegate && this.delegate.onDragStart) this.delegate.onDragStart(e);
    });
    window.addEventListener('mouseup', (e) => {
      this.dragging = false;
      if (this.delegate && this.delegate.onDragEnd) this.delegate.onDragEnd(e);
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      if (!this.delegate || !this.delegate.onDrag || !this.delegate.onDrag(dx, dy, e)) {
        this.camera.pos.x -= dx / this.camera.zoom;
        this.camera.pos.y -= dy / this.camera.zoom;
      }
    });
  this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = Math.pow(1.1, -e.deltaY / 100) ** this.settings.zoomSpeed;
      const mouse = new Vec2(e.clientX, e.clientY);
      const before = this.camera.screenToWorld(mouse, this.canvas);
      this.camera.zoom = Math.min(this.camera.maxZoom, Math.max(this.camera.minZoom, this.camera.zoom * zoomFactor));
      const after = this.camera.screenToWorld(mouse, this.canvas);
      this.camera.pos.x += before.x - after.x;
      this.camera.pos.y += before.y - after.y;
    }, { passive: false });
    this.canvas.addEventListener('dblclick', async () => {
      if (!document.fullscreenElement) {
        try { await this.canvas.requestFullscreen(); } catch {}
      } else {
        try { await document.exitFullscreen(); } catch {}
      }
    });

    // Touch gestures: one-finger pan, two-finger pinch zoom, long-press for context action
    const touchPoint = (t) => ({ x: t.clientX, y: t.clientY });
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    const cancelLong = () => { if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; } this._longPressActive = false; };

    this.canvas.addEventListener('touchstart', (e) => {
      if (e.target !== this.canvas) return; // ignore overlays
      e.preventDefault();
      for (const t of e.changedTouches) { this.touches.set(t.identifier, touchPoint(t)); }
      if (this.touches.size === 1) {
        const p = [...this.touches.values()][0];
        this.dragging = true; this.last = p;
  this._tapStart = { t: performance.now(), x: p.x, y: p.y };
        // long-press to set target
        cancelLong();
        this._longPressTimer = setTimeout(() => { this._longPressActive = true; if (this.delegate && this.delegate.playerShip) {
          const world = this.camera.screenToWorld(new Vec2(p.x, p.y), this.canvas);
          this.delegate.playerShip.target = world; }
        }, 650);
      } else if (this.touches.size === 2) {
        cancelLong();
        const [p1, p2] = [...this.touches.values()];
        this._pinch = { startDist: dist(p1, p2), lastZoom: this.camera.zoom, center: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
      }
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      if (e.target !== this.canvas) return;
      e.preventDefault();
      for (const t of e.changedTouches) { this.touches.set(t.identifier, touchPoint(t)); }
      if (this._pinch && this.touches.size >= 2) {
        const [p1, p2] = [...this.touches.values()].slice(0, 2);
        const d = dist(p1, p2);
        const scale = Math.max(0.2, Math.min(5, d / (this._pinch.startDist || 1)));
        const before = this.camera.screenToWorld(new Vec2(this._pinch.center.x, this._pinch.center.y), this.canvas);
        const targetZoom = this._pinch.lastZoom * (scale ** this.settings.zoomSpeed);
        this.camera.zoom = Math.min(this.camera.maxZoom, Math.max(this.camera.minZoom, targetZoom));
        const after = this.camera.screenToWorld(new Vec2(this._pinch.center.x, this._pinch.center.y), this.canvas);
        this.camera.pos.x += before.x - after.x; this.camera.pos.y += before.y - after.y;
      } else if (this.dragging && this.touches.size === 1) {
        const p = [...this.touches.values()][0];
        const dx = p.x - this.last.x, dy = p.y - this.last.y; this.last = p;
        if (!this.delegate || !this.delegate.onDrag || !this.delegate.onDrag(dx, dy, e)) {
          this.camera.pos.x -= dx / this.camera.zoom; this.camera.pos.y -= dy / this.camera.zoom;
        }
  // significant move cancels tap
  if (this._tapStart && Math.hypot(p.x - this._tapStart.x, p.y - this._tapStart.y) > 8) this._tapStart = null;
      }
    }, { passive: false });

    const endTouch = (e) => {
      for (const t of e.changedTouches) { this.touches.delete(t.identifier); }
      if (this.touches.size < 2) this._pinch = null;
      if (this.touches.size === 0) {
        this.dragging = false; const tap = this._tapStart; const wasLong = this._longPressActive; cancelLong();
        if (tap && !wasLong) {
          const now = performance.now(); const dt = now - tap.t;
          if (dt < 300) {
            // double-tap detection
            if (now - this._lastTapTime < 350) {
              // toggle fullscreen
              (async () => {
                try {
                  if (!document.fullscreenElement) { await this.canvas.requestFullscreen(); } else { await document.exitFullscreen(); }
                } catch {}
              })();
              this._lastTapTime = 0;
            } else {
              this._lastTapTime = now;
              const p = this.last || tap;
              if (this.delegate && typeof this.delegate.onTap === 'function') { this.delegate.onTap(p.x, p.y); }
            }
          }
        }
        this._tapStart = null;
      }
      if (this.delegate && this.delegate.onDragEnd) this.delegate.onDragEnd(e);
    };
    this.canvas.addEventListener('touchend', endTouch, { passive: false });
    this.canvas.addEventListener('touchcancel', endTouch, { passive: false });
  }
  update(dt) {
    const speed = 800 / this.camera.zoom;
    if (this.keys.has('arrowup') || this.keys.has('w')) this.camera.pos.y -= speed * dt;
    if (this.keys.has('arrowdown') || this.keys.has('s')) this.camera.pos.y += speed * dt;
    if (this.keys.has('arrowleft') || this.keys.has('a')) this.camera.pos.x -= speed * dt;
    if (this.keys.has('arrowright') || this.keys.has('d')) this.camera.pos.x += speed * dt;
  }
}
