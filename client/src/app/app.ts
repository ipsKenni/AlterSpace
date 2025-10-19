// Anwendung/Controller: Verbindet Eingabe, Renderer, Welt und HUD
//
// Best Practices:
// - UI-Bindings klar getrennt vom Kern
// - Typisierte Datenstrukturen für Remote-Spieler und Auswahlzustände

import { Vec2 } from '../core/math.ts';
import { PRNG } from '../core/prng.ts';
import { Camera } from '../core/camera.ts';
import { InputController } from '../core/input.ts';
import { WORLD } from './constants.ts';
import { ChunkManager } from './chunks.ts';
import { PlayerShip, Ship } from './model.ts';
import { Renderer, type RendererSettings, type RenderShip, type ScreenObject, type Selection } from '../render/renderer.ts';
import { NetClient, type BeamRequestEvent, type BeamResponseEvent, type ChatEvent, type RemoteMoveEvent } from '../net/client.ts';
import { ScaleTiers } from './scale.ts';
import { ShipInterior } from '../interior/interior.ts';
import { SurfaceView } from '../surface/index.ts';

import type { Moon, Planet, Star } from './model.ts';
import type { SnapshotEntry } from '../net/protocol.ts';

const enum ViewMode {
  Space = 'space',
  Interior = 'interior',
  Surface = 'surface',
}

interface AppSettings extends RendererSettings {
  renderCities: boolean;
  zoomSpeed: number;
  shipCount: number;
  followShip: boolean;
  multiplayer: boolean;
  signalUrl: string;
}

interface UniverseAppOptions {
  seed: string;
  token: string;
  playerName: string;
}

interface AutoFocusState {
  targetZoom: number;
  speed: number;
}

interface RemoteShipState {
  pos: Vec2;
  target: Vec2;
  last: number;
  name: string;
  hash: number;
  dir: number;
  scene: number;
  body: number;
  tileX: number;
  tileY: number;
}

interface PresenceState {
  scene: number;
  body: number;
  tileX: number;
  tileY: number;
  ship: number;
}

interface BeamPresence {
  scene: number;
  body: number;
  tileX: number;
  tileY: number;
  ship: number;
}

interface NearPlayerEntry {
  name: string;
  hash: number;
  dist2: number;
}

const enum SceneId {
  Space = 0,
  Surface = 1,
  Interior = 2,
}

const PLANET_INFO_ID = 'planetInfo';
const SELECTION_PANEL_ID = 'selectionInfo';
const CHAT_BOX_ID = 'chatBox';
const CHAT_NEARBY_ID = 'nearbyList';
const HUD_ID = 'hud';

const D_PAD_QUERY = '(max-width: 900px)';
const PICK_DISTANCE_THRESHOLD = 30;
const LAND_DISTANCE_THRESHOLD = 40;

export class UniverseApp {
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  view: ViewMode = ViewMode.Space;
  readonly settings: AppSettings;
  manager: ChunkManager;
  readonly renderer: Renderer;
  private readonly authToken: string;
  private readonly initialPlayerName: string;

  readonly interiorCanvas: HTMLCanvasElement;
  readonly interior: ShipInterior;
  readonly surfaceCanvas: HTMLCanvasElement;
  readonly surface: SurfaceView;

  focusPlanet: Planet | null = null;
  selection: Selection | null = null;
  autoFocus: AutoFocusState | null = null;
  readonly input: InputController;

  ships: RenderShip[] = [];
  playerShip: PlayerShip;

  readonly remoteShips = new Map<number, RemoteShipState>();
  net: NetClient | null = null;

  private _remoteRenderList: RenderShip[] = [];
  private _updateViewSwitch: (() => void) | null = null;
  private _nearSet: Set<number> | null = null;
  private _fpsAcc = 0;
  private _lastViewStr = '';
  private _beamPresence: BeamPresence = { scene: SceneId.Space, body: 0, tileX: 0, tileY: 0, ship: 0 };

  currentId: string | null = null;
  running = true;

  private getEnv(): Record<string, unknown> {
    const meta = import.meta as ImportMeta & { env?: Record<string, unknown> };
    return meta.env ?? {};
  }

  private setCameraPosition(pos: Vec2): void {
    this.camera.pos.x = pos.x;
    this.camera.pos.y = pos.y;
  }

  constructor(canvas: HTMLCanvasElement, options?: UniverseAppOptions) {
    const seed = options?.seed?.trim() || 'sol-42';
    this.authToken = options?.token ?? '';
    this.initialPlayerName = options?.playerName?.trim() || 'Du';

    this.canvas = canvas;
    this.camera = new Camera();

    const env = this.getEnv();
    const configuredSignalUrl = typeof env['VITE_SIGNAL_URL'] === 'string' ? String(env['VITE_SIGNAL_URL']) : '';

    this.settings = {
      seed,
      starDensity: 1,
      planetDensity: 1,
      shipCount: 12,
      animSpeed: 1,
      zoomSpeed: 1,
      labels: true,
      renderStars: true,
      renderPlanets: true,
      renderOrbits: true,
      renderMoons: true,
      renderCities: true,
      renderGrid: true,
      renderShips: true,
      followShip: false,
      multiplayer: true,
      signalUrl: configuredSignalUrl,
    };

    const nameInputBootstrap = document.getElementById('playerName') as HTMLInputElement | null;
    if (nameInputBootstrap && !nameInputBootstrap.value.trim()) {
      nameInputBootstrap.value = this.initialPlayerName;
    }

    this.manager = new ChunkManager(this.settings.seed);
    this.renderer = new Renderer(canvas, this.camera, this.manager, this.settings);

    this.interiorCanvas = this.ensureCanvas('interiorCanvas');
    this.interior = new ShipInterior(this.interiorCanvas, {
      name: this.resolvePlayerName(),
      onExit: () => {
        this.view = ViewMode.Space;
        this._updateViewSwitch?.();
      },
      onConsole: () => {
        this.view = ViewMode.Space;
        this.settings.followShip = true;
        const follow = this.getElement<HTMLInputElement>('followShip');
        if (follow) {
          follow.checked = true;
        }
        this._updateViewSwitch?.();
      },
    });

    this.surfaceCanvas = this.ensureCanvas('surfaceCanvas');
    this.surface = new SurfaceView(this.surfaceCanvas, {
      seed: this.settings.seed,
      name: this.resolvePlayerName(),
      onExit: () => {
        this.view = ViewMode.Interior;
        this._updateViewSwitch?.();
      },
    });

    this.focusPlanet = null;
    this.playerShip = new PlayerShip(new Vec2(0, 0));
    this.input = new InputController(canvas, this.camera, this.settings, this);
    this._spawnShips();

    if (this.settings.multiplayer) {
      this.setupNetworking();
    }

    this._hookHUD();
    this._bindResize();
    this._bindPicking();
    this._bindViewSwitch();
    this._initStartView();
    this._loop();
  }

  // region --- Initialisation helpers -------------------------------------------------------

  private setupNetworking(): void {
    if (!this.authToken) {
      console.warn('[net] Multiplayer deaktiviert: kein Registrierungstoken.');
      return;
    }
    const url = this.settings.signalUrl || this._computeSignalUrl();
    const client = new NetClient({
      url,
      token: this.authToken,
      onSnapshot: (list) => this._applySnapshot(list),
    });

    client.onChat = (event) => this._onChat(event);
    client.onBeamRequest = (event) => this.handleBeamRequest(event);
    client.onBeamResponse = (event) => this.handleBeamResponse(event);
    client.onRemoteMove = (event) => this.handleRemoteMove(event);

    client.connect().catch(() => {
      /* ignore connection failure; run locally */
    });

    this.net = client;
  }

  private ensureCanvas(id: string): HTMLCanvasElement {
    const existing = document.getElementById(id) as HTMLCanvasElement | null;
    if (existing) {
      return existing;
    }
    const canvas = document.createElement('canvas');
    canvas.id = id;
    document.body.appendChild(canvas);
    return canvas;
  }

  private resolvePlayerName(): string {
    const playerNameInput = document.getElementById('playerName') as HTMLInputElement | null;
    const value = playerNameInput?.value?.trim();
    if (value && value.length) {
      return value;
    }
    if (this.initialPlayerName) {
      return this.initialPlayerName;
    }
    return 'Du';
  }

  private _initStartView(): void {
    if ((location.hash ?? '').length > 1) {
      return;
    }
  this.setCameraPosition(new Vec2(0, 0));
    this.camera.zoom = 0.3;
  }

  private _bindResize(): void {
    let rafId = 0;
    const scheduleResize = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        this.renderer.resize();
        this.interior.resize();
        this.surface.resize();
      });
    };

    window.addEventListener('resize', scheduleResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleResize, { passive: true });
    }

    this.renderer.resize();
    this.interior.resize();
    this.surface.resize();
  }

  private _bindPicking(): void {
    this.canvas.addEventListener('click', (event) => {
      if (this.view !== ViewMode.Space) {
        return;
      }
      const world = this.camera.screenToWorld(new Vec2(event.clientX, event.clientY), this.canvas);
      const pick = this._pickObject(world);
      if (!pick) {
        return;
      }
      this._selectFromPick(pick);
    });

    this.canvas.addEventListener('contextmenu', (event) => {
      if (this.view !== ViewMode.Space) {
        return false;
      }
      event.preventDefault();
      const world = this.camera.screenToWorld(new Vec2(event.clientX, event.clientY), this.canvas);
      const pick = this._pickObject(world);
      if (!pick) {
        this.playerShip.target = world.clone();
        this.net?.sendMoveTarget(this.playerShip.target.x, this.playerShip.target.y);
        return false;
      }
      if (pick.kind === 'star') {
        this.playerShip.target = pick.obj.pos.clone();
      } else if (pick.kind === 'planet') {
        this.playerShip.target = pick.obj.pos.clone();
      } else if (pick.kind === 'moon') {
        const moon = pick.obj.moon;
        const planet = pick.obj.planet;
        const mx = planet.pos.x + Math.cos(moon.ang) * (planet.radius + moon.dist);
        const my = planet.pos.y + Math.sin(moon.ang) * (planet.radius + moon.dist);
        this.playerShip.target = new Vec2(mx, my);
      }
      this.net?.sendMoveTarget(this.playerShip.target.x, this.playerShip.target.y);
      return false;
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.focusPlanet = null;
        this.renderer.focusPlanet = null;
        this.autoFocus = null;
        const panel = this.getElement<HTMLElement>(PLANET_INFO_ID);
        if (panel) {
          panel.style.display = 'none';
        }
      }
    });

    window.addEventListener('hashchange', () => this._navigateFromHash());
    this._navigateFromHash();
  }

  onTap(clientX: number, clientY: number): void {
    if (this.view !== ViewMode.Space) {
      return;
    }
    const world = this.camera.screenToWorld(new Vec2(clientX, clientY), this.canvas);
    const pick = this._pickObject(world);
    if (!pick) {
      return;
    }
    this._selectFromPick(pick);
  }

  private _bindViewSwitch(): void {
    const button = this.getElement<HTMLButtonElement>('viewSwitch');
    if (!button) {
      return;
    }

    const update = () => {
      const isInterior = this.view === ViewMode.Interior;
      const isSurface = this.view === ViewMode.Surface;

  this.interior.setActive(isInterior);
  this.surface.setActive(isSurface);

      this.interiorCanvas.style.display = isInterior ? 'block' : 'none';
      this.surfaceCanvas.style.display = isSurface ? 'block' : 'none';
      this.canvas.style.display = !isInterior && !isSurface ? 'block' : 'none';

      button.textContent = isInterior ? 'Welt' : 'Innen';

      const landBtn = this.getElement<HTMLButtonElement>('landBtn');
      const takeoffBtn = this.getElement<HTMLButtonElement>('takeoffBtn');
      if (landBtn) {
        landBtn.style.display = !isInterior && !isSurface && this._canLandHere() ? 'block' : 'none';
      }
      if (takeoffBtn) {
        takeoffBtn.style.display = isSurface ? 'block' : 'none';
        takeoffBtn.textContent = 'Beamen';
      }

      const mobileView = this.getElement<HTMLButtonElement>('mb_view');
      const mobileLand = this.getElement<HTMLButtonElement>('mb_land');
      const mobileBeam = this.getElement<HTMLButtonElement>('mb_beam');

      if (mobileView) {
        mobileView.textContent = isInterior ? 'Welt' : 'Innen';
      }
      if (mobileLand) {
        mobileLand.style.display = !isInterior && !isSurface && this._canLandHere() ? 'inline-block' : 'none';
      }
      if (mobileBeam) {
        mobileBeam.style.display = isSurface ? 'inline-block' : 'none';
      }

      this.updateDPadVisibility();
    };

    this._updateViewSwitch = update;

    button.addEventListener('click', () => {
      this.view = this.view === ViewMode.Space ? ViewMode.Interior : ViewMode.Space;
      update();
      this._sendPresence();
    });

    const mobileView = this.getElement<HTMLButtonElement>('mb_view');
    if (mobileView) {
      mobileView.addEventListener('click', () => {
        this.view = this.view === ViewMode.Space ? ViewMode.Interior : ViewMode.Space;
        update();
        this._sendPresence();
      });
    }

    const mobileLand = this.getElement<HTMLButtonElement>('mb_land');
    if (mobileLand) {
      mobileLand.addEventListener('click', () => this._tryLand());
    }

    const mobileBeam = this.getElement<HTMLButtonElement>('mb_beam');
    if (mobileBeam) {
      mobileBeam.addEventListener('click', () => {
        this.view = ViewMode.Interior;
        update();
        this._sendPresence();
      });
    }

    const landBtn = this.getElement<HTMLButtonElement>('landBtn');
    if (landBtn) {
      landBtn.addEventListener('click', () => this._tryLand());
    }

    const takeoffBtn = this.getElement<HTMLButtonElement>('takeoffBtn');
    if (takeoffBtn) {
      takeoffBtn.addEventListener('click', () => {
        this.view = ViewMode.Interior;
        update();
        this._sendPresence();
      });
    }

    const dpad = this.getElement<HTMLDivElement>('dpad');
    const dirMap: Record<string, [number, number]> = {
      left: [-1, 0],
      right: [1, 0],
      nw: [-1, -1],
      se: [1, 1],
    };

    if (dpad) {
      dpad.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement | null)?.closest('button');
        if (!button) {
          return;
        }
        const dir = button.dataset.dir;
        const delta = dir ? dirMap[dir] : undefined;
        if (!delta) {
          return;
        }
        const view = this.view === ViewMode.Surface ? this.surface : this.view === ViewMode.Interior ? this.interior : null;
        if (view && typeof (view as any)._tryStep === 'function') {
          (view as any)._tryStep(delta[0], delta[1]);
        }
      });
    }

    update();
    window.addEventListener('resize', () => this.updateDPadVisibility(), { passive: true });
  }

  private updateDPadVisibility(): void {
    const dpad = this.getElement<HTMLDivElement>('dpad');
    if (!dpad) {
      return;
    }
    const isMobile = window.matchMedia(D_PAD_QUERY).matches;
    const shouldShow = isMobile && (this.view === ViewMode.Surface || this.view === ViewMode.Interior);
    dpad.style.display = shouldShow ? 'flex' : 'none';
  }

  private _setSelection(selection: Selection | null): void {
    this.selection = selection;
    this.renderer.selection = selection;
    this._updateSelectionPanel();
  }

  private _updateSelectionPanel(): void {
    const panel = this.getElement<HTMLElement>(SELECTION_PANEL_ID);
    if (!panel) {
      return;
    }
    if (!this.selection) {
      panel.style.display = 'none';
      return;
    }

    const selection = this.selection;

    const kindEl = this.getElement<HTMLElement>('sel_kind');
    const nameEl = this.getElement<HTMLElement>('sel_name');
    const typeEl = this.getElement<HTMLElement>('sel_type');
    const pathEl = this.getElement<HTMLElement>('sel_path');
    const statsEl = this.getElement<HTMLElement>('sel_stats');

    if (!kindEl || !nameEl || !typeEl || !pathEl || !statsEl) {
      return;
    }

    let name = '–';
    let type = '–';
    let path = '–';
    let stats = '';

    if (selection.kind === 'star') {
      name = selection.star.id;
      type = `Stern ${selection.star.type}`;
      path = 'Stern';
      stats = `Leuchtkraft: ${selection.star.lum.toFixed(2)} • Größe: ${selection.star.size.toFixed(0)} wu`;
    } else if (selection.kind === 'planet') {
      const starLabel = selection.star?.id ?? 'Stern';
      name = selection.planet.name;
      type = `${selection.planet.type}${selection.planet.hasRings ? ' • Ringe' : ''}`;
      path = `Planet → ${starLabel}`;
      stats = `Radius: ${selection.planet.radius.toFixed(0)} wu • Monde: ${selection.planet.moons.length}`;
    } else if (selection.kind === 'moon') {
      const starLabel = selection.star?.id ?? 'Stern';
      const index = selection.moon.index ?? 0;
      name = `${selection.planet.name} – Mond ${index + 1}`;
      type = 'Mond';
      path = `Mond → Planet ${selection.planet.name} → ${starLabel}`;
      stats = `Mond-Radius: ${selection.moon.r.toFixed(0)} wu • Bahn: ${(selection.planet.radius + selection.moon.dist).toFixed(0)} wu`;
    }

    kindEl.textContent = selection.kind.charAt(0).toUpperCase() + selection.kind.slice(1);
    nameEl.textContent = name;
    typeEl.textContent = type;
    pathEl.textContent = path;
    statsEl.textContent = stats;

    panel.style.display = 'block';
  }

  private _focusPlanet(planet: Planet, autoZoom: boolean): void {
    this.focusPlanet = planet;
    this.renderer.focusPlanet = planet;
    this.setCameraPosition(planet.pos);
    if (autoZoom) {
      const targetZoom = Math.max(25, this.camera.zoom * 1.8);
      this.autoFocus = { targetZoom, speed: 2.2 };
    }
  }

  private _focusStar(star: Star): void {
    this.focusPlanet = null;
    this.renderer.focusPlanet = null;
    this.setCameraPosition(star.pos);
    this.autoFocus = null;
  }

  private _pickObject(worldPoint: Vec2): ScreenObject | null {
    const screen = this.camera.worldToScreen(worldPoint, this.canvas);
    let best: ScreenObject | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const entry of this.renderer.visibleObjectsScreen) {
      const distance = Math.hypot(screen.x - entry.x, screen.y - entry.y) - entry.r;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry;
      }
    }

    if (!best || bestDistance >= PICK_DISTANCE_THRESHOLD) {
      return null;
    }

    return best;
  }

  private _selectFromPick(pick: ScreenObject): void {
    if (pick.kind === 'star') {
      this._focusStar(pick.obj);
      this._setSelection({ kind: 'star', star: pick.obj });
      this.currentId = pick.obj.id;
    } else if (pick.kind === 'planet') {
      this._focusPlanet(pick.obj, true);
      const star = pick.obj.star;
      const selection: Selection = star ? { kind: 'planet', planet: pick.obj, star } : { kind: 'planet', planet: pick.obj };
      this._setSelection(selection);
      this.currentId = pick.obj.id;
    } else {
      const { planet, moon } = pick.obj;
      this._focusPlanet(planet, true);
      const star = planet.star;
      const selection: Selection = star
        ? { kind: 'moon', planet, moon, star }
        : { kind: 'moon', planet, moon };
      this._setSelection(selection);
      this.currentId = moon.id;
    }
    this._setHash(this.currentId);
  }

  private _setHash(id: string | null): void {
    try {
      const seedPart = `seed=${encodeURIComponent(this.settings.seed)}`;
      const x = Math.round(this.camera.pos.x);
      const y = Math.round(this.camera.pos.y);
      const z = Number(this.camera.zoom.toFixed(4));
      const viewPart = `view=${x},${y},${z}`;
      const parts = [seedPart, viewPart];
      if (id) {
        parts.push(`id=${id}`);
      }
      const newHash = parts.join(';');
      const current = (location.hash || '').replace(/^#/, '');
      if (current === newHash) {
        return;
      }
      if (history.replaceState) {
        history.replaceState(null, '', `#${newHash}`);
      } else {
        location.hash = newHash;
      }
    } catch {
      /* ignore */
    }
  }

  private _navigateFromHash(): void {
    const raw = (location.hash || '').replace(/^#/, '');
    if (!raw) {
      return;
    }

    let seed: string | null = null;
    let view: string | null = null;
    let id: string | null = null;

    for (const segment of raw.split(';')) {
      if (!segment) {
        continue;
      }
      if (segment.startsWith('seed=')) {
        seed = decodeURIComponent(segment.slice(5));
      } else if (segment.startsWith('view=')) {
        view = segment.slice(5);
      } else if (segment.startsWith('id=')) {
        id = segment.slice(3);
      } else if (/^[spm]:/.test(segment)) {
        id = segment;
      }
    }

    if (seed && seed !== this.settings.seed) {
      console.warn('[app] Seed-Wechsel via URL wird ignoriert (Server-seed ist verbindlich).');
    }

    if (!id && view) {
      const values = view.split(',');
      const x = Number.parseFloat(values[0] ?? `${this.camera.pos.x}`);
      const y = Number.parseFloat(values[1] ?? `${this.camera.pos.y}`);
      const z = Number.parseFloat(values[2] ?? `${this.camera.zoom}`);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        this.setCameraPosition(new Vec2(x, y));
        this.camera.zoom = Math.min(this.camera.maxZoom, Math.max(this.camera.minZoom, z));
        this.focusPlanet = null;
        this.renderer.focusPlanet = null;
        this.autoFocus = null;
      }
    }

    if (!id) {
      return;
    }

    this.currentId = id;
    const parts = id.split(':');
    if (parts.length < 2) {
      return;
    }

    const parsePair = (value: string): [number, number] | null => {
      const [sx, sy] = value.split(',');
      if (sx === undefined || sy === undefined) {
        return null;
      }
      const px = Number.parseInt(sx, 10);
      const py = Number.parseInt(sy, 10);
      return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : null;
    };

    if (parts[0] === 's' && parts.length >= 3) {
      const pair = parsePair(parts[1] ?? '');
      const starIndex = Number.parseInt(parts[2] ?? '', 10);
      if (pair && Number.isFinite(starIndex)) {
        const [ix, iy] = pair;
        const chunk = this.manager.getChunk(ix, iy, this.settings);
        const star = chunk.stars.find((s) => s.index === starIndex) ?? null;
        if (star) {
          this._focusStar(star);
        }
      }
      return;
    }

    if (parts[0] === 'p' && parts.length >= 4) {
      const pair = parsePair(parts[1] ?? '');
      const starIndex = Number.parseInt(parts[2] ?? '', 10);
      const planetIndex = Number.parseInt(parts[3] ?? '', 10);
      if (pair && [starIndex, planetIndex].every(Number.isFinite)) {
        const [ix, iy] = pair;
        const chunk = this.manager.getChunk(ix, iy, this.settings);
        const star = chunk.stars.find((s) => s.index === starIndex) ?? null;
        const planet = star?.planets[planetIndex] ?? null;
        if (planet) {
          this._focusPlanet(planet, true);
        }
      }
      return;
    }

    if (parts[0] === 'm' && parts.length >= 5) {
      const pair = parsePair(parts[1] ?? '');
      const starIndex = Number.parseInt(parts[2] ?? '', 10);
      const planetIndex = Number.parseInt(parts[3] ?? '', 10);
      const moonIndex = Number.parseInt(parts[4] ?? '', 10);
      if (pair && [starIndex, planetIndex, moonIndex].every(Number.isFinite)) {
        const [ix, iy] = pair;
        const chunk = this.manager.getChunk(ix, iy, this.settings);
        const star = chunk.stars.find((s) => s.index === starIndex) ?? null;
        const planet = star?.planets[planetIndex] ?? null;
        const moon = planet?.moons[moonIndex] ?? null;
        if (planet && moon) {
          this._focusPlanet(planet, true);
        }
      }
    }
  }

  private _updateViewHash(): void {
    this._setHash(this.currentId);
  }

  private _computeSignalUrl(): string {
    const env = this.getEnv();
    const configured = env['VITE_SIGNAL_URL'];
    if (typeof configured === 'string' && configured.length) {
      return configured;
    }
    const dev = env['DEV'];
    if (dev === true || dev === 'true') {
      return 'ws://localhost:8080';
    }
    try {
      const loc = window.location;
      const isHttps = loc.protocol === 'https:';
      const proto = isHttps ? 'wss:' : 'ws:';
      const host = loc.host || 'localhost:8080';
      return `${proto}//${host}`;
    } catch {
      return 'ws://localhost:8080';
    }
  }

  // endregion

  // region --- HUD -------------------------------------------------------------------------

  private _hookHUD(): void {
    const hud = this.getElement<HTMLDivElement>(HUD_ID);
    const hudToggle = this.getElement<HTMLButtonElement>('hudToggle');
    if (hud && hudToggle) {
      const mediaQuery = window.matchMedia(D_PAD_QUERY);
      const show = (visible: boolean) => {
        hud.style.display = visible ? 'block' : 'none';
        hudToggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
      };
      const apply = () => show(!mediaQuery.matches);
      try {
        mediaQuery.addEventListener('change', apply);
      } catch {
        (mediaQuery as MediaQueryList).onchange = apply;
      }
      apply();
      hudToggle.addEventListener('click', () => show(hud.style.display === 'none'));
    }

    const seedInput = this.getElement<HTMLInputElement>('seed');
    if (seedInput) {
      seedInput.value = this.settings.seed;
      seedInput.readOnly = true;
      seedInput.setAttribute('aria-readonly', 'true');
      seedInput.title = 'Seed wird vom Server vorgegeben';
    }

    const regenButton = this.getElement<HTMLButtonElement>('regen');
    if (regenButton) {
      regenButton.disabled = true;
      regenButton.title = 'Seed wird vom Server vorgegeben';
    }

    this.bindButton('regen', () => {
      if (!seedInput) {
        return;
      }
      const value = seedInput.value || 'seed';
      this.settings.seed = value;
      this._regen();
    });

    const pauseButton = this.getElement<HTMLButtonElement>('pause');
    if (pauseButton) {
      pauseButton.addEventListener('click', () => {
        this.running = !this.running;
        pauseButton.textContent = this.running ? 'Pause' : 'Start';
        if (this.running) {
          this._loop();
        }
      });
    }

    this.bindRange('zoomSpeed', (value) => {
      this.settings.zoomSpeed = parseFloat(value);
    });
    this.bindRange('starDensity', (value) => {
      this.settings.starDensity = parseFloat(value);
    });
    this.bindRange('planetDensity', (value) => {
      this.settings.planetDensity = parseFloat(value);
    });
    this.bindRange('shipCount', (value) => {
      this.settings.shipCount = parseInt(value, 10);
      this._spawnShips();
    });
    this.bindRange('animSpeed', (value) => {
      this.settings.animSpeed = parseFloat(value);
    });

    this.bindCheckbox('labels', (checked) => {
      this.settings.labels = checked;
    });
    this.bindCheckbox('renderStars', (checked) => {
      this.settings.renderStars = checked;
    });
    this.bindCheckbox('renderPlanets', (checked) => {
      this.settings.renderPlanets = checked;
    });
    this.bindCheckbox('renderOrbits', (checked) => {
      this.settings.renderOrbits = checked;
    });
    this.bindCheckbox('renderMoons', (checked) => {
      this.settings.renderMoons = checked;
    });
    this.bindCheckbox('renderCities', (checked) => {
      this.settings.renderCities = checked;
    });
    this.bindCheckbox('renderGrid', (checked) => {
      this.settings.renderGrid = checked;
    });
    this.bindCheckbox('renderShips', (checked) => {
      this.settings.renderShips = checked;
    });
    this.bindCheckbox('followShip', (checked) => {
      this.settings.followShip = checked;
    });

    this.setupNameInput();
    this.setupFlightControls();
    this.setupChatControls();

    window.addEventListener('keypress', (event) => {
      if (event.key.toLowerCase() === 'r') {
        this._initStartView();
        this.focusPlanet = null;
        this.renderer.focusPlanet = null;
      }
    });
  }

  private setupFlightControls(): void {
    const flyButton = this.getElement<HTMLButtonElement>('sel_fly');
    if (!flyButton) {
      return;
    }
    flyButton.addEventListener('click', () => {
      if (!this.selection) {
        return;
      }
      let target: Vec2 | null = null;
      if (this.selection.kind === 'star') {
        target = this.selection.star.pos.clone();
      } else if (this.selection.kind === 'planet') {
        target = this.selection.planet.pos.clone();
      } else if (this.selection.kind === 'moon') {
        const moon = this.selection.moon;
        const planet = this.selection.planet;
        target = new Vec2(
          planet.pos.x + Math.cos(moon.ang) * (planet.radius + moon.dist),
          planet.pos.y + Math.sin(moon.ang) * (planet.radius + moon.dist),
        );
      }
      if (target) {
        this.playerShip.target = target;
        this.net?.sendMoveTarget(target.x, target.y);
      }
    });
  }

  private setupChatControls(): void {
    const chatSend = this.getElement<HTMLButtonElement>('chatSend');
    const chatInput = this.getElement<HTMLInputElement>('chatInput');
    if (chatSend && chatInput) {
      chatSend.addEventListener('click', () => {
        const text = chatInput.value.trim();
        if (!text) {
          return;
        }
        const position = this.playerShip.pos;
        this.net?.sendChatPublic(position.x, position.y, 8000, text);
        chatInput.value = '';
      });
      chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          chatSend.click();
        }
      });
    }

    const pmSend = this.getElement<HTMLButtonElement>('pmSend');
    const pmTarget = this.getElement<HTMLInputElement>('pmTarget');
    const pmInput = this.getElement<HTMLInputElement>('pmInput');
    if (pmSend && pmTarget && pmInput) {
      pmSend.addEventListener('click', () => {
        const text = pmInput.value.trim();
        const target = parseInt(pmTarget.value, 10);
        if (!text || !Number.isFinite(target)) {
          return;
        }
        this.net?.sendChatPrivate(target >>> 0, text);
        pmInput.value = '';
      });
      pmInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          pmSend.click();
        }
      });
    }
  }

  private setupNameInput(): void {
    const nameInput = this.getElement<HTMLInputElement>('playerName');
    if (!nameInput) {
      return;
    }
    if (!nameInput.value && this.initialPlayerName) {
      nameInput.value = this.initialPlayerName;
    }
    try {
      const saved = localStorage.getItem('playerName');
      if (saved) {
        nameInput.value = saved;
      }
    } catch {
      /* ignore */
    }
    if (!nameInput.value && this.initialPlayerName) {
      nameInput.value = this.initialPlayerName;
    }

    const applyName = () => {
      const value = nameInput.value.trim();
      try {
        localStorage.setItem('playerName', value);
      } catch {
        /* ignore */
      }
      this.net?.setName(value);
      if (value) {
        this.interior.avatar.name = value;
        this.surface.avatar.name = value;
      }
    };

    nameInput.addEventListener('change', applyName);
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        applyName();
      }
    });

    applyName();
  }

  private bindButton(id: string, handler: () => void): void {
    const button = this.getElement<HTMLButtonElement>(id);
    button?.addEventListener('click', handler);
  }

  private bindRange(id: string, handler: (value: string) => void): void {
    const input = this.getElement<HTMLInputElement>(id);
    input?.addEventListener('input', (event) => {
      const value = (event.currentTarget as HTMLInputElement).value;
      handler(value);
    });
  }

  private bindCheckbox(id: string, handler: (checked: boolean) => void): void {
    const input = this.getElement<HTMLInputElement>(id);
    input?.addEventListener('change', (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      handler(checked);
    });
  }

  private getElement<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  // endregion

  // region --- World management -------------------------------------------------------------

  private _regen(): void {
    this.manager = new ChunkManager(this.settings.seed);
    this.renderer.manager = this.manager;
    this._spawnShips();
    if ((location.hash || '').length > 1) {
      this._navigateFromHash();
    }
  }

  private _spawnShips(): void {
    const prng = new PRNG(`ships-${this.settings.seed}`);
    const ships: Ship[] = [];
    for (let i = 0; i < this.settings.shipCount; i += 1) {
      const position = new Vec2(prng.float(-1, 1) * WORLD.CHUNK * 2, prng.float(-1, 1) * WORLD.CHUNK * 2);
      const target = Vec2.add(position, Vec2.fromPolar(prng.float(1000, 4000), prng.float(0, Math.PI * 2)));
      ships.push(new Ship(position, target));
    }
    this.playerShip.speed = 180;
    this.ships = [this.playerShip, ...ships];
  }

  private _updateShips(dt: number): void {
    if (!this.settings.renderShips) {
      return;
    }

    this.playerShip.update?.(dt);

    for (const remote of this.remoteShips.values()) {
      const dx = remote.target.x - remote.pos.x;
      const dy = remote.target.y - remote.pos.y;
      const distance = Math.hypot(dx, dy);
      const speed = 160;
      if (distance > 1) {
        remote.pos.x += (dx / distance) * speed * dt;
        remote.pos.y += (dy / distance) * speed * dt;
      }
    }

    if (this.net) {
      this.net.sendPosition(this.playerShip.pos.x, this.playerShip.pos.y);
    }
  }

  private _updateHUD(dt: number): void {
    this._fpsAcc = this._fpsAcc * 0.9 + (1 / dt) * 0.1;
    const fpsEl = this.getElement<HTMLElement>('fps');
    if (fpsEl && Number.isFinite(this._fpsAcc)) {
      fpsEl.textContent = `${this._fpsAcc.toFixed(0)} FPS`;
    }

    const label = this.getElement<HTMLElement>('scaleLabel');
    const detail = this.getElement<HTMLElement>('scaleDetail');
    if (label && detail) {
      const viewWU = (this.canvas.width / (window.devicePixelRatio || 1)) / this.camera.zoom;
      const tier = ScaleTiers.pick(viewWU);
      label.textContent = `Bereich: ${tier.name}`;
      detail.textContent = `ca. Ausdehnung: ${tier.pretty}`;
    }

    this.updatePlanetInfo();
    this.updateShipInfo();
    this.updateNearbyPlayers();
  }

  private updatePlanetInfo(): void {
    const panel = this.getElement<HTMLElement>(PLANET_INFO_ID);
    if (!panel) {
      return;
    }
    if (!this.focusPlanet) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'block';
    const planet = this.focusPlanet;

    const nameEl = this.getElement<HTMLElement>('pi_name');
    const typeEl = this.getElement<HTMLElement>('pi_type');
    const statsEl = this.getElement<HTMLElement>('pi_stats');
    const envEl = this.getElement<HTMLElement>('pi_env');
    if (!nameEl || !typeEl || !statsEl || !envEl) {
      return;
    }

    const deg = (value: number) => `${value.toFixed(0)}°`;
    const hours = (value: number) => `${value.toFixed(1)} h`;

    nameEl.textContent = planet.name;
    typeEl.textContent = `${planet.type}${planet.hasRings ? ' • Ringe' : ''}`;
    statsEl.textContent = `Radius: ${planet.radius.toFixed(0)} wu • Masse: ${planet.mass.toFixed(1)} M⊕ • g: ${planet.gravity.toFixed(1)} m/s² • Tag: ${hours(planet.dayLength)} • Achse: ${deg(planet.axialTilt)}`;
    envEl.textContent = `Temperatur: ${planet.temperature.toFixed(0)} K • Atmosphäre: ${planet.atmosphere} • Monde: ${planet.moons.length}`;
  }

  private updateShipInfo(): void {
    const panel = this.getElement<HTMLElement>('shipInfo');
    if (!panel) {
      return;
    }
    if (!this.settings.renderShips || !this.playerShip) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'block';
    const positionEl = this.getElement<HTMLElement>('si_pos');
    const speedEl = this.getElement<HTMLElement>('si_speed');
    const targetEl = this.getElement<HTMLElement>('si_target');
    const distEl = this.getElement<HTMLElement>('si_dist');
    const etaEl = this.getElement<HTMLElement>('si_eta');

    if (!positionEl || !speedEl || !targetEl || !distEl || !etaEl) {
      return;
    }

    const pos = this.playerShip.pos;
    const target = this.playerShip.target;
    const dist = Math.hypot(target.x - pos.x, target.y - pos.y);
    const eta = this.playerShip.speed > 0 ? dist / this.playerShip.speed : Number.POSITIVE_INFINITY;

    positionEl.textContent = `${pos.x.toFixed(0)}, ${pos.y.toFixed(0)} wu`;
    speedEl.textContent = `${this.playerShip.speed.toFixed(0)} wu/s`;
    targetEl.textContent = `${target.x.toFixed(0)}, ${target.y.toFixed(0)} wu`;
    distEl.textContent = `${dist.toFixed(0)} wu`;
    etaEl.textContent = Number.isFinite(eta) ? `${eta.toFixed(1)} s` : '–';
  }

  private updateNearbyPlayers(): void {
    const me = this.playerShip.pos;
    const near: NearPlayerEntry[] = [];
    for (const remote of this.remoteShips.values()) {
      const dx = remote.pos.x - me.x;
      const dy = remote.pos.y - me.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 < 8000 * 8000) {
        near.push({ name: remote.name || '', hash: remote.hash >>> 0, dist2 });
      }
    }

    near.sort((a, b) => a.dist2 - b.dist2);

    const previous = this._nearSet ?? new Set<number>();
    const current = new Set(near.map((entry) => entry.hash >>> 0));

    for (const hash of current) {
      if (!previous.has(hash)) {
        const entry = near.find((it) => (it.hash >>> 0) === hash);
        if (entry) {
          this._appendChatSystem(`in Reichweite: ${entry.name || 'Spieler'} (#${this._fmtHash(hash)})`);
        }
      }
    }

    for (const hash of previous) {
      if (!current.has(hash)) {
        this._appendChatSystem(`außer Reichweite: #${this._fmtHash(hash)}`);
      }
    }

    this._nearSet = current;

    let container = this.getElement<HTMLDivElement>(CHAT_NEARBY_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = CHAT_NEARBY_ID;
      container.style.marginTop = '6px';
      const chatPanel = this.getElement<HTMLDivElement>('chatPanel');
      chatPanel?.appendChild(container);
    }

    const lines = near.slice(0, 8).map((entry) => `• ${entry.name || 'Spieler'} (#${this._fmtHash(entry.hash || 0)})`);
    container.textContent = lines.length ? `Nahe Spieler: ${lines.join('  ')}` : 'Nahe Spieler: –';

    if (near.length) {
      let beamButton = this.getElement<HTMLButtonElement>('beamReqBtn');
      if (!beamButton) {
        beamButton = document.createElement('button');
        beamButton.id = 'beamReqBtn';
        beamButton.textContent = 'Beam-Anfrage an Nächsten';
        beamButton.style.marginLeft = '8px';
        container.appendChild(beamButton);
        beamButton.addEventListener('click', () => {
          const target = near[0];
          if (!target) {
            return;
          }
          this.net?.requestBeam(target.hash >>> 0, 'Lass mich zu dir beamen?');
          this._appendChatSystem(`Beam-Anfrage an #${this._fmtHash(target.hash || 0)} gesendet.`);
        });
      }
    }
  }

  private _fmtHash(hash: number): string {
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  // endregion

  // region --- Game loop -------------------------------------------------------------------

  private _loop(): void {
    let last = performance.now();

    const tick = (now: number) => {
      if (!this.running) {
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (this.view === ViewMode.Space) {
        this.renderer.time += dt;
        this.input.update(dt);
        this._updateShips(dt);
      }

      if (this.focusPlanet) {
        this.renderer.focusPlanet = this.focusPlanet;
  this.setCameraPosition(this.focusPlanet.pos);
        if (this.autoFocus) {
          const target = this.autoFocus.targetZoom;
          const current = this.camera.zoom;
          const delta = (target - current) * Math.min(1, this.autoFocus.speed * dt);
          this.camera.zoom = Math.min(this.camera.maxZoom, Math.max(this.camera.minZoom, current + delta));
          if (Math.abs(this.camera.zoom - target) < 0.02) {
            this.autoFocus = null;
          }
        }
      } else if (this.settings.followShip) {
  this.setCameraPosition(this.playerShip.pos);
      }

      this._syncRemoteShipsToScene();

      if (this.view === ViewMode.Space) {
        this.renderer.frame(dt, this.ships);
        this._updateViewSwitch?.();
      } else if (this.view === ViewMode.Interior) {
        this.interior.frame(dt);
      } else if (this.view === ViewMode.Surface) {
        this.updateSurfaceRemotes();
        this.surface.frame(dt);
      }

      this._sendPresence(dt);
      this._updateHUD(dt);
      if (this.view === ViewMode.Space) {
        this._updateViewHash();
      }
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  private updateSurfaceRemotes(): void {
    const remotes: Array<{ id: number; x: number; y: number; name: string }> = [];
    const currentBody = this._currentBodyId() | 0;
    for (const remote of this.remoteShips.values()) {
      if ((remote.scene | 0) !== SceneId.Surface) {
        continue;
      }
      if ((remote.body | 0) !== currentBody) {
        continue;
      }
      const tileX = Number.isFinite(remote.tileX) ? remote.tileX | 0 : (remote.pos.x / 50) | 0;
      const tileY = Number.isFinite(remote.tileY) ? remote.tileY | 0 : (remote.pos.y / 50) | 0;
      remotes.push({ id: remote.hash >>> 0, x: tileX, y: tileY, name: remote.name || '' });
    }
    this.surface.setRemotes(remotes);
  }

  // endregion

  // region --- Landing & presence -----------------------------------------------------------

  private _canLandHere(): boolean {
    if (!this.settings.renderPlanets) {
      return false;
    }
    const list = this.renderer.visiblePlanetsScreen;
    const cx = (this.canvas.width / (window.devicePixelRatio || 1)) / 2;
    const cy = (this.canvas.height / (window.devicePixelRatio || 1)) / 2;
    let best: (typeof list)[number] | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of list) {
      const distance = Math.hypot(entry.x - cx, entry.y - cy) - entry.r;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry;
      }
    }
    return Boolean(best && bestDistance < LAND_DISTANCE_THRESHOLD);
  }

  private _tryLand(): void {
    if (!this._canLandHere()) {
      return;
    }
    const cx = (this.canvas.width / (window.devicePixelRatio || 1)) / 2;
    const cy = (this.canvas.height / (window.devicePixelRatio || 1)) / 2;
    const pick = this.pickPlanetOrMoonAt(cx, cy);
    if (!pick) {
      return;
    }

    let bodyName = 'Körper';
    let bodyType = 'planetar';
    let gravity = 9.8;

    if (pick.kind === 'planet') {
      const planet = pick.obj;
      bodyName = planet.name;
      bodyType = planet.type;
      gravity = planet.gravity || 9.8;
    } else if (pick.kind === 'moon') {
      const planet = pick.obj.planet;
      const moon = pick.obj.moon;
      bodyName = `${planet.name} – Mond ${moon.index + 1}`;
      bodyType = 'Mond';
      gravity = (planet.gravity || 9.8) * 0.16;
    }

    this.surface.setBody({ name: bodyName, type: bodyType, gravity });
    const pad = this.surface.pad ?? { x: 0, y: 0 };
    this.surface.avatar.x = pad.x;
    this.surface.avatar.y = pad.y;
    this.surface.avatar.px = pad.x;
    this.surface.avatar.py = pad.y;
    this.surface.avatar.path = [];
    this.view = ViewMode.Surface;
    this._updateViewSwitch?.();
    this._sendPresence();
  }

  private pickPlanetOrMoonAt(cx: number, cy: number) {
    const objects = this.renderer.visibleObjectsScreen;
    let best: (typeof objects)[number] | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of objects) {
      if (entry.kind !== 'planet' && entry.kind !== 'moon') {
        continue;
      }
      const distance = Math.hypot(entry.x - cx, entry.y - cy) - entry.r;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry;
      }
    }
    return best && bestDistance < LAND_DISTANCE_THRESHOLD ? best : null;
  }

  private _currentBodyId(): number {
    const planet = this.focusPlanet;
    if (!planet) {
      return 0;
    }
    try {
      const star = planet.star;
      if (star && Number.isFinite(star.index) && Number.isFinite(planet.index)) {
        return ((star.index & 0xffff) << 16) | (planet.index & 0xffff);
      }
    } catch {
      /* ignore */
    }
    try {
      let hash = 2166136261 >>> 0;
      const name = String(planet.name || '');
      for (let i = 0; i < name.length; i += 1) {
        hash ^= name.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    } catch {
      return 0;
    }
  }

  private _sendPresence(dt = 0): void {
    if (!this.net) {
      return;
    }
    const scene = this.view === ViewMode.Surface ? SceneId.Surface : this.view === ViewMode.Interior ? SceneId.Interior : SceneId.Space;
    const body = scene === SceneId.Surface ? this._currentBodyId() : 0;
    const ship = scene === SceneId.Interior ? 1 : 0;
    let tileX = 0;
    let tileY = 0;
    if (scene === SceneId.Surface) {
      const tile = this.surface.getAvatarTile();
      tileX = tile.x | 0;
      tileY = tile.y | 0;
    }
    if (scene === SceneId.Interior) {
      tileX = this.interior.avatar.x | 0;
      tileY = this.interior.avatar.y | 0;
    }
    this._beamPresence = { scene, body, tileX, tileY, ship };

    this.net.sendState(scene, body, tileX, tileY, ship);

    if (dt > 0 && this.playerShip) {
      this.net.sendPosition(this.playerShip.pos.x, this.playerShip.pos.y);
    }
  }

  // endregion

  // region --- Networking ------------------------------------------------------------------

  private _applySnapshot(list: SnapshotEntry[]): void {
    const now = performance.now();
    for (const entry of list) {
      let state = this.remoteShips.get(entry.idHash);
      if (!state) {
        state = {
          pos: new Vec2(entry.x, entry.y),
          target: new Vec2(entry.x, entry.y),
          last: now,
          name: entry.name || '',
          hash: entry.idHash >>> 0,
          dir: 0,
          scene: entry.scene || 0,
          body: entry.body || 0,
          tileX: entry.tileX || 0,
          tileY: entry.tileY || 0,
        };
        this.remoteShips.set(entry.idHash, state);
      } else {
        const dx = entry.x - state.pos.x;
        const dy = entry.y - state.pos.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > 1e-3) {
          state.dir = Math.atan2(dy, dx);
        }
        state.pos.x = entry.x;
        state.pos.y = entry.y;
        state.target.x = entry.x;
        state.target.y = entry.y;
        state.last = now;
        state.name = entry.name || state.name;
        state.hash = entry.idHash >>> 0;
        state.scene = entry.scene || 0;
        state.body = entry.body || 0;
        state.tileX = entry.tileX || 0;
        state.tileY = entry.tileY || 0;
      }
    }

    for (const [id, state] of this.remoteShips) {
      if (now - state.last > 10_000) {
        this.remoteShips.delete(id);
      }
    }
  }

  private handleRemoteMove(event: RemoteMoveEvent): void {
    const hash = event.from >>> 0;
    const state = this.remoteShips.get(hash);
    if (state) {
      state.target = new Vec2(event.x, event.y);
    } else {
      this.remoteShips.set(hash, {
        pos: new Vec2(event.x, event.y),
        target: new Vec2(event.x, event.y),
        last: performance.now(),
        name: '',
        hash,
        dir: 0,
        scene: SceneId.Space,
        body: 0,
        tileX: 0,
        tileY: 0,
      });
    }
  }

  private handleBeamRequest(event: BeamRequestEvent): void {
    const accepted = window.confirm(`${event.name || 'Spieler'} möchte dich beamen. Annehmen?`);
    if (!accepted || !this.net) {
      this.net?.respondBeam(event.from >>> 0, false);
      return;
    }
    const presence = this._beamPresence;
    this.net.respondBeam(event.from >>> 0, true, presence.scene, presence.body, presence.tileX, presence.tileY, presence.ship);
  }

  private handleBeamResponse(event: BeamResponseEvent): void {
    if (!event.accept) {
      this._appendChatSystem(`${event.name || 'Spieler'} hat deine Beam-Anfrage abgelehnt.`);
      return;
    }

    if (event.scene === SceneId.Space) {
      this.view = ViewMode.Space;
    } else if (event.scene === SceneId.Interior) {
      this.view = ViewMode.Interior;
    } else if (event.scene === SceneId.Surface) {
      if (this.surface) {
        this.surface.avatar.x = event.tileX | 0;
        this.surface.avatar.y = event.tileY | 0;
        this.surface.avatar.px = this.surface.avatar.x;
        this.surface.avatar.py = this.surface.avatar.y;
        this.surface.avatar.path = [];
      }
      this.view = ViewMode.Surface;
    }

    this._updateViewSwitch?.();
  }

  private _syncRemoteShipsToScene(): void {
    this._remoteRenderList.length = 0;
    for (const remote of this.remoteShips.values()) {
      this._remoteRenderList.push({
        pos: remote.pos,
        target: remote.target,
        speed: 0,
        phase: 0,
        isPlayer: false,
        _remote: true,
        name: remote.name || '',
        dir: remote.dir,
      });
    }
    const locals = [this.playerShip, ...this.ships.filter((ship) => !ship.isPlayer && !(ship as any)._remote)];
    this.ships = [...locals, ...this._remoteRenderList];
  }

  private _onChat(event: ChatEvent): void {
    const box = this.getElement<HTMLDivElement>(CHAT_BOX_ID);
    if (!box) {
      return;
    }
    const line = document.createElement('div');
    line.textContent = event.type === 'private' ? `(PM) ${event.name || event.from}: ${event.text}` : `${event.name || event.from}: ${event.text}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  private _appendChatSystem(text: string): void {
    const box = this.getElement<HTMLDivElement>(CHAT_BOX_ID);
    if (!box) {
      return;
    }
    const line = document.createElement('div');
    line.textContent = `[system] ${text}`;
    line.style.opacity = '0.8';
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  // endregion

  // region --- InputController delegate -----------------------------------------------------

  onDrag(dx: number, _dy: number, _event: MouseEvent | TouchEvent): boolean {
    if (!this.focusPlanet) {
      return false;
    }
    if (this.camera.zoom < 4) {
      return false;
    }
    const spin = dx * 0.01;
    this.focusPlanet.userSpin = (this.focusPlanet.userSpin || 0) + spin;
    this.focusPlanet.userSpinVel = spin;
    return true;
  }

  onDragEnd(): void {
    // Trägheit läuft über userSpinVel weiter
  }

  onKeyDown(event: KeyboardEvent): void {
    if (!this.focusPlanet) {
      return;
    }
    if (event.key === '+' || event.key === '=') {
      this.camera.zoom = Math.min(this.camera.maxZoom, this.camera.zoom * 1.1);
    } else if (event.key === '-' || event.key === '_') {
      this.camera.zoom = Math.max(this.camera.minZoom, this.camera.zoom / 1.1);
    }
  }

  // endregion
}
