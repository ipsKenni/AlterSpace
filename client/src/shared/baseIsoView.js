// Base class for isometric canvas views with unified input and helpers
// Responsibilities:
// - Manage canvas/context, DPR resize
// - Pan/zoom via mouse/touch, hover tracking
// - Click routing to _handleClick(mx,my) implemented by subclass
// - Keyboard movement (arrows/WASD + diagonals q/e/z/c) routed to _tryStep(dx,dy)
// - Escape routed to onEscape
import { Iso } from './iso.js';

export class BaseIsoView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.active = false;
    this.scale = 1;
    this.offset = { x: 0, y: 40 };
    this._hover = null;
    this.onEscape = typeof opts.onEscape === 'function' ? opts.onEscape : null;
    this._bind();
    this.resize();
  }

  setActive(v) { this.active = !!v; }

  // Default walkable uses grid with 1 as blocked
  _walkable(x, y) {
    const g = this.grid; if (!g || !g[0]) return true;
    return y >= 0 && x >= 0 && y < g.length && x < g[0].length && g[y][x] !== 1;
  }

  _bind() {
    // Mouse wheel zoom
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.active) return; e.preventDefault();
      const factor = Math.pow(1.1, -e.deltaY / 100);
      const mx = e.clientX, my = e.clientY; const before = this._screenToWorld(mx, my);
      this.scale = Math.max(0.6, Math.min(3.0, this.scale * factor));
      const after = this._screenToWorld(mx, my);
      this.offset.x += (after.x - before.x) * Iso.tileW * 0.5 * this.scale;
      this.offset.y += (after.y - before.y) * Iso.tileH * 0.5 * this.scale;
    }, { passive: false });

    // Mouse drag pan
    let dragging = false; let last = null;
    this.canvas.addEventListener('mousedown', (e) => { if (!this.active) return; if (e.button !== 0) return; dragging = true; last = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('mousemove', (e) => { if (!this.active) return; if (!dragging) return; this.offset.x += e.clientX - last.x; this.offset.y += e.clientY - last.y; last = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('mouseup', () => { dragging = false; });

    // Click routing
    this.canvas.addEventListener('click', (e) => { if (!this.active) return; if (typeof this._handleClick === 'function') this._handleClick(e.clientX, e.clientY); });

    // Hover tracking
    this.canvas.addEventListener('mousemove', (e) => { if (!this.active) return; const { ix, iy } = this._screenToIso(e.clientX, e.clientY); this._hover = { x: ix, y: iy }; });

    // Keyboard movement + escape
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      const map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], q: [-1,-1], e: [1,-1], z: [-1,1], c: [1,1] };
      if (e.key === 'Escape') { if (this.onEscape) this.onEscape(); return; }
      const v = map[e.key]; if (v && typeof this._tryStep === 'function') {
        const diag = Math.abs(v[0]) + Math.abs(v[1]) === 2;
        // Prevent corner cutting if subclass relies on _walkable/grid
        const cur = this._getAvatarTile ? this._getAvatarTile() : { x: 0, y: 0 };
        const nx = cur.x + v[0], ny = cur.y + v[1];
        const ok = diag ? (this._walkable(nx, cur.y) && this._walkable(cur.x, ny) && this._walkable(nx, ny)) : this._walkable(nx, ny);
        if (ok) this._tryStep(v[0], v[1]);
      }
    });

    // Touch gestures
    if ('ontouchstart' in window) {
      let tDragging = false; let last = null; let pinch = null; let tapStart = null; let lastTapTime = 0;
      const tp = (t) => ({ x: t.clientX, y: t.clientY });
      const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      this.canvas.addEventListener('touchstart', (e) => {
        if (!this.active) return; e.preventDefault();
        if (e.touches.length === 1) { tDragging = true; last = tp(e.touches[0]); tapStart = { t: performance.now(), ...last }; }
        if (e.touches.length === 2) { const p1 = tp(e.touches[0]), p2 = tp(e.touches[1]); pinch = { d: dist(p1, p2), s: this.scale, c: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } }; }
      }, { passive: false });
      this.canvas.addEventListener('touchmove', (e) => {
        if (!this.active) return; e.preventDefault();
        if (pinch && e.touches.length === 2) {
          const p1 = tp(e.touches[0]), p2 = tp(e.touches[1]);
          const sc = Math.max(0.6, Math.min(2.5, pinch.s * (dist(p1, p2) / (pinch.d || 1))));
          const before = this._screenToWorld(pinch.c.x, pinch.c.y);
          this.scale = sc;
          const after = this._screenToWorld(pinch.c.x, pinch.c.y);
          this.offset.x += (after.x - before.x) * Iso.tileW * 0.5 * this.scale;
          this.offset.y += (after.y - before.y) * Iso.tileH * 0.5 * this.scale;
        } else if (tDragging && e.touches.length === 1) { const p = tp(e.touches[0]); this.offset.x += p.x - last.x; this.offset.y += p.y - last.y; last = p; if (tapStart && Math.hypot(p.x - tapStart.x, p.y - tapStart.y) > 8) tapStart = null; }
      }, { passive: false });
      const end = () => {
        // tap detection
        if (tapStart) {
          const dt = performance.now() - tapStart.t;
          if (dt < 280) {
            // double-tap fullscreen toggle
            if (performance.now() - lastTapTime < 350) {
              (async () => { try { if (!document.fullscreenElement) await this.canvas.requestFullscreen(); else await document.exitFullscreen(); } catch {} })();
              lastTapTime = 0;
            } else {
              lastTapTime = performance.now();
              if (typeof this._handleClick === 'function') this._handleClick(tapStart.x, tapStart.y);
            }
          }
        }
        tapStart = null;
        tDragging = false; pinch = null; last = null; };
      this.canvas.addEventListener('touchend', end, { passive: false }); this.canvas.addEventListener('touchcancel', end, { passive: false });
    }
  }

  _screenToWorld(mx, my) {
    return { x: (mx - this.canvas.width / 2) / this.scale - this.offset.x, y: (my - this.canvas.height / 2) / this.scale - this.offset.y };
  }

  _screenToIso(mx, my) {
    const w = this.canvas.width, h = this.canvas.height;
    const sx = (mx - w / 2) / this.scale - this.offset.x;
    const sy = (my - h / 2) / this.scale - this.offset.y;
    const tw = Iso.tileW / 2, th = Iso.tileH / 2;
    const ix = Math.round((sy / th + sx / tw) / 2);
    const iy = Math.round((sy / th - sx / tw) / 2);
    return { ix, iy };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const vv = window.visualViewport || { width: window.innerWidth, height: window.innerHeight };
    this.canvas.width = Math.floor(vv.width * dpr);
    this.canvas.height = Math.floor(vv.height * dpr);
  }
}
