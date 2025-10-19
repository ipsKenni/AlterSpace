import { Iso } from '../shared/iso.js';
import { BaseIsoView } from '../shared/baseIsoView.js';
import { ValueNoise2D } from '../core/noise.js';
import { runMoveThenInteract } from '../shared/interaction.js';

// Planet/Mond Oberfläche als isometrisches Raster, ähnlich dem Interior
export class SurfaceView extends BaseIsoView {
  constructor(canvas, opts = {}) {
    super(canvas, { onEscape: opts.onExit });
    this.planet = null; // { name, type, gravity }
    // Procedural planet config (wrap-around). World repeats every worldW x worldH tiles.
    this.chunkSize = 32; // tiles per chunk (power of two preferred)
    this.worldW = 256;   // total tiles horizontally before wrap
    this.worldH = 256;   // total tiles vertically before wrap
    this.cxCount = Math.floor(this.worldW / this.chunkSize);
    this.cyCount = Math.floor(this.worldH / this.chunkSize);
    // Noise-based generator
    this.seed = (opts.seed || 'planet');
    this.noise = new ValueNoise2D(this.seed);
    // Cached generated chunks (by modulo coords): key "cx,cy" -> { canvas, ctx, ver }
    this._chunks = new Map();
    this._genVersion = 1; // bump to force rebuild if parameters change
    // Spawn and special tiles
    const sx = Math.floor(this.worldW / 2), sy = Math.floor(this.worldH / 2);
    this.spawn = { x: sx, y: sy };
    this.pad = { x: sx, y: sy };      // launch pad
    this.exit = { x: sx, y: sy - 1 }; // exit tile next to pad
  // Avatar/state
  this._walkSpeed = 3.2; // constant walking speed (tiles/sec)
  this.avatar = { x: sx, y: sy, px: sx, py: sy, t: 0, speed: this._walkSpeed, path: [], sit: false, name: 'Du' };
  this.onExit = typeof opts.onExit === 'function' ? opts.onExit : null;
  this._pending = null; // { type: 'exit', x, y }
    this._remotes = [];
    // Rendering helpers
    this._tileCache = new Map(); // cache of tiny tile canvases by (type,theme)
  }

  setBody(bodyInfo) {
    this.planet = bodyInfo;
    // Update seed/theme dependent generation when body changes
    const s = (bodyInfo?.name || bodyInfo?.type || 'planet') + ':' + (bodyInfo?.seed || '0');
    this.seed = s;
    this.noise = new ValueNoise2D(this.seed);
    this._genVersion++;
  // Keep walking speed constant across planets
  this.avatar.speed = this._walkSpeed;
  }
  getAvatarTile() { return { x: this.avatar.x|0, y: this.avatar.y|0 }; }
  setRemotes(list) {
    // Keep a map for smoothing; interpolate toward latest tile positions
    if (!this._remoteState) this._remoteState = new Map();
    const incoming = Array.isArray(list) ? list : [];
    const next = new Map();
    for (const it of incoming) {
      const id = (it.id>>>0) || 0; const key = id || `${it.x},${it.y}`;
      const prev = this._remoteState.get(key) || { px: it.x, py: it.y };
      next.set(key, {
        id, name: it.name||'Spieler',
        tx: it.x, ty: it.y,
        px: prev.px, py: prev.py,
      });
    }
    this._remoteState = next;
  }

  // Wrap tile coords into the repeating world
  _wrap(x, y) {
    const wx = ((x % this.worldW) + this.worldW) % this.worldW;
    const wy = ((y % this.worldH) + this.worldH) % this.worldH;
    return { x: wx, y: wy };
  }

  // Choose nearest periodic instance of a target relative to a reference point
  _nearestTarget(refX, refY, tx, ty) {
    let best = { x: tx, y: ty }, bestD = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const x = tx + ox * this.worldW; const y = ty + oy * this.worldH;
        const d = (x - refX) * (x - refX) + (y - refY) * (y - refY);
        if (d < bestD) { bestD = d; best = { x, y }; }
      }
    }
    return best;
  }

  // A* over a sampled local grid around start/target; returns list of world tile coords
  _findPath(sx, sy, tx, ty) {
    // Build local grid bounds with margin
    const margin = 32;
    const minX = Math.floor(Math.min(sx, tx)) - margin;
    const maxX = Math.floor(Math.max(sx, tx)) + margin;
    const minY = Math.floor(Math.min(sy, ty)) - margin;
    const maxY = Math.floor(Math.max(sy, ty)) + margin;
    const W = maxX - minX + 1, H = maxY - minY + 1; if (W <= 0 || H <= 0 || W * H > 120000) return [];
    const idx = (x, y) => (y - minY) * W + (x - minX);
    const walkable = (x, y) => this._walkable(x, y);
    const key = (x, y) => `${x},${y}`;
    const open = new Map(); const came = new Map(); const g = new Map(); const f = new Map();
    const startK = key(sx, sy); const goalK = key(tx, ty);
    const h = (x, y) => Math.hypot(x - tx, y - ty);
    g.set(startK, 0); f.set(startK, h(sx, sy)); open.set(startK, { x: sx, y: sy });
    const neigh = [ [1,0],[ -1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1] ];
    const diagOK = (cx, cy, nx, ny) => {
      const dx = nx - cx, dy = ny - cy; if (Math.abs(dx) + Math.abs(dy) !== 2) return true;
      return walkable(cx + dx, cy) && walkable(cx, cy + dy) && walkable(nx, ny);
    };
    let it = 0;
    const popLowest = () => {
      let best = null, bestF = Infinity; for (const k of open.keys()) { const fv = f.get(k) ?? Infinity; if (fv < bestF) { bestF = fv; best = k; } }
      return best;
    };
    while (open.size) {
      if (++it > 10000) break;
      const curK = popLowest(); const [cx, cy] = curK.split(',').map(n=>parseInt(n,10)); if (curK === goalK) {
        const out = []; let ck = curK; while (came.has(ck)) { const [x,y] = ck.split(',').map(n=>parseInt(n,10)); out.unshift({ x, y }); ck = came.get(ck); }
        return out;
      }
      open.delete(curK);
      for (const [dx, dy] of neigh) {
        const nx = cx + dx, ny = cy + dy; if (nx < minX || ny < minY || nx > maxX || ny > maxY) continue;
        if (!walkable(nx, ny)) continue; if (!diagOK(cx, cy, nx, ny)) continue; const nk = key(nx, ny);
        const step = (dx === 0 || dy === 0) ? 1 : Math.SQRT2;
        const tg = (g.get(curK) ?? Infinity) + step; if (tg < (g.get(nk) ?? Infinity)) { came.set(nk, curK); g.set(nk, tg); f.set(nk, tg + h(nx, ny)); open.set(nk, { x: nx, y: ny }); }
      }
    }
    return [];
  }

  // Determine tile type at world tile coords (wrapped). Types: 0=floor,1=block,2=prop,3=pad,4=exit,5=cave
  _tileAt(x, y) {
    const { x: wx, y: wy } = this._wrap(x, y);
    // Special tiles around spawn
    if (wx === this.pad.x && wy === this.pad.y) return 3;
    if (wx === this.exit.x && wy === this.exit.y) return 4;
    // Themed noise thresholds
    const theme = this.planet?.type || 'planet';
    const f = 1 / 32; // base frequency
    const h = this.noise.fbm(wx * f, wy * f, 4, 2.0, 0.5); // 0..1
    // Feature masks
    const rock = this.noise.noise(wx * 0.11 + 100, wy * 0.11 + 33);
    const prop = this.noise.noise(wx * 0.21 - 77, wy * 0.21 + 9);
    // Caves: carve tunnels through rock using separate noise band
    const cave = this.noise.fbm(wx * 0.36 + 500, wy * 0.36 - 200, 3, 2.0, 0.5);
    // Theme-based thresholds
    let rockTh = 0.78, propTh = 0.86;
    if (theme.includes('Wüste') || theme.includes('desert')) { rockTh = 0.82; propTh = 0.9; }
    if (theme.includes('Eis') || theme.includes('ice')) { rockTh = 0.75; propTh = 0.88; }
    // Elevation gating to form islands/continents
    const land = h > 0.42;
    if (!land) return 1; // treat ocean/low as blocked for walking (water)
    if (rock > rockTh) {
      // Carve cave tunnels inside otherwise blocked rock
      if (cave > 0.62) return 5; // cave (walkable)
      return 1; // solid rock
    }
    if (prop > propTh) return 2; // small prop
    return 0; // walkable ground
  }

  // Override walkable to use procedural tiles
  _walkable(x, y) {
    const t = this._tileAt(x, y);
    return t !== 1; // blocks are only type 1; caves (5) are walkable
  }

  // Chunk canvas (iso) rendering
  _getChunkCanvas(cxi, cyi) {
    // Use modulo chunk for content; draw can be repeated at any world offset
    const mx = ((cxi % this.cxCount) + this.cxCount) % this.cxCount;
    const my = ((cyi % this.cyCount) + this.cyCount) % this.cyCount;
    const key = `${mx},${my}`;
    let rec = this._chunks.get(key);
    if (!rec || rec.ver !== this._genVersion) {
      // (Re)build
      const CS = this.chunkSize; const tw = Iso.tileW, th = Iso.tileH;
      const w = CS * tw, h = CS * th;
      const can = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h) : document.createElement('canvas');
      can.width = w; can.height = h;
      const cctx = can.getContext('2d');
      cctx.clearRect(0, 0, w, h);
      // For each tile in chunk, render simple iso diamond and optional props/pad/exit
      const worldGX = mx * CS, worldGY = my * CS;
      const xShift = (CS * tw) / 2; // to keep all tile draw positions positive in x
      for (let ty = 0; ty < CS; ty++) {
        for (let tx = 0; tx < CS; tx++) {
          const gx = worldGX + tx, gy = worldGY + ty;
          const t = this._tileAt(gx, gy);
          const p = Iso.toScreen(tx, ty, 0);
          const sx = p.x + xShift; const sy = p.y;
          // Base tile fill based on theme and noise nuance
          const theme = this.planet?.type || 'planet';
          let fill = 'rgba(20,40,70,0.9)';
          if (theme.includes('Wüste') || theme.includes('desert')) fill = 'rgba(200,160,100,0.9)';
          else if (theme.includes('Eis') || theme.includes('ice')) fill = 'rgba(210,235,247,0.9)';
          if (t === 1) fill = theme.includes('Eis')||theme.includes('ice') ? 'rgba(180,200,220,0.95)' : 'rgba(70,70,70,0.95)';
          if (t === 3) fill = 'rgba(60,120,60,0.95)';
          if (t === 4) fill = 'rgba(120,80,40,0.95)';
          cctx.save();
          cctx.translate(sx, sy);
          cctx.beginPath();
          cctx.moveTo(0, 0);
          cctx.lineTo(tw / 2, th / 2);
          cctx.lineTo(0, th);
          cctx.lineTo(-tw / 2, th / 2);
          cctx.closePath();
          // Caves darker and a slight inner shadow
          if (t === 5) {
            cctx.fillStyle = 'rgba(20,20,30,0.92)';
            cctx.fill();
            // Entrance shading hint
            cctx.fillStyle = 'rgba(0,0,0,0.25)';
            cctx.beginPath();
            cctx.moveTo(-tw/2+2, th/2);
            cctx.lineTo(0, th-2);
            cctx.lineTo(tw/2-2, th/2);
            cctx.closePath();
            cctx.fill();
          } else {
            cctx.fillStyle = fill;
            cctx.fill();
          }
          if (t === 2) { cctx.fillStyle = 'rgba(120,120,120,0.85)'; cctx.fillRect(-6, 6, 12, 8); }
          if (t === 3) {
            // Landing capsule marker
            cctx.strokeStyle = 'rgba(240,240,240,0.85)'; cctx.lineWidth = 2; cctx.strokeRect(-12, 6, 24, 6);
            cctx.fillStyle = 'rgba(235,250,255,0.9)'; cctx.font = '10px monospace'; cctx.textAlign = 'center';
            cctx.fillText('Landekapsel', 0, 6);
          }
          if (t === 4) { cctx.fillStyle = 'rgba(255,240,220,0.9)'; cctx.font = '10px monospace'; cctx.textAlign = 'center'; cctx.fillText('Beamen', 0, 6); }
          cctx.restore();
        }
      }
      rec = { canvas: can, ctx: cctx, ver: this._genVersion };
      this._chunks.set(key, rec);
    }
    return rec.canvas;
  }

  // Pick the nearest periodic instance for smooth rendering across world wrap
  _toScreenWrapped(ix, iy, lastScreen) {
    // Try 3x3 neighbor offsets around origin; choose screen pos closest to lastScreen
    let best = null; let bestD = Infinity; let bestPos = { x: 0, y: 0 };
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const x = ix + ox * this.worldW;
        const y = iy + oy * this.worldH;
        const p = Iso.toScreen(x, y, 0);
        if (!lastScreen) { // first time: pick origin instance
          const d = (ox === 0 && oy === 0) ? 0 : 1e6;
          if (d < bestD) { bestD = d; best = p; bestPos = p; }
        } else {
          const dx = p.x - lastScreen.x; const dy = p.y - lastScreen.y; const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = p; bestPos = p; }
        }
      }
    }
    return bestPos;
  }

  _getAvatarTile() { return { x: this.avatar.x|0, y: this.avatar.y|0 }; }
  _tryStep(dx, dy) {
    const nx = this.avatar.x + dx, ny = this.avatar.y + dy;
    if (this._walkable(nx, ny)) this.avatar.path = [{ x: nx, y: ny }];
  }

  _handleClick(mx, my) {
    const { ix, iy } = this._screenToIso(mx, my);
    const destTileType = this._tileAt(ix, iy);
    if (destTileType === 1) return; // blocked
    if (destTileType === 4) {
      // Need to be on exit tile first
      const onTile = ((this.avatar.x|0) === (ix|0) && (this.avatar.y|0) === (iy|0));
      if (onTile) { this.onExit && this.onExit(); return; }
      this._pending = { type: 'exit', x: ix|0, y: iy|0 };
    }
    // Choose nearest periodic destination to avoid long jumps across seams
    const near = this._nearestTarget(this.avatar.x, this.avatar.y, ix, iy);
    // Pathfind within a local window for natural movement and constant speed
    const path = this._findPath(this.avatar.x|0, this.avatar.y|0, near.x|0, near.y|0);
    if (path.length) { this.avatar.path = path; }
    else {
      // fallback: single segment if unobstructed (keeps speed constant due to segment normalization)
      this.avatar.path = [{ x: near.x|0, y: near.y|0 }];
    }
  }

  frame(dt) {
    if (!this.active) return;
    // movement
    const av = this.avatar; const speed = av.speed;
    if (av.path && av.path.length) {
      if (!av._seg) { const target = av.path[0]; const len = Math.hypot(target.x - av.px, target.y - av.py) || 1; av._seg = { sx: av.px, sy: av.py, tx: target.x, ty: target.y, t: 0, len }; }
      const seg = av._seg; seg.t += dt * speed / (seg.len || 1); const t = Math.min(1, seg.t);
      av.px = seg.sx + (seg.tx - seg.sx) * t; av.py = seg.sy + (seg.ty - seg.sy) * t;
      if (t >= 1) {
        const w = this._wrap(seg.tx, seg.ty);
  av.x = w.x; av.y = w.y; av.px = av.x; av.py = av.y; av.path.shift(); av._seg = null; if (av._onArrive) { const fn = av._onArrive; av._onArrive = null; try { fn(); } catch {} }
        // If we just stepped onto exit tile and pending exit, perform
        if (this._tileAt(av.x, av.y) === 4) {
          if (this._pending && this._pending.type === 'exit' && (this._pending.x|0) === (av.x|0) && (this._pending.y|0) === (av.y|0)) {
            this._pending = null; this.onExit && this.onExit();
          }
        }
      }
    } else { av.px = av.x; av.py = av.y; av._seg = null; }

  // Camera follow: keep avatar centered with light smoothing
  const pc = this._toScreenWrapped(av.px, av.py, av._lastDraw);
  const biasY = 20; // show etwas mehr vor dem Spieler
  const tx = -pc.x;
  const ty = -pc.y + biasY;
  const k = 10; const a = 1 - Math.exp(-k * dt);
  this.offset.x += (tx - this.offset.x) * a;
  this.offset.y += (ty - this.offset.y) * a;

  const ctx = this.ctx; ctx.save();
    ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
    const dpr = window.devicePixelRatio || 1; ctx.scale(dpr,dpr);

    const w = this.canvas.width/dpr, h = this.canvas.height/dpr;
    // sky/background color
    const base = this.planet?.type || 'planet';
    const sky = ctx.createLinearGradient(0,0,0,h);
    if (base.includes('Eis') || base.includes('ice')) { sky.addColorStop(0,'#bcdfff'); sky.addColorStop(1,'#6aa9ff'); }
    else if (base.includes('Wüste') || base.includes('desert')) { sky.addColorStop(0,'#ffd8a3'); sky.addColorStop(1,'#ffb35e'); }
    else { sky.addColorStop(0,'#a0c8ff'); sky.addColorStop(1,'#4b85ff'); }
    ctx.fillStyle=sky; ctx.fillRect(0,0,w,h);

    // world transform
    ctx.translate(w/2, h/2); ctx.scale(this.scale, this.scale); ctx.translate(this.offset.x, this.offset.y);
    // Draw visible chunks only
    const corners = [
      this._screenToIso(0, 0),
      this._screenToIso(this.canvas.width, 0),
      this._screenToIso(0, this.canvas.height),
      this._screenToIso(this.canvas.width, this.canvas.height)
    ];
    let minIx = Infinity, maxIx = -Infinity, minIy = Infinity, maxIy = -Infinity;
    for (const c of corners) { if (c.ix < minIx) minIx = c.ix; if (c.ix > maxIx) maxIx = c.ix; if (c.iy < minIy) minIy = c.iy; if (c.iy > maxIy) maxIy = c.iy; }
    // pad generously to avoid edge pop-in
    const CS = this.chunkSize;
    minIx -= CS; maxIx += CS; minIy -= CS; maxIy += CS;
    const minCX = Math.floor(minIx / CS) - 1, maxCX = Math.floor(maxIx / CS) + 1;
    const minCY = Math.floor(minIy / CS) - 1, maxCY = Math.floor(maxIy / CS) + 1;
    for (let cy = minCY; cy <= maxCY; cy++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const chunkCanvas = this._getChunkCanvas(cx, cy);
        // Compute screen pos for chunk origin tile (gx,gy)
        const gx = cx * CS, gy = cy * CS;
        const p0 = Iso.toScreen(gx, gy, 0);
        // Shift accounts for positive draw within chunk canvas
        const shiftX = (CS * Iso.tileW) / 2;
        ctx.drawImage(chunkCanvas, p0.x - shiftX, p0.y);
      }
    }

    // Hover highlight
    if (this._hover) {
      const { ix, iy } = this._hover;
      const hp = Iso.toScreen(ix, iy, 0);
      ctx.save(); ctx.translate(hp.x, hp.y);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Iso.tileW / 2, Iso.tileH / 2);
      ctx.lineTo(0, Iso.tileH);
      ctx.lineTo(-Iso.tileW / 2, Iso.tileH / 2);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    // avatar
  const p = this._toScreenWrapped(av.px, av.py, av._lastDraw);
    const moving = !!(av.path && av.path.length);
  av._bobT = (av._bobT || 0) + (moving ? dt * 7 : dt * 2);
  const bob = Math.sin(av._bobT) * (moving ? 1.2 : 0.2);
    ctx.save(); ctx.translate(p.x, p.y - 8 - bob);
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.beginPath(); ctx.arc(0, 10, 10, 0, Math.PI*2); ctx.fill(); // shadow
    ctx.fillStyle = 'rgba(180,255,200,0.95)'; ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(220,245,255,0.95)'; ctx.font = '12px monospace'; ctx.textAlign = 'center'; ctx.fillText(this.planet?.name||'–', 0, -12);
    ctx.restore();
  av._lastDraw = p;

    // remote avatars (smoothed)
    const refX = av.px, refY = av.py;
    if (this._remoteState && this._remoteState.size) {
      for (const [key, r] of this._remoteState) {
        // choose nearest periodic instance to reference to avoid jumps
        let best = null, bestD = Infinity;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const tx = r.tx + ox * this.worldW;
            const ty = r.ty + oy * this.worldH;
            const dx = tx - refX; const dy = ty - refY; const d = dx*dx + dy*dy;
            if (d < bestD) { bestD = d; best = { x: tx, y: ty }; }
          }
        }
        // smooth previous toward target
        const k = 12; const a = 1 - Math.exp(-k * dt);
        r.px += (best.x - r.px) * a;
        r.py += (best.y - r.py) * a;
        const rp = Iso.toScreen(r.px, r.py, 0);
        ctx.save(); ctx.translate(rp.x, rp.y - 8);
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(0, 10, 9, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = 'rgba(255,180,120,0.95)'; ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(240,255,255,0.95)'; ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.fillText(r.name||'Spieler', 0, -12);
        ctx.restore();
      }
    }

    ctx.restore();
  }
}
