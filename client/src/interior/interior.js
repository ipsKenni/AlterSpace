// Ship interior renderer: simple isometric room with avatar
import { Iso, pathTo } from '../shared/iso.js';
import { runMoveThenInteract } from '../shared/interaction.js';
import { BaseIsoView } from '../shared/baseIsoView.js';

export class ShipInterior extends BaseIsoView {
  constructor(canvas, opts = {}) {
    super(canvas, { onEscape: opts.onExit });
    this.active = false;
    this.gridW = 12; this.gridH = 10;
  this.grid = this._makeGrid(); // 0 = floor, 1 = wall/blocked, 2 = chair, 3 = door, 4 = Steuerpult
  this.avatar = { x: 2, y: 2, px: 2, py: 2, t: 0, speed: 5.5, path: [], sit: false, name: (opts.name||'Du') };
  this.onExit = typeof opts.onExit === 'function' ? opts.onExit : null;
  this.onConsole = typeof opts.onConsole === 'function' ? opts.onConsole : null;
  this._pending = null; // { type: 2|3|4, x, y }
  }

  _makeGrid() {
    const w = this.gridW, h = this.gridH;
    const g = Array.from({ length: h }, () => Array.from({ length: w }, () => 0));
    // border walls
    for (let x = 0; x < w; x++) { g[0][x] = 1; g[h - 1][x] = 1; }
    for (let y = 0; y < h; y++) { g[y][0] = 1; g[y][w - 1] = 1; }
    // some furniture (chairs = 2)
    g[4][4] = 2; g[4][5] = 2; g[5][4] = 2; g[5][6] = 2; g[6][5] = 2;
    // door (3) to leave room (bottom middle)
    g[h - 1][Math.floor(w / 2)] = 3;
  // console (4) near top-right
  g[2][w - 3] = 4;
    return g;
  }

  // BaseIsoView uses these hooks for keyboard movement
  _getAvatarTile() { return { x: this.avatar.x|0, y: this.avatar.y|0 }; }
  _tryStep(dx, dy) {
    const nx = this.avatar.x + dx, ny = this.avatar.y + dy;
    if (this._walkable(nx, ny)) { this.avatar.sit = false; this.avatar.path = [{ x: nx, y: ny }]; }
  }

  _handleClick(mx, my) {
    const { ix, iy } = this._screenToIso(mx, my);
    const tx = Math.max(0, Math.min(this.gridW - 1, ix));
    const ty = Math.max(0, Math.min(this.gridH - 1, iy));
    const tval = this.grid[ty][tx];
    if (tval === 1) return; // wall
    // Interactables require moving to them first unless already on tile
    if (tval === 3) { // door
      if ((this.avatar.x|0) === tx && (this.avatar.y|0) === ty) { this.onExit && this.onExit(); return; }
      this.avatar.sit = false; this._pending = { type: 3, x: tx, y: ty }; this.avatar.path = pathTo(tx, ty, this.grid, this.avatar); return;
    }
    if (tval === 4) { // console
      if ((this.avatar.x|0) === tx && (this.avatar.y|0) === ty) { this.onConsole && this.onConsole(); return; }
      this.avatar.sit = false; this._pending = { type: 4, x: tx, y: ty }; this.avatar.path = pathTo(tx, ty, this.grid, this.avatar); return;
    }
    // chair? sit (toggle if already seated there)
    if (tval === 2) {
      if ((this.avatar.x|0) === tx && (this.avatar.y|0) === ty) { this.avatar.sit = !this.avatar.sit; return; }
      this.avatar.sit = false; this._pending = { type: 2, x: tx, y: ty }; this.avatar.path = pathTo(tx, ty, this.grid, this.avatar); return;
    }
    this.avatar.sit = false;
    this.avatar.path = pathTo(tx, ty, this.grid, this.avatar);
  }

  _walkable(x, y) { return y >= 0 && x >= 0 && y < this.grid.length && x < this.grid[0].length && this.grid[y][x] !== 1; }

  frame(dt) {
    if (!this.active) return;
    // smooth movement along path
    const av = this.avatar; const speed = av.speed; // tiles per second
    if (av.path && av.path.length) {
      if (!av._seg) { const target = av.path[0]; const len = Math.hypot(target.x - av.px, target.y - av.py) || 1; av._seg = { sx: av.px, sy: av.py, tx: target.x, ty: target.y, t: 0, len }; }
      const seg = av._seg; seg.t += dt * speed / (seg.len || 1); const t = Math.min(1, seg.t);
      av.px = seg.sx + (seg.tx - seg.sx) * t; av.py = seg.sy + (seg.ty - seg.sy) * t;
  if (t >= 1) { av.x = seg.tx; av.y = seg.ty; av.px = av.x; av.py = av.y; av.path.shift(); av._seg = null; if (av._onArrive) { const fn = av._onArrive; av._onArrive = null; try { fn(); } catch {} } }
    } else { av.px = av.x; av.py = av.y; av._seg = null; }

    // Interactions on arrival
    if (this._pending && (av.x|0) === (this._pending.x|0) && (av.y|0) === (this._pending.y|0)) {
      const typ = this._pending.type|0; const px = this._pending.x|0, py = this._pending.y|0; this._pending = null;
      if (typ === 2) { av.sit = true; }
      else if (typ === 3) { this.onExit && this.onExit(); }
      else if (typ === 4) { this.onConsole && this.onConsole(); }
    }

    // Door/console auto-activation when walked onto via keyboard
    const curT = this.grid[av.y|0]?.[av.x|0] ?? 0;
    if (!this._pending && (curT === 3 || curT === 4)) {
      if (curT === 3) { this.onExit && this.onExit(); }
      else { this.onConsole && this.onConsole(); }
    }

  // Camera follow: center on avatar with light smoothing
  const pp = Iso.toScreen(av.px, av.py, 0);
  const tx = -pp.x; const ty = -pp.y + 16;
  const k = 10; const a = 1 - Math.exp(-k * dt);
  this.offset.x += (tx - this.offset.x) * a;
  this.offset.y += (ty - this.offset.y) * a;

  const ctx = this.ctx; ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);

    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    ctx.translate(w / 2, h / 2);
    ctx.scale(this.scale, this.scale);
    ctx.translate(this.offset.x, this.offset.y);

    // floor tiles
    for (let y = 0; y < this.gridH; y++) {
      for (let x = 0; x < this.gridW; x++) {
        const { x: sx, y: sy } = Iso.toScreen(x, y, 0);
        const tval = this.grid[y][x];
        // draw diamond tile
        const drawDiamond = () => {
          this.ctx.beginPath();
          this.ctx.moveTo(0, 0);
          this.ctx.lineTo(Iso.tileW / 2, Iso.tileH / 2);
          this.ctx.lineTo(0, Iso.tileH);
          this.ctx.lineTo(-Iso.tileW / 2, Iso.tileH / 2);
          this.ctx.closePath();
        };
        this.ctx.save(); this.ctx.translate(sx, sy);
        drawDiamond();
        this.ctx.fillStyle = tval === 1 ? 'rgba(30,60,90,0.95)' : (tval === 3 ? 'rgba(40,90,60,0.95)' : (tval === 4 ? 'rgba(60,50,90,0.95)' : 'rgba(20,40,70,0.9)'));
        this.ctx.fill();
        if (tval === 2) {
          // chair sprite (simple)
          this.ctx.fillStyle = 'rgba(180,220,255,0.9)';
          this.ctx.fillRect(-6, 6, 12, 8);
        }
        if (tval === 4) {
          // console sprite indicator
          this.ctx.fillStyle = 'rgba(160,220,255,0.9)';
          this.ctx.fillRect(-10, 2, 20, 6);
          this.ctx.fillStyle = 'rgba(220,255,240,0.85)'; this.ctx.font = '10px monospace'; this.ctx.textAlign = 'center';
          this.ctx.fillText('PULT', 0, 6);
        }
        if (tval === 3) {
          // door label
          this.ctx.fillStyle = 'rgba(220,255,220,0.85)'; this.ctx.font = '10px monospace'; this.ctx.textAlign = 'center';
          this.ctx.fillText('Tür', 0, 6);
        }
        if (this._hover && this._hover.x === x && this._hover.y === y) {
          this.ctx.strokeStyle = 'rgba(255,255,255,0.4)'; this.ctx.lineWidth = 1; this.ctx.stroke();
        }
        this.ctx.restore();
      }
    }

    // avatar (smooth position)
    const p = Iso.toScreen(av.px, av.py, 0);
    const moving = !!(av.path && av.path.length);
    av._bobT = (av._bobT || 0) + (moving ? dt * 8 : dt * 2);
    const bob = Math.sin(av._bobT) * (moving ? 2.2 : 0.5);
    ctx.save(); ctx.translate(p.x, p.y - 8 - bob);
    ctx.fillStyle = av.sit ? 'rgba(255,200,0,0.95)' : 'rgba(0,255,180,0.9)';
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fill();
    // name label
    ctx.fillStyle = 'rgba(220,245,255,0.95)'; ctx.font = '12px monospace'; ctx.textAlign = 'center';
    ctx.fillText(av.name, 0, -12);
    ctx.restore();

    ctx.restore();
  }
}
