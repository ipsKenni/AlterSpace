// Unified interaction API for iso views (surface and interior)
// Contract:
// - requestAction(kind, payload): enqueue an action (moveTo, interact)
// - onActionComplete(kind, payload): callback when an action finished
// - kinds: 'moveTo' {x,y}, 'interact' {x,y,type}

export type InteractionKind = 'moveTo' | 'interact';

export interface InteractionEntry<TPayload = unknown> {
  kind: InteractionKind;
  payload: TPayload;
}

export class InteractionQueue<TPayload = unknown> {
  private readonly queue: InteractionEntry<TPayload>[] = [];
  onComplete: ((kind: InteractionKind, payload: TPayload) => void) | null = null;

  clear(): void {
    this.queue.length = 0;
  }

  enqueue(kind: InteractionKind, payload: TPayload): void {
    this.queue.push({ kind, payload });
  }

  peek(): InteractionEntry<TPayload> | null {
    return this.queue[0] ?? null;
  }

  shift(): InteractionEntry<TPayload> | null {
    return this.queue.shift() ?? null;
  }
}

export interface IsoAvatar {
  x: number;
  y: number;
  path: Array<{ x: number; y: number }>;
  sit?: boolean;
  _onArrive?: (() => void) | null;
}

export interface IsoViewLike {
  pathTo?(tx: number, ty: number, avatar: IsoAvatar): Array<{ x: number; y: number }>;
  _findPath?(sx: number, sy: number, tx: number, ty: number): Array<{ x: number; y: number }>;
  _walkable?(x: number, y: number): boolean;
}

export function runMoveThenInteract(view: IsoViewLike | null, avatar: IsoAvatar | null, target: { x: number; y: number } | null | undefined, onArrive: (() => void) | null): void {
  if (!view || !avatar || typeof target?.x !== 'number' || typeof target?.y !== 'number') {
    return;
  }
  avatar.sit = false;
  let path: Array<{ x: number; y: number }> | null = null;
  if (typeof view.pathTo === 'function') {
    path = view.pathTo(target.x, target.y, avatar);
  } else if (typeof view._findPath === 'function') {
    path = view._findPath(avatar.x | 0, avatar.y | 0, target.x | 0, target.y | 0);
  }
  if (path && path.length > 0) {
    avatar.path = path;
  } else {
    avatar.path = [{ x: target.x | 0, y: target.y | 0 }];
  }
  avatar._onArrive = onArrive ?? null;
}
