// Shared isometric helpers and simple A* pathfinding
export const Iso = {
  tileW: 64,
  tileH: 32,
  toScreen(ix, iy, iz = 0) {
    const x = (ix - iy) * (this.tileW / 2);
    const y = (ix + iy) * (this.tileH / 2) - iz;
    return { x, y };
  }
};

// A* pathfinding over 4-neighborhood
export function pathTo(targetX, targetY, grid, start) {
  const H = grid.length, W = grid[0].length;
  const walkable = (x, y) => x >= 0 && y >= 0 && x < W && y < H && grid[y][x] !== 1; // 1 = wall/blocked
  const key = (x, y) => `${x},${y}`;
  const open = new Map();
  const came = new Map();
  const g = new Map();
  const f = new Map();
  const startK = key(start.x, start.y), goalK = key(targetX, targetY);
  const h = (x, y) => Math.abs(x - targetX) + Math.abs(y - targetY);
  g.set(startK, 0); f.set(startK, h(start.x, start.y)); open.set(startK, { x: start.x, y: start.y });
  const getLowest = () => {
    let bestK = null, bestF = Infinity; for (const k of open.keys()) { const fv = f.get(k) ?? Infinity; if (fv < bestF) { bestF = fv; bestK = k; } }
    return bestK;
  };
  const neigh = [ [1,0], [-1,0], [0,1], [0,-1] ];
  let iter = 0;
  while (open.size) {
    if (++iter > 4000) break; // safety
    const curK = getLowest(); const [cx, cy] = curK.split(',').map(n => parseInt(n, 10));
    if (curK === goalK) {
      // reconstruct
      const out = []; let ck = curK; while (came.has(ck)) { const [x, y] = ck.split(',').map(n => parseInt(n, 10)); out.unshift({ x, y }); ck = came.get(ck); }
      return out;
    }
    open.delete(curK);
    for (const [dx, dy] of neigh) {
      const nx = cx + dx, ny = cy + dy; if (!walkable(nx, ny)) continue; const nk = key(nx, ny);
      const tg = (g.get(curK) ?? Infinity) + 1; if (tg < (g.get(nk) ?? Infinity)) { came.set(nk, curK); g.set(nk, tg); f.set(nk, tg + h(nx, ny)); open.set(nk, { x: nx, y: ny }); }
    }
  }
  return [];
}
