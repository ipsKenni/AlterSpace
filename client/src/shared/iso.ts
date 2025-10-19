// Shared isometric helpers and simple A* pathfinding

export interface IsoPoint {
  x: number;
  y: number;
}

export interface Iso3DPoint extends IsoPoint {
  z?: number;
}

export type Grid = number[][];

export const Iso = {
  tileW: 64,
  tileH: 32,
  toScreen(ix: number, iy: number, iz = 0): IsoPoint {
    const x = (ix - iy) * (this.tileW / 2);
    const y = (ix + iy) * (this.tileH / 2) - iz;
    return { x, y };
  },
} as const;

export function pathTo(targetX: number, targetY: number, grid: Grid, start: { x: number; y: number }): IsoPoint[] {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  if (height === 0 || width === 0) {
    return [];
  }
  const walkable = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return false;
    }
    const row = grid[y];
    const cell = row?.[x];
    return cell !== 1;
  };
  const key = (x: number, y: number) => `${x},${y}`;
  const open = new Map<string, IsoPoint>();
  const came = new Map<string, string>();
  const g = new Map<string, number>();
  const f = new Map<string, number>();
  const startKey = key(start.x, start.y);
  const goalKey = key(targetX, targetY);
  const heuristic = (x: number, y: number) => Math.abs(x - targetX) + Math.abs(y - targetY);
  g.set(startKey, 0);
  f.set(startKey, heuristic(start.x, start.y));
  open.set(startKey, { x: start.x, y: start.y });
  const parseCoord = (value: string): number | null => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const getLowest = () => {
    let bestKey: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const k of open.keys()) {
      const value = f.get(k) ?? Number.POSITIVE_INFINITY;
      if (value < best) {
        best = value;
        bestKey = k;
      }
    }
    return bestKey;
  };
  const neighbors: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let iter = 0;
  while (open.size) {
    if (++iter > 4000) {
      break;
    }
    const currentKey = getLowest();
    if (!currentKey) {
      break;
    }
    const parts = currentKey.split(',');
    const cxRaw = parseCoord(parts[0] ?? '');
    const cyRaw = parseCoord(parts[1] ?? '');
    if (cxRaw === null || cyRaw === null) {
      break;
    }
    const cx = cxRaw;
    const cy = cyRaw;
    if (currentKey === goalKey) {
      const path: IsoPoint[] = [];
      let nodeKey = currentKey;
      while (came.has(nodeKey)) {
        const [pxPart, pyPart] = nodeKey.split(',');
        const px = parseCoord(pxPart ?? '');
        const py = parseCoord(pyPart ?? '');
        if (px !== null && py !== null) {
          path.unshift({ x: px, y: py });
        }
        const parent = came.get(nodeKey);
        if (!parent) {
          break;
        }
        nodeKey = parent;
      }
      return path;
    }
    open.delete(currentKey);
    for (const [dx, dy] of neighbors) {
  const nx = cx + dx;
  const ny = cy + dy;
      if (!walkable(nx, ny)) {
        continue;
      }
      const neighborKey = key(nx, ny);
      const tentativeG = (g.get(currentKey) ?? Number.POSITIVE_INFINITY) + 1;
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
