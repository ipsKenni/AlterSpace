// Ship interior renderer: simple isometric room with avatar
import { Iso, pathTo } from '../shared/iso.ts';
import { BaseIsoView, IsoTile } from '../shared/baseIsoView.ts';

interface InteriorOptions {
  name?: string;
  onExit?: () => void;
  onConsole?: () => void;
}

interface AvatarState {
  x: number;
  y: number;
  px: number;
  py: number;
  t: number;
  speed: number;
  path: Array<{ x: number; y: number }>;
  sit: boolean;
  name: string;
  _seg?: { sx: number; sy: number; tx: number; ty: number; t: number; len: number } | null;
  _bobT?: number;
  _onArrive?: () => void;
}

type PendingType = 2 | 3 | 4;

interface PendingAction {
  type: PendingType;
  x: number;
  y: number;
}

export class ShipInterior extends BaseIsoView {
  readonly gridW = 12;
  readonly gridH = 10;
  protected override grid: number[][];
  readonly avatar: AvatarState;
  private readonly onExitCallback: (() => void) | null;
  private readonly onConsoleCallback: (() => void) | null;
  private pending: PendingAction | null = null;

  constructor(canvas: HTMLCanvasElement, opts: InteriorOptions = {}) {
    super(canvas, opts.onExit ? { onEscape: opts.onExit } : undefined);
    this.grid = this.makeGrid();
    this.avatar = {
      x: 2,
      y: 2,
      px: 2,
      py: 2,
      t: 0,
      speed: 5.5,
      path: [],
      sit: false,
      name: opts.name ?? 'Du',
    };
    this.onExitCallback = typeof opts.onExit === 'function' ? opts.onExit : null;
    this.onConsoleCallback = typeof opts.onConsole === 'function' ? opts.onConsole : null;
  }

  private makeGrid(): number[][] {
    const w = this.gridW;
    const h = this.gridH;
    const g = Array.from({ length: h }, () => Array.from({ length: w }, () => 0));
    for (let x = 0; x < w; x += 1) {
      g[0]![x] = 1;
      g[h - 1]![x] = 1;
    }
    for (let y = 0; y < h; y += 1) {
      g[y]![0] = 1;
      g[y]![w - 1] = 1;
    }
    g[4]![4] = 2;
    g[4]![5] = 2;
    g[5]![4] = 2;
    g[5]![6] = 2;
    g[6]![5] = 2;
    g[h - 1]![Math.floor(w / 2)] = 3;
    g[2]![w - 3] = 4;
    return g;
  }

  protected override handleClick(mx: number, my: number): void {
    const { ix, iy } = this.screenToIso(mx, my);
    const tx = Math.max(0, Math.min(this.gridW - 1, ix));
    const ty = Math.max(0, Math.min(this.gridH - 1, iy));
    const tile = this.grid[ty]?.[tx] ?? 0;
    const avatar = this.avatar;
    if (tile === 1) {
      return;
    }
    if (tile === 3) {
      if ((avatar.x | 0) === tx && (avatar.y | 0) === ty) {
        this.onExitCallback?.();
        return;
      }
      avatar.sit = false;
    this.pending = { type: 3, x: tx, y: ty };
    avatar.path = pathTo(tx, ty, this.grid, avatar);
      return;
    }
    if (tile === 4) {
      if ((avatar.x | 0) === tx && (avatar.y | 0) === ty) {
        this.onConsoleCallback?.();
        return;
      }
      avatar.sit = false;
    this.pending = { type: 4, x: tx, y: ty };
    avatar.path = pathTo(tx, ty, this.grid, avatar);
      return;
    }
    if (tile === 2) {
      if ((avatar.x | 0) === tx && (avatar.y | 0) === ty) {
        avatar.sit = !avatar.sit;
        return;
      }
      avatar.sit = false;
    this.pending = { type: 2, x: tx, y: ty };
    avatar.path = pathTo(tx, ty, this.grid, avatar);
      return;
    }
    avatar.sit = false;
    avatar.path = pathTo(tx, ty, this.grid, avatar);
  }

  protected override tryStep(dx: number, dy: number): void {
    const nx = this.avatar.x + dx;
    const ny = this.avatar.y + dy;
    if (this.walkable(nx, ny)) {
      this.avatar.sit = false;
      this.avatar.path = [{ x: nx, y: ny }];
    }
  }

  protected override getAvatarTile(): IsoTile {
    return { x: this.avatar.x | 0, y: this.avatar.y | 0 };
  }

  frame(dt: number): void {
    if (!this.active) {
      return;
    }
    const avatar = this.avatar;
    const speed = avatar.speed;
    if (avatar.path.length) {
      if (!avatar._seg) {
        const target = avatar.path[0]!;
        const len = Math.hypot(target.x - avatar.px, target.y - avatar.py) || 1;
        avatar._seg = { sx: avatar.px, sy: avatar.py, tx: target.x, ty: target.y, t: 0, len };
      }
      const seg = avatar._seg;
      if (seg) {
        seg.t += (dt * speed) / (seg.len || 1);
        const t = Math.min(1, seg.t);
        avatar.px = seg.sx + (seg.tx - seg.sx) * t;
        avatar.py = seg.sy + (seg.ty - seg.sy) * t;
        if (t >= 1) {
          avatar.x = seg.tx;
          avatar.y = seg.ty;
          avatar.px = avatar.x;
          avatar.py = avatar.y;
          avatar.path.shift();
          avatar._seg = null;
          const onArrive = avatar._onArrive;
          delete avatar._onArrive;
          if (onArrive) {
            try {
              onArrive();
            } catch {
              /* ignore */
            }
          }
        }
      }
    } else {
      avatar.px = avatar.x;
      avatar.py = avatar.y;
      avatar._seg = null;
    }

    if (this.pending && (avatar.x | 0) === (this.pending.x | 0) && (avatar.y | 0) === (this.pending.y | 0)) {
      const pending = this.pending;
      this.pending = null;
      if (!pending) {
        return;
      }
      if (pending.type === 2) {
        avatar.sit = true;
      } else if (pending.type === 3) {
        this.onExitCallback?.();
      } else if (pending.type === 4) {
        this.onConsoleCallback?.();
      }
    }

    const tile = this.grid[avatar.y | 0]?.[avatar.x | 0] ?? 0;
    if (!this.pending && tile === 3) {
      this.onExitCallback?.();
    } else if (!this.pending && tile === 4) {
      this.onConsoleCallback?.();
    }

    const pp = Iso.toScreen(avatar.px, avatar.py, 0);
    const tx = -pp.x;
    const ty = -pp.y + 16;
    const k = 10;
    const a = 1 - Math.exp(-k * dt);
    this.offset.x += (tx - this.offset.x) * a;
    this.offset.y += (ty - this.offset.y) * a;

    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);

    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    ctx.translate(w / 2, h / 2);
    ctx.scale(this.scale, this.scale);
    ctx.translate(this.offset.x, this.offset.y);

    for (let y = 0; y < this.gridH; y += 1) {
      for (let x = 0; x < this.gridW; x += 1) {
        const { x: sx, y: sy } = Iso.toScreen(x, y, 0);
    const tileVal = this.grid[y]?.[x] ?? 0;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Iso.tileW / 2, Iso.tileH / 2);
        ctx.lineTo(0, Iso.tileH);
        ctx.lineTo(-Iso.tileW / 2, Iso.tileH / 2);
        ctx.closePath();
        ctx.fillStyle = tileVal === 1
          ? 'rgba(30,60,90,0.95)'
          : tileVal === 3
            ? 'rgba(40,90,60,0.95)'
            : tileVal === 4
              ? 'rgba(60,50,90,0.95)'
              : 'rgba(20,40,70,0.9)';
        ctx.fill();
        if (tileVal === 2) {
          ctx.fillStyle = 'rgba(180,220,255,0.9)';
          ctx.fillRect(-6, 6, 12, 8);
        }
        if (tileVal === 4) {
          ctx.fillStyle = 'rgba(160,220,255,0.9)';
          ctx.fillRect(-10, 2, 20, 6);
          ctx.fillStyle = 'rgba(220,255,240,0.85)';
          ctx.font = '10px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('PULT', 0, 6);
        }
        if (tileVal === 3) {
          ctx.fillStyle = 'rgba(220,255,220,0.85)';
          ctx.font = '10px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('Tür', 0, 6);
        }
        if (this.hover && this.hover.x === x && this.hover.y === y) {
          ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    const p = Iso.toScreen(avatar.px, avatar.py, 0);
    const moving = avatar.path.length > 0;
    avatar._bobT = (avatar._bobT ?? 0) + (moving ? dt * 8 : dt * 2);
    const bob = Math.sin(avatar._bobT) * (moving ? 2.2 : 0.5);
    ctx.save();
    ctx.translate(p.x, p.y - 8 - bob);
    ctx.fillStyle = avatar.sit ? 'rgba(255,200,0,0.95)' : 'rgba(0,255,180,0.9)';
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(220,245,255,0.95)';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(avatar.name, 0, -12);
    ctx.restore();

    ctx.restore();
  }

}
