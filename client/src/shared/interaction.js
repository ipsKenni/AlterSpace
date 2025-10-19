// Unified interaction API for iso views (surface and interior)
// Contract:
// - requestAction(kind, payload): enqueue an action (moveTo, interact)
// - onActionComplete(kind, payload): callback when an action finished
// - kinds: 'moveTo' {x,y}, 'interact' {x,y,type}

export class InteractionQueue {
  constructor() { this._q = []; this.onComplete = null; }
  clear() { this._q.length = 0; }
  enqueue(kind, payload) { this._q.push({ kind, payload }); }
  peek() { return this._q[0] || null; }
  shift() { return this._q.shift() || null; }
}

// Helper to run move-then-interact for tile-based iso views
export function runMoveThenInteract(view, avatar, target, onArrive) {
  // view must implement: pathTo(tx,ty,grid,av) or expose path method
  if (!view || !avatar || typeof target?.x !== 'number' || typeof target?.y !== 'number') return;
  avatar.sit = false;
  if (typeof view._walkable === 'function' && typeof view._tileAt === 'function') {
    const path = view.pathTo ? view.pathTo(target.x, target.y, avatar) : (view._findPath ? view._findPath(avatar.x|0, avatar.y|0, target.x|0, target.y|0) : []);
    if (path && path.length) avatar.path = path; else avatar.path = [{ x: target.x|0, y: target.y|0 }];
  }
  avatar._onArrive = onArrive;
}
