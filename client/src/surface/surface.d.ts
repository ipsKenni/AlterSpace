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

export interface SurfaceAvatar {
  x: number;
  y: number;
  px: number;
  py: number;
  speed: number;
  path: Array<{ x: number; y: number }>;
  name: string;
  [key: string]: unknown;
}

export class SurfaceView {
  constructor(canvas: HTMLCanvasElement, opts?: SurfaceOptions);

  pad?: { x: number; y: number };
  avatar: SurfaceAvatar;

  setActive(active: boolean): void;
  resize(): void;
  frame(dt: number): void;
  setBody(body: SurfaceBodyInfo): void;
  setRemotes(remotes: SurfaceRemote[]): void;
  getAvatarTile(): { x: number; y: number };
}
