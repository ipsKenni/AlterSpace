// Renderer: zeichnet Sterne, Planeten, Monde und Schiffe auf das Canvas
//
// Best Practices:
// - Kein globaler Zustand; alles über Instanz/Parameter
// - Sichtbarkeits-/Picking-Listen pro Frame zurücksetzen

import { WORLD } from '../app/constants.ts';
import type { Chunk, GenerationSettings, ChunkManager } from '../app/chunks.ts';
import type { Camera } from '../core/camera.ts';
import { Vec2 } from '../core/math.ts';
import type { Moon, Planet, ShipLike, Star } from '../app/model.ts';

export interface RendererSettings extends GenerationSettings {
  renderStars: boolean;
  renderPlanets: boolean;
  renderOrbits: boolean;
  renderMoons: boolean;
  renderGrid: boolean;
  renderShips: boolean;
  labels: boolean;
  animSpeed: number;
}

export type ScreenObject =
  | { kind: 'star'; obj: Star; x: number; y: number; r: number }
  | { kind: 'planet'; obj: Planet; x: number; y: number; r: number }
  | { kind: 'moon'; obj: { planet: Planet; moon: Moon }; x: number; y: number; r: number };

export interface ScreenPlanet {
  planet: Planet;
  x: number;
  y: number;
  r: number;
}

export interface RenderShip extends ShipLike {
  dir?: number;
  name?: string;
  _remote?: boolean;
}

const PLANET_LABEL_OFFSET = 14;
const STAR_SELECTION_DASH = 6;
const CAMERA_LERP_DECAY = 0.985;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly camera: Camera;
  manager: ChunkManager;
  readonly settings: RendererSettings;

  time = 0;
  focusPlanet: Planet | null = null;
  focusMoon: Moon | null = null;
  focusMoonPlanet: Planet | null = null;
  visibleObjectsScreen: ScreenObject[] = [];
  visiblePlanetsScreen: ScreenPlanet[] = [];

  private backgroundGradient: CanvasGradient | null = null;
  private backgroundGradientHeight = 0;
  private vignette: CanvasGradient | null = null;
  private vignetteWidth = 0;
  private vignetteHeight = 0;

  constructor(canvas: HTMLCanvasElement, camera: Camera, manager: ChunkManager, settings: RendererSettings) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D context unavailable');
    }

    this.canvas = canvas;
    this.ctx = ctx;
    this.camera = camera;
    this.manager = manager;
    this.settings = settings;
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const viewport = window.visualViewport || { width: window.innerWidth, height: window.innerHeight };
    const width = Math.floor(viewport.width * dpr);
    const height = Math.floor(viewport.height * dpr);

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  frame(dt: number, ships: ReadonlyArray<RenderShip>): void {
    this.resize();
    this.clear();

    this.visiblePlanetsScreen = [];
    this.visibleObjectsScreen = [];

    if (this.settings.renderStars || this.settings.renderPlanets || this.settings.renderOrbits) {
      for (const [ix, iy] of this.visibleChunkCoords()) {
        const chunk = this.manager.getChunk(ix, iy, this.settings as GenerationSettings);
        this.drawStars(chunk);
        this.drawPlanets(chunk, dt);
      }
    }

    this.drawShips(ships);
  }

  private visibleChunkCoords(): Array<[number, number]> {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;
    const paddingChunks = 1;

    const x0 = this.camera.pos.x - width * 0.5 / this.camera.zoom - WORLD.CHUNK * paddingChunks;
    const y0 = this.camera.pos.y - height * 0.5 / this.camera.zoom - WORLD.CHUNK * paddingChunks;
    const x1 = this.camera.pos.x + width * 0.5 / this.camera.zoom + WORLD.CHUNK * paddingChunks;
    const y1 = this.camera.pos.y + height * 0.5 / this.camera.zoom + WORLD.CHUNK * paddingChunks;

    const ix0 = Math.floor(x0 / WORLD.CHUNK);
    const iy0 = Math.floor(y0 / WORLD.CHUNK);
    const ix1 = Math.floor(x1 / WORLD.CHUNK);
    const iy1 = Math.floor(y1 / WORLD.CHUNK);

    const coords: Array<[number, number]> = [];
    for (let iy = iy0; iy <= iy1; iy += 1) {
      for (let ix = ix0; ix <= ix1; ix += 1) {
        coords.push([ix, iy]);
      }
    }
    return coords;
  }

  private clear(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const width = this.canvas.width;
    const height = this.canvas.height;

    if (!this.backgroundGradient || this.backgroundGradientHeight !== height) {
      this.backgroundGradient = ctx.createLinearGradient(0, 0, 0, height);
      this.backgroundGradient.addColorStop(0, '#050a14');
      this.backgroundGradient.addColorStop(1, '#00010a');
      this.backgroundGradientHeight = height;
    }

    ctx.fillStyle = this.backgroundGradient;
    ctx.fillRect(0, 0, width, height);

    if (!this.vignette || this.vignetteWidth !== width || this.vignetteHeight !== height) {
      const radius = Math.max(width, height) * 0.7;
      this.vignette = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.3, width / 2, height / 2, radius);
      this.vignette.addColorStop(0, 'rgba(0,0,0,0)');
      this.vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
      this.vignetteWidth = width;
      this.vignetteHeight = height;
    }

    ctx.fillStyle = this.vignette;
    ctx.fillRect(0, 0, width, height);
  }

  private drawStars(chunk: Chunk): void {
    if (!this.settings.renderStars) {
      return;
    }

    const ctx = this.ctx;
    ctx.save();
    this.camera.apply(ctx, this.canvas);

    for (const star of chunk.stars) {
      this.drawStar(star);
    }

    ctx.restore();
  }

  private drawStar(star: Star): void {
    const ctx = this.ctx;
    const radius = star.size;
    const halo = ctx.createRadialGradient(star.pos.x, star.pos.y, radius * 0.4, star.pos.x, star.pos.y, radius * 4.5);
    halo.addColorStop(0, star.color);
    halo.addColorStop(0.6, star.color);
    halo.addColorStop(1, 'rgba(255,255,255,0)');

    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(star.pos.x, star.pos.y, radius * 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = star.color;
    ctx.beginPath();
    ctx.arc(star.pos.x, star.pos.y, radius, 0, Math.PI * 2);
    ctx.fill();

    const screen = this.camera.worldToScreen(star.pos, this.canvas);
    const radiusScreen = Math.max(8, radius * this.camera.zoom * 2.2);

    this.visibleObjectsScreen.push({ kind: 'star', obj: star, x: screen.x, y: screen.y, r: radiusScreen });

  }

  private drawPlanets(chunk: Chunk, dt: number): void {
    if (!this.settings.renderPlanets && !this.settings.renderOrbits) {
      return;
    }

    const ctx = this.ctx;
    ctx.save();
    this.camera.apply(ctx, this.canvas);

    const lod = this.computeLod();
    if (lod < 0) {
      ctx.restore();
      return;
    }

    if (this.settings.renderOrbits) {
      this.drawPlanetOrbits(chunk, lod);
    }

    if (this.settings.renderPlanets) {
      for (const planet of chunk.planets) {
        this.drawPlanet(planet, dt, lod);
      }
    }

    ctx.restore();
  }

  private drawPlanetOrbits(chunk: Chunk, lod: number): void {
    if (lod < 0) {
      return;
    }

    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(120,170,255,0.12)';
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.setLineDash([4 / this.camera.zoom, 4 / this.camera.zoom]);

    for (const star of chunk.stars) {
      for (const planet of star.planets) {
        if (!planet.orbitCenter) {
          continue;
        }
        ctx.beginPath();
        ctx.arc(star.pos.x, star.pos.y, planet.orbitRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.setLineDash([]);
  }

  private drawPlanet(planet: Planet, dt: number, lod: number): void {
    const ctx = this.ctx;

    if (planet.orbitCenter) {
      planet.orbitAngle += planet.orbitSpeed * dt * this.settings.animSpeed;
      planet.pos.x = planet.orbitCenter.x + Math.cos(planet.orbitAngle) * planet.orbitRadius;
      planet.pos.y = planet.orbitCenter.y + Math.sin(planet.orbitAngle) * planet.orbitRadius;
    }

    const screen = this.camera.worldToScreen(planet.pos, this.canvas);
    const radiusScreen = planet.radius * this.camera.zoom;
    const viewportWidth = this.canvas.width / (window.devicePixelRatio || 1);
    const viewportHeight = this.canvas.height / (window.devicePixelRatio || 1);

    if (screen.x + radiusScreen < 0 || screen.y + radiusScreen < 0 || screen.x - radiusScreen > viewportWidth || screen.y - radiusScreen > viewportHeight) {
      return;
    }

    this.visiblePlanetsScreen.push({ planet, x: screen.x, y: screen.y, r: radiusScreen });
    this.visibleObjectsScreen.push({ kind: 'planet', obj: planet, x: screen.x, y: screen.y, r: Math.max(6, radiusScreen) });

    const isFocus = this.focusPlanet === planet;
    planet.rot += dt * (isFocus ? 0.04 : 0.1) * this.settings.animSpeed + (planet.userSpinVel || 0) * dt;
    planet.userSpinVel *= CAMERA_LERP_DECAY;

    if (this.settings.renderMoons && lod >= 2 && planet.moons.length) {
      ctx.strokeStyle = 'rgba(180,220,255,0.18)';
      ctx.lineWidth = 1 / this.camera.zoom;
      for (const moon of planet.moons) {
        ctx.beginPath();
        ctx.arc(planet.pos.x, planet.pos.y, planet.radius + moon.dist, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    this.paintPlanetBody(planet, lod, dt);

    if (this.settings.renderMoons && lod >= 3 && planet.moons.length) {
      this.drawMoons(planet, dt);
    }

    if (this.focusPlanet === planet) {
      this.drawSelectionRing(planet.pos.x, planet.pos.y, planet.radius * 1.08);
    }
  }

  private paintPlanetBody(planet: Planet, lod: number, dt: number): void {
    const ctx = this.ctx;

    if (lod < 2) {
      ctx.fillStyle = 'rgba(200,220,255,0.8)';
      ctx.beginPath();
      ctx.arc(planet.pos.x, planet.pos.y, Math.max(1.5, planet.radius * 0.6), 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    if (lod === 2) {
      const gradient = ctx.createRadialGradient(planet.pos.x, planet.pos.y, planet.radius * 0.2, planet.pos.x, planet.pos.y, planet.radius * 1.2);
      gradient.addColorStop(0, 'rgba(180,200,255,0.9)');
      gradient.addColorStop(1, 'rgba(80,120,200,0.15)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(planet.pos.x, planet.pos.y, planet.radius, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const textureSize = this.planetTextureSize(planet, lod);
    const texture = planet.getTexture(textureSize);
    const rotation = planet.rot + (planet.userSpin || 0);

    ctx.save();
    ctx.translate(planet.pos.x, planet.pos.y);
    ctx.rotate(rotation);
    ctx.drawImage(texture, -planet.radius, -planet.radius, planet.radius * 2, planet.radius * 2);

    if (lod >= 5 && this.settings.renderGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1 / this.camera.zoom;
      for (let angle = -Math.PI / 2; angle <= Math.PI / 2 + 1e-6; angle += Math.PI / 12) {
        const radius = planet.radius * Math.cos(angle);
        if (radius <= 0) {
          continue;
        }
        ctx.beginPath();
        ctx.arc(0, planet.radius * Math.sin(angle), radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      for (let angle = -Math.PI; angle <= Math.PI + 1e-6; angle += Math.PI / 12) {
        ctx.beginPath();
        const steps = 48;
        for (let i = 0; i <= steps; i += 1) {
          const t = -Math.PI / 2 + (i / steps) * Math.PI;
          const x = planet.radius * Math.cos(t) * Math.cos(angle);
          const y = planet.radius * Math.sin(t);
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
    }

    ctx.restore();

    if (this.settings.labels) {
      const screen = this.camera.worldToScreen(planet.pos, this.canvas);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(200,255,255,0.9)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(planet.name, screen.x, screen.y + planet.radius * this.camera.zoom + PLANET_LABEL_OFFSET);
      ctx.restore();
    }
  }

  private planetTextureSize(planet: Planet, lod: number): number {
    if (lod >= 5) {
      return Math.max(256, Math.min(4096, Math.floor(planet.radius * this.camera.zoom * 2.2)));
    }
    return Math.max(64, Math.min(1024, Math.floor(planet.radius * this.camera.zoom * 2)));
  }

  private drawMoons(planet: Planet, dt: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(220,220,240,0.9)';

    for (const moon of planet.moons) {
      moon.ang += moon.speed * dt * this.settings.animSpeed;
      const moonX = planet.pos.x + Math.cos(moon.ang) * (planet.radius + moon.dist);
      const moonY = planet.pos.y + Math.sin(moon.ang) * (planet.radius + moon.dist);

      ctx.beginPath();
      ctx.arc(moonX, moonY, moon.r, 0, Math.PI * 2);
      ctx.fill();

      const screen = this.camera.worldToScreen(new Vec2(moonX, moonY), this.canvas);
      const radiusScreen = Math.max(4, moon.r * this.camera.zoom);
      this.visibleObjectsScreen.push({ kind: 'moon', obj: { planet, moon }, x: screen.x, y: screen.y, r: radiusScreen });

      if (this.focusMoon === moon && this.focusMoonPlanet === planet) {
        this.drawSelectionRing(moonX, moonY, moon.r * 1.6);
      }
    }
  }

  private drawSelectionRing(x: number, y: number, radius: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,255,220,0.85)';
    ctx.lineWidth = Math.max(1, 2 / this.camera.zoom);
    ctx.setLineDash([STAR_SELECTION_DASH / this.camera.zoom, STAR_SELECTION_DASH / this.camera.zoom]);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawShips(ships: ReadonlyArray<RenderShip>): void {
    if (!this.settings.renderShips || ships.length === 0) {
      return;
    }

    const ctx = this.ctx;
    ctx.save();
    this.camera.apply(ctx, this.canvas);
    ctx.lineWidth = 1 / this.camera.zoom;

    for (const ship of ships) {
      this.drawShip(ship);
    }

    ctx.restore();
  }

  private drawShip(ship: RenderShip): void {
    const ctx = this.ctx;
    const direction = typeof ship.dir === 'number' ? ship.dir : Math.atan2(ship.target.y - ship.pos.y, ship.target.x - ship.pos.x);
    const length = 8;

    ctx.save();
    ctx.translate(ship.pos.x, ship.pos.y);
    ctx.rotate(direction);
    ctx.fillStyle = ship.isPlayer ? 'rgba(255,220,0,0.95)' : 'rgba(0,255,180,0.8)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-length, 2.2);
    ctx.lineTo(-length, -2.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (ship._remote && ship.name) {
      const screen = this.camera.worldToScreen(ship.pos, this.canvas);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(200,255,255,0.9)';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(ship.name, screen.x, screen.y - 12);
      ctx.restore();
    }

    if (ship.isPlayer) {
      ctx.strokeStyle = 'rgba(255,220,0,0.5)';
      ctx.beginPath();
      ctx.moveTo(ship.pos.x, ship.pos.y);
      ctx.lineTo(ship.target.x, ship.target.y);
      ctx.stroke();

      ctx.save();
      ctx.translate(ship.target.x, ship.target.y);
      ctx.strokeStyle = 'rgba(255,220,0,0.8)';
      const markerRadius = 6 / this.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, markerRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-markerRadius, 0);
      ctx.lineTo(markerRadius, 0);
      ctx.moveTo(0, -markerRadius);
      ctx.lineTo(0, markerRadius);
      ctx.stroke();
      ctx.restore();
    }
  }

  private computeLod(): number {
    const zoom = this.camera.zoom;
    if (zoom < 0.03) return -1;
    if (zoom < 0.09) return 0;
    if (zoom < 0.6) return 1;
    if (zoom < 2.4) return 2;
    if (zoom < 9.5) return 3;
    if (zoom < 25) return 4;
    return 5;
  }
}
