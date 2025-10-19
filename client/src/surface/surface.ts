import { Iso } from '../shared/iso.ts';
import { BaseIsoView, IsoTile } from '../shared/baseIsoView.ts';
import { ValueNoise2D } from '../core/noise.ts';

export interface SurfaceOptions {
  seed?: string;
  name?: string;
  onExit?: () => void;
}

export interface SurfaceBodyInfo {
  name: string;
  type: string;
  gravity: number;
  seed?: string;
}

export interface SurfaceRemote {
  id: number;
  x: number;
  y: number;
  name: string;
}

type RemoteKey = number | string;

type ChunkCanvas = HTMLCanvasElement | OffscreenCanvas;

type ChunkContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface ChunkRecord {
  canvas: ChunkCanvas;
  ctx: ChunkContext;
  ver: number;
}

interface PendingAction {
  type: 'exit';
  x: number;
  y: number;
}

interface RemoteState {
  id: number;
  name: string;
  tx: number;
  ty: number;
  px: number;
  py: number;
}

interface AvatarPathNode {
  x: number;
  y: number;
}

interface AvatarSegment {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  t: number;
  len: number;
}

export interface SurfaceAvatar {
  x: number;
  y: number;
  px: number;
  py: number;
  t: number;
  speed: number;
  path: AvatarPathNode[];
  sit: boolean;
  name: string;
  _seg?: AvatarSegment | null;
  _bobT?: number;
  _onArrive?: () => void;
  _lastDraw?: { x: number; y: number } | null;
}

const enum TileType {
  Floor = 0,
  Block = 1,
  Prop = 2,
  Pad = 3,
  Exit = 4,
  Cave = 5,
}

export class SurfaceView extends BaseIsoView {
  planet: SurfaceBodyInfo | null = null;
  readonly chunkSize = 32;
  readonly worldW = 256;
  readonly worldH = 256;
  readonly cxCount: number;
  readonly cyCount: number;
  private seed: string;
  private noise: ValueNoise2D;
  private readonly chunks = new Map<string, ChunkRecord>();
  private genVersion = 1;
  readonly spawn: IsoTile;
  readonly pad: IsoTile;
  readonly exit: IsoTile;
  private readonly walkSpeed = 3.2;
  readonly avatar: SurfaceAvatar;
  private readonly onExitCallback: (() => void) | null;
  private pending: PendingAction | null = null;
  private remoteState: Map<RemoteKey, RemoteState> = new Map();

  constructor(canvas: HTMLCanvasElement, opts: SurfaceOptions = {}) {
    const onEscape = typeof opts.onExit === 'function' ? opts.onExit : undefined;
    super(canvas, onEscape ? { onEscape } : {});
    this.seed = opts.seed ?? 'planet';
    this.noise = new ValueNoise2D(this.seed);
    this.cxCount = Math.floor(this.worldW / this.chunkSize);
    this.cyCount = Math.floor(this.worldH / this.chunkSize);
    const sx = Math.floor(this.worldW / 2);
    const sy = Math.floor(this.worldH / 2);
    this.spawn = { x: sx, y: sy };
    this.pad = { x: sx, y: sy };
    this.exit = { x: sx, y: sy - 1 };
    this.avatar = {
      x: sx,
      y: sy,
      px: sx,
      py: sy,
      t: 0,
      speed: this.walkSpeed,
      path: [],
      sit: false,
      name: opts.name ?? 'Du',
    };
    this.onExitCallback = onEscape ?? null;
  }

  setBody(bodyInfo: SurfaceBodyInfo): void {
    this.planet = bodyInfo;
    const seedStr = `${bodyInfo?.name ?? bodyInfo?.type ?? 'planet'}:${bodyInfo?.seed ?? '0'}`;
    this.seed = seedStr;
    this.noise = new ValueNoise2D(this.seed);
    this.genVersion += 1;
    this.avatar.speed = this.walkSpeed;
  }

  override setActive(active: boolean): void {
    super.setActive(active);
    if (active) {
      this.pending = null;
    }
  }

  public override getAvatarTile(): IsoTile {
    return this.avatarTile();
  }

  private avatarTile(): IsoTile {
    return { x: this.avatar.x | 0, y: this.avatar.y | 0 };
  }

  setRemotes(list: SurfaceRemote[]): void {
    const incoming = Array.isArray(list) ? list : [];
    const next = new Map<RemoteKey, RemoteState>();
    for (const entry of incoming) {
      const id = (entry.id >>> 0) || 0;
      const key: RemoteKey = id || `${entry.x},${entry.y}`;
      const prev = this.remoteState.get(key) ?? { px: entry.x, py: entry.y, id, name: entry.name ?? 'Spieler', tx: entry.x, ty: entry.y };
      next.set(key, {
        id,
        name: entry.name ?? 'Spieler',
        tx: entry.x,
        ty: entry.y,
        px: prev.px,
        py: prev.py,
      });
    }
    this.remoteState = next;
  }

  private wrap(x: number, y: number): IsoTile {
    const wx = ((x % this.worldW) + this.worldW) % this.worldW;
    const wy = ((y % this.worldH) + this.worldH) % this.worldH;
    return { x: wx, y: wy };
  }

  private nearestTarget(refX: number, refY: number, tx: number, ty: number): IsoTile {
    let best: IsoTile = { x: tx, y: ty };
    let bestD = Number.POSITIVE_INFINITY;
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        const x = tx + ox * this.worldW;
        const y = ty + oy * this.worldH;
        const dx = x - refX;
        const dy = y - refY;
        const dist = dx * dx + dy * dy;
        if (dist < bestD) {
          bestD = dist;
          best = { x, y };
        }
      }
    }
    return best;
  }

  private findPath(sx: number, sy: number, tx: number, ty: number): AvatarPathNode[] {
    const margin = 32;
    const minX = Math.floor(Math.min(sx, tx)) - margin;
    const maxX = Math.floor(Math.max(sx, tx)) + margin;
    const minY = Math.floor(Math.min(sy, ty)) - margin;
    const maxY = Math.floor(Math.max(sy, ty)) + margin;
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (width <= 0 || height <= 0 || width * height > 120_000) {
      return [];
    }
    const walkable = (x: number, y: number) => this.walkable(x, y);
    const key = (x: number, y: number) => `${x},${y}`;
    const open = new Map<string, { x: number; y: number }>();
    const came = new Map<string, string>();
    const g = new Map<string, number>();
    const f = new Map<string, number>();
    const startKey = key(sx, sy);
    const goalKey = key(tx, ty);
    const heuristic = (x: number, y: number) => Math.hypot(x - tx, y - ty);
    g.set(startKey, 0);
    f.set(startKey, heuristic(sx, sy));
    open.set(startKey, { x: sx, y: sy });
    const neighbors: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    const diagOk = (cx: number, cy: number, nx: number, ny: number) => {
      const dx = nx - cx;
      const dy = ny - cy;
      if (Math.abs(dx) + Math.abs(dy) !== 2) {
        return true;
      }
      return walkable(cx + dx, cy) && walkable(cx, cy + dy) && walkable(nx, ny);
    };
    const popLowest = () => {
      let bestKey: string | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const candidate of open.keys()) {
        const score = f.get(candidate) ?? Number.POSITIVE_INFINITY;
        if (score < bestScore) {
          bestScore = score;
          bestKey = candidate;
        }
      }
      return bestKey;
    };
    let iterations = 0;
    while (open.size) {
      iterations += 1;
      if (iterations > 10_000) {
        break;
      }
      const currentKey = popLowest();
      if (!currentKey) {
        break;
      }
      if (currentKey === goalKey) {
        const out: AvatarPathNode[] = [];
        let trace: string | undefined = currentKey;
        while (trace) {
          const parts = trace.split(',');
          const x = Number.parseInt(parts[0] ?? '0', 10);
          const y = Number.parseInt(parts[1] ?? '0', 10);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            out.unshift({ x, y });
          }
          const parent = came.get(trace);
          if (!parent) {
            break;
          }
          trace = parent;
        }
        return out;
      }
      open.delete(currentKey);
  const currentParts = currentKey.split(',');
  const cx = Number.parseInt(currentParts[0] ?? '0', 10);
  const cy = Number.parseInt(currentParts[1] ?? '0', 10);
      for (const [dx, dy] of neighbors) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < minX || ny < minY || nx > maxX || ny > maxY) {
          continue;
        }
        if (!walkable(nx, ny)) {
          continue;
        }
        if (!diagOk(cx, cy, nx, ny)) {
          continue;
        }
        const neighborKey = key(nx, ny);
        const step = dx === 0 || dy === 0 ? 1 : Math.SQRT2;
        const tentativeG = (g.get(currentKey) ?? Number.POSITIVE_INFINITY) + step;
        if (tentativeG < (g.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
          came.set(neighborKey, currentKey);
          g.set(neighborKey, tentativeG);
          f.set(neighborKey, tentativeG + heuristic(nx, ny));
          open.set(neighborKey, { x: nx, y: ny });
        }
      }
    }
    return [];
  }

  private tileAt(x: number, y: number): TileType {
    const wrapped = this.wrap(x, y);
    if (wrapped.x === this.pad.x && wrapped.y === this.pad.y) {
      return TileType.Pad;
    }
    if (wrapped.x === this.exit.x && wrapped.y === this.exit.y) {
      return TileType.Exit;
    }
    const theme = this.planet?.type ?? 'planet';
    const f = 1 / 32;
    const elevation = this.noise.fbm(wrapped.x * f, wrapped.y * f, 4, 2.0, 0.5);
    const rockNoise = this.noise.noise(wrapped.x * 0.11 + 100, wrapped.y * 0.11 + 33);
    const propNoise = this.noise.noise(wrapped.x * 0.21 - 77, wrapped.y * 0.21 + 9);
    const caveNoise = this.noise.fbm(wrapped.x * 0.36 + 500, wrapped.y * 0.36 - 200, 3, 2.0, 0.5);
    let rockThreshold = 0.78;
    let propThreshold = 0.86;
    if (theme.includes('Wüste') || theme.includes('desert')) {
      rockThreshold = 0.82;
      propThreshold = 0.9;
    }
    if (theme.includes('Eis') || theme.includes('ice')) {
      rockThreshold = 0.75;
      propThreshold = 0.88;
    }
    const land = elevation > 0.42;
    if (!land) {
      return TileType.Block;
    }
    if (rockNoise > rockThreshold) {
      if (caveNoise > 0.62) {
        return TileType.Cave;
      }
      return TileType.Block;
    }
    if (propNoise > propThreshold) {
      return TileType.Prop;
    }
    return TileType.Floor;
  }

  protected override walkable(x: number, y: number): boolean {
    return this.tileAt(x, y) !== TileType.Block;
  }

  private getChunkCanvas(cxi: number, cyi: number): ChunkCanvas {
    const mx = ((cxi % this.cxCount) + this.cxCount) % this.cxCount;
    const my = ((cyi % this.cyCount) + this.cyCount) % this.cyCount;
    const key = `${mx},${my}`;
    let record = this.chunks.get(key);
    if (!record || record.ver !== this.genVersion) {
      const CS = this.chunkSize;
      const tw = Iso.tileW;
      const th = Iso.tileH;
      const width = CS * tw;
      const height = CS * th;
      const canvas: ChunkCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to obtain chunk context');
      }
      ctx.clearRect(0, 0, width, height);
      const worldGX = mx * CS;
      const worldGY = my * CS;
      const xShift = (CS * tw) / 2;
      for (let ty = 0; ty < CS; ty += 1) {
        for (let tx = 0; tx < CS; tx += 1) {
          const gx = worldGX + tx;
          const gy = worldGY + ty;
          const t = this.tileAt(gx, gy);
          const p = Iso.toScreen(tx, ty, 0);
          const sx = p.x + xShift;
          const sy = p.y;
          const theme = this.planet?.type ?? 'planet';
          let fill = 'rgba(20,40,70,0.9)';
          if (theme.includes('Wüste') || theme.includes('desert')) {
            fill = 'rgba(200,160,100,0.9)';
          } else if (theme.includes('Eis') || theme.includes('ice')) {
            fill = 'rgba(210,235,247,0.9)';
          }
          if (t === TileType.Block) {
            fill = theme.includes('Eis') || theme.includes('ice') ? 'rgba(180,200,220,0.95)' : 'rgba(70,70,70,0.95)';
          }
          if (t === TileType.Pad) {
            fill = 'rgba(60,120,60,0.95)';
          }
          if (t === TileType.Exit) {
            fill = 'rgba(120,80,40,0.95)';
          }
          ctx.save();
          ctx.translate(sx, sy);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(tw / 2, th / 2);
          ctx.lineTo(0, th);
          ctx.lineTo(-tw / 2, th / 2);
          ctx.closePath();
          if (t === TileType.Cave) {
            ctx.fillStyle = 'rgba(20,20,30,0.92)';
            ctx.fill();
            ctx.fillStyle = 'rgba(0,0,0,0.25)';
            ctx.beginPath();
            ctx.moveTo(-tw / 2 + 2, th / 2);
            ctx.lineTo(0, th - 2);
            ctx.lineTo(tw / 2 - 2, th / 2);
            ctx.closePath();
            ctx.fill();
          } else {
            ctx.fillStyle = fill;
            ctx.fill();
          }
          if (t === TileType.Prop) {
            ctx.fillStyle = 'rgba(120,120,120,0.85)';
            ctx.fillRect(-6, 6, 12, 8);
          }
          if (t === TileType.Pad) {
            ctx.strokeStyle = 'rgba(240,240,240,0.85)';
            ctx.lineWidth = 2;
            ctx.strokeRect(-12, 6, 24, 6);
            ctx.fillStyle = 'rgba(235,250,255,0.9)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('Landekapsel', 0, 6);
          }
          if (t === TileType.Exit) {
            ctx.fillStyle = 'rgba(255,240,220,0.9)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('Beamen', 0, 6);
          }
          ctx.restore();
        }
      }
      record = { canvas, ctx, ver: this.genVersion };
      this.chunks.set(key, record);
    }
    return record.canvas;
  }

  private toScreenWrapped(ix: number, iy: number, lastScreen: { x: number; y: number } | null): { x: number; y: number } {
    let best: { x: number; y: number } | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        const x = ix + ox * this.worldW;
        const y = iy + oy * this.worldH;
        const pos = Iso.toScreen(x, y, 0);
        if (!lastScreen) {
          const dist = ox === 0 && oy === 0 ? 0 : 1e6;
          if (dist < bestD) {
            bestD = dist;
            best = pos;
          }
        } else {
          const dx = pos.x - lastScreen.x;
          const dy = pos.y - lastScreen.y;
          const dist = dx * dx + dy * dy;
          if (dist < bestD) {
            bestD = dist;
            best = pos;
          }
        }
      }
    }
    return best ?? { x: ix, y: iy };
  }

  protected override tryStep(dx: number, dy: number): void {
    const nx = this.avatar.x + dx;
    const ny = this.avatar.y + dy;
    if (this.walkable(nx, ny)) {
      this.avatar.path = [{ x: nx, y: ny }];
    }
  }

  protected override handleClick(mx: number, my: number): void {
    const { ix, iy } = this.screenToIso(mx, my);
    const destTileType = this.tileAt(ix, iy);
    if (destTileType === TileType.Block) {
      return;
    }
    if (destTileType === TileType.Exit) {
      const onTile = (this.avatar.x | 0) === (ix | 0) && (this.avatar.y | 0) === (iy | 0);
      if (onTile) {
        this.onExitCallback?.();
        return;
      }
      this.pending = { type: 'exit', x: ix | 0, y: iy | 0 };
    }
    const near = this.nearestTarget(this.avatar.x, this.avatar.y, ix, iy);
    const path = this.findPath(this.avatar.x | 0, this.avatar.y | 0, near.x | 0, near.y | 0);
    if (path.length) {
      this.avatar.path = path;
    } else {
      this.avatar.path = [{ x: near.x | 0, y: near.y | 0 }];
    }
  }

  frame(dt: number): void {
    if (!this.active) {
      return;
    }
    const av = this.avatar;
    const speed = av.speed;
    if (av.path && av.path.length) {
      if (!av._seg) {
        const target = av.path[0]!;
        const len = Math.hypot(target.x - av.px, target.y - av.py) || 1;
        av._seg = { sx: av.px, sy: av.py, tx: target.x, ty: target.y, t: 0, len };
      }
      const seg = av._seg;
      if (seg) {
        seg.t += (dt * speed) / (seg.len || 1);
        const t = Math.min(1, seg.t);
        av.px = seg.sx + (seg.tx - seg.sx) * t;
        av.py = seg.sy + (seg.ty - seg.sy) * t;
        if (t >= 1) {
          const wrapped = this.wrap(seg.tx, seg.ty);
          av.x = wrapped.x;
          av.y = wrapped.y;
          av.px = av.x;
          av.py = av.y;
          av.path.shift();
          av._seg = null;
          if (av._onArrive) {
            const fn = av._onArrive;
            delete av._onArrive;
            try {
              fn();
            } catch {
              // ignore
            }
          }
          if (this.tileAt(av.x, av.y) === TileType.Exit) {
            if (this.pending && this.pending.type === 'exit' && (this.pending.x | 0) === (av.x | 0) && (this.pending.y | 0) === (av.y | 0)) {
              this.pending = null;
              this.onExitCallback?.();
            }
          }
        }
      }
    } else {
      av.px = av.x;
      av.py = av.y;
      av._seg = null;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);

    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;
    const base = this.planet?.type ?? 'planet';
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    if (base.includes('Eis') || base.includes('ice')) {
      sky.addColorStop(0, '#bcdfff');
      sky.addColorStop(1, '#6aa9ff');
    } else if (base.includes('Wüste') || base.includes('desert')) {
      sky.addColorStop(0, '#ffd8a3');
      sky.addColorStop(1, '#ffb35e');
    } else {
      sky.addColorStop(0, '#a0c8ff');
      sky.addColorStop(1, '#4b85ff');
    }
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    ctx.translate(width / 2, height / 2);
    ctx.scale(this.scale, this.scale);
    ctx.translate(this.offset.x, this.offset.y);

    const corners = [
      this.screenToIso(0, 0),
      this.screenToIso(this.canvas.width, 0),
      this.screenToIso(0, this.canvas.height),
      this.screenToIso(this.canvas.width, this.canvas.height),
    ];
    let minIx = Number.POSITIVE_INFINITY;
    let maxIx = Number.NEGATIVE_INFINITY;
    let minIy = Number.POSITIVE_INFINITY;
    let maxIy = Number.NEGATIVE_INFINITY;
    for (const c of corners) {
      if (c.ix < minIx) minIx = c.ix;
      if (c.ix > maxIx) maxIx = c.ix;
      if (c.iy < minIy) minIy = c.iy;
      if (c.iy > maxIy) maxIy = c.iy;
    }
    const CS = this.chunkSize;
    minIx -= CS;
    maxIx += CS;
    minIy -= CS;
    maxIy += CS;
    const minCX = Math.floor(minIx / CS) - 1;
    const maxCX = Math.floor(maxIx / CS) + 1;
    const minCY = Math.floor(minIy / CS) - 1;
    const maxCY = Math.floor(maxIy / CS) + 1;
    for (let cy = minCY; cy <= maxCY; cy += 1) {
      for (let cx = minCX; cx <= maxCX; cx += 1) {
        const chunkCanvas = this.getChunkCanvas(cx, cy);
        const gx = cx * CS;
        const gy = cy * CS;
        const p0 = Iso.toScreen(gx, gy, 0);
        const shiftX = (CS * Iso.tileW) / 2;
        ctx.drawImage(chunkCanvas as CanvasImageSource, p0.x - shiftX, p0.y);
      }
    }

    if (this.hover) {
      const { x: hx, y: hy } = this.hover;
      const hp = Iso.toScreen(hx, hy, 0);
      ctx.save();
      ctx.translate(hp.x, hp.y);
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

    const avatarScreen = this.toScreenWrapped(av.px, av.py, av._lastDraw ?? null);
    const biasY = 20;
    const targetX = -avatarScreen.x;
    const targetY = -avatarScreen.y + biasY;
    const followK = 10;
    const followAlpha = 1 - Math.exp(-followK * dt);
    this.offset.x += (targetX - this.offset.x) * followAlpha;
    this.offset.y += (targetY - this.offset.y) * followAlpha;

    const p = this.toScreenWrapped(av.px, av.py, av._lastDraw ?? null);
    const moving = !!(av.path && av.path.length);
    av._bobT = (av._bobT ?? 0) + (moving ? dt * 7 : dt * 2);
    const bob = Math.sin(av._bobT) * (moving ? 1.2 : 0.2);
    ctx.save();
    ctx.translate(p.x, p.y - 8 - bob);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath();
    ctx.arc(0, 10, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(180,255,200,0.95)';
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(220,245,255,0.95)';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(this.planet?.name ?? '–', 0, -12);
    ctx.restore();
  av._lastDraw = p;

    if (this.remoteState.size) {
      const refX = av.px;
      const refY = av.py;
      for (const [, state] of this.remoteState) {
        let best: { x: number; y: number } | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const tx = state.tx + ox * this.worldW;
            const ty = state.ty + oy * this.worldH;
            const dx = tx - refX;
            const dy = ty - refY;
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) {
              bestDist = dist;
              best = { x: tx, y: ty };
            }
          }
        }
        const smoothK = 12;
        const smoothAlpha = 1 - Math.exp(-smoothK * dt);
        if (best) {
          state.px += (best.x - state.px) * smoothAlpha;
          state.py += (best.y - state.py) * smoothAlpha;
        }
        const rp = Iso.toScreen(state.px, state.py, 0);
        ctx.save();
        ctx.translate(rp.x, rp.y - 8);
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath();
        ctx.arc(0, 10, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,180,120,0.95)';
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(240,255,255,0.95)';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(state.name || 'Spieler', 0, -12);
        ctx.restore();
      }
    }

    ctx.restore();
  }
}
