// Renderer: zeichnet Sterne, Planeten, Monde und Schiffe auf das Canvas
//
// Best Practices:
// - Kein globaler Zustand; alles über Instanz/Parameter
// - Sichtbarkeits-/Picking-Listen pro Frame zurücksetzen

import { worldToChunk, WORLD } from '../app/constants.js';
import { Vec2 } from '../core/math.js';

export class Renderer {
  constructor(canvas, camera, manager, settings) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;
    this.manager = manager;
    this.settings = settings;
    this.time = 0;
    this.focusPlanet = null;
    this.selection = null; // { kind: 'star'|'planet'|'moon', ... }
  // Cached gradients to vermeiden pro-Frame-Allokationen
  this._bgGrad = null;
  this._vignette = null;
  }

  resize() {
  const dpr = window.devicePixelRatio || 1;
  // Prefer visualViewport to avoid layout jumps when browser UI shows/hides
  const vv = window.visualViewport || { width: window.innerWidth, height: window.innerHeight };
  const w = Math.floor(vv.width * dpr), h = Math.floor(vv.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  _visibleChunks() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    const pad = 1.0;
    const x0 = this.camera.pos.x - w * 0.5 / this.camera.zoom - WORLD.CHUNK * pad;
    const y0 = this.camera.pos.y - h * 0.5 / this.camera.zoom - WORLD.CHUNK * pad;
    const x1 = this.camera.pos.x + w * 0.5 / this.camera.zoom + WORLD.CHUNK * pad;
    const y1 = this.camera.pos.y + h * 0.5 / this.camera.zoom + WORLD.CHUNK * pad;
    const ix0 = Math.floor(x0 / WORLD.CHUNK), iy0 = Math.floor(y0 / WORLD.CHUNK), ix1 = Math.floor(x1 / WORLD.CHUNK), iy1 = Math.floor(y1 / WORLD.CHUNK);
    const out = [];
    for (let iy = iy0; iy <= iy1; iy++) { for (let ix = ix0; ix <= ix1; ix++) { out.push([ix, iy]); } }
    return out;
  }

  _clear() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const w = this.canvas.width, h = this.canvas.height;
    // Hintergrund-Gradienten cache-basiert erzeugen
    if (!this._bgGrad || this._bgGradH !== h) {
      this._bgGrad = ctx.createLinearGradient(0, 0, 0, h);
      this._bgGrad.addColorStop(0, '#050a14'); this._bgGrad.addColorStop(1, '#00010a');
      this._bgGradH = h;
    }
    ctx.fillStyle = this._bgGrad; ctx.fillRect(0, 0, w, h);
    if (!this._vignette || this._vignetteW !== w || this._vignetteH !== h) {
      this._vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
      this._vignette.addColorStop(0, 'rgba(0,0,0,0)'); this._vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
      this._vignetteW = w; this._vignetteH = h;
    }
    ctx.fillStyle = this._vignette; ctx.fillRect(0, 0, w, h);
  }

  _drawStars(ch) {
    if (!this.settings.renderStars) return;
    const ctx = this.ctx;
    ctx.save();
    this.camera.apply(ctx, this.canvas);
    for (const s of ch.stars) {
      const r = s.size;
      const halo = ctx.createRadialGradient(s.pos.x, s.pos.y, r * 0.4, s.pos.x, s.pos.y, r * 4.5);
      halo.addColorStop(0, s.color); halo.addColorStop(0.6, s.color); halo.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(s.pos.x, s.pos.y, r * 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(s.pos.x, s.pos.y, r, 0, Math.PI * 2); ctx.fill();
      if (!this.visibleObjectsScreen) this.visibleObjectsScreen = [];
      const sc = this.camera.worldToScreen(s.pos, this.canvas);
      const rScreen = Math.max(8, r * this.camera.zoom * 2.2);
      this.visibleObjectsScreen.push({ kind: 'star', obj: s, x: sc.x, y: sc.y, r: rScreen });

      // Auswahl-Markierung für Stern
      if (this.selection && this.selection.kind === 'star' && this.selection.star === s) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,255,220,0.85)';
        ctx.lineWidth = Math.max(1, 2 / this.camera.zoom);
        ctx.setLineDash([6 / this.camera.zoom, 6 / this.camera.zoom]);
        ctx.beginPath(); ctx.arc(s.pos.x, s.pos.y, r * 1.6, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  _lod() {
    const z = this.camera.zoom;
    if (z < 0.03) return -1; if (z < 0.09) return 0; if (z < 0.6) return 1; if (z < 2.4) return 2; if (z < 9.5) return 3; if (z < 25) return 4; return 5;
  }

  _drawPlanets(ch, dt) {
    if (!this.settings.renderPlanets && !this.settings.renderOrbits) return;
    const ctx = this.ctx;
    ctx.save();
    this.camera.apply(ctx, this.canvas);
    const lod = this._lod();
    if (lod < 0) { ctx.restore(); return; }
    if (!this.visiblePlanetsScreen) this.visiblePlanetsScreen = [];

    // Orbits der Planeten um Sterne
    if (this.settings.renderOrbits) {
      ctx.strokeStyle = 'rgba(120,170,255,0.12)';
      ctx.lineWidth = 1 / this.camera.zoom;
      ctx.setLineDash([4 / this.camera.zoom, 4 / this.camera.zoom]);
      for (const s of ch.stars) {
        if (!s.planets || !s.planets.length) continue;
        for (const p of s.planets) { if (!p.orbitCenter) continue; ctx.beginPath(); ctx.arc(s.pos.x, s.pos.y, p.orbitRadius, 0, Math.PI * 2); ctx.stroke(); }
      }
      ctx.setLineDash([]);
    }

    if (this.settings.renderPlanets) {
      for (const p of ch.planets) {
        // Umlaufbahnupdate
        if (p.orbitCenter) {
          p.orbitAngle += p.orbitSpeed * dt * this.settings.animSpeed;
          p.pos.x = p.orbitCenter.x + Math.cos(p.orbitAngle) * p.orbitRadius;
          p.pos.y = p.orbitCenter.y + Math.sin(p.orbitAngle) * p.orbitRadius;
        }
        const sc = this.camera.worldToScreen(p.pos, this.canvas);
        const radiusScreen = p.radius * this.camera.zoom;
        const w = this.canvas.width / (window.devicePixelRatio || 1), h = this.canvas.height / (window.devicePixelRatio || 1);
        if (sc.x + radiusScreen < 0 || sc.y + radiusScreen < 0 || sc.x - radiusScreen > w || sc.y - radiusScreen > h) continue;
        this.visiblePlanetsScreen.push({ p, x: sc.x, y: sc.y, r: radiusScreen });
        if (!this.visibleObjectsScreen) this.visibleObjectsScreen = [];
        this.visibleObjectsScreen.push({ kind: 'planet', obj: p, x: sc.x, y: sc.y, r: Math.max(6, radiusScreen) });

        const isFocus = (this.focusPlanet === p);
        p.rot += dt * (isFocus ? 0.04 : 0.1) * this.settings.animSpeed + (p.userSpinVel || 0) * dt;
        p.userSpinVel *= 0.985;

        // Mondbahnen
        if (this.settings.renderMoons && lod >= 2 && p.moons.length) {
          ctx.strokeStyle = 'rgba(180,220,255,0.18)';
          ctx.lineWidth = 1 / this.camera.zoom;
          for (const m of p.moons) { ctx.beginPath(); ctx.arc(p.pos.x, p.pos.y, p.radius + m.dist, 0, Math.PI * 2); ctx.stroke(); }
        }

        // Planetendarstellung gemäß LOD
        if (lod < 2) {
          ctx.fillStyle = 'rgba(200,220,255,0.8)';
          ctx.beginPath(); ctx.arc(p.pos.x, p.pos.y, Math.max(1.5, p.radius * 0.6), 0, Math.PI * 2); ctx.fill();
        } else if (lod === 2) {
          const grad = ctx.createRadialGradient(p.pos.x, p.pos.y, p.radius * 0.2, p.pos.x, p.pos.y, p.radius * 1.2);
          grad.addColorStop(0, 'rgba(180,200,255,0.9)'); grad.addColorStop(1, 'rgba(80,120,200,0.15)');
          ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(p.pos.x, p.pos.y, p.radius, 0, Math.PI * 2); ctx.fill();
        } else if (lod < 5) {
          const sizeScreen = Math.max(64, Math.min(1024, Math.floor(p.radius * this.camera.zoom * 2)));
          p.ensureTexture(sizeScreen);
          ctx.save(); ctx.translate(p.pos.x, p.pos.y); ctx.rotate(p.rot + (p.userSpin || 0));
          const r = p.radius; ctx.drawImage(p._tex, -r, -r, r * 2, r * 2);
          ctx.restore();
          if (this.settings.labels) {
            ctx.save(); const sc2 = this.camera.worldToScreen(p.pos, this.canvas);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = 'rgba(200,255,255,0.9)'; ctx.font = '12px monospace'; ctx.textAlign = 'center';
            ctx.fillText(p.name, sc2.x, sc2.y + p.radius * this.camera.zoom + 14);
            ctx.restore();
          }
        } else {
          const r = p.radius;
          const sizeScreen = Math.max(256, Math.min(4096, Math.floor(p.radius * this.camera.zoom * 2.2)));
          p.ensureTexture(sizeScreen);
          ctx.save(); ctx.translate(p.pos.x, p.pos.y); ctx.rotate(p.rot + (p.userSpin || 0)); ctx.drawImage(p._tex, -r, -r, r * 2, r * 2);
          if (this.settings.renderGrid) {
            ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1 / this.camera.zoom;
            for (let a = -Math.PI / 2; a <= Math.PI / 2 + 1e-6; a += Math.PI / 12) { const rr = r * Math.cos(a); if (rr <= 0) continue; ctx.beginPath(); ctx.arc(0, r * Math.sin(a), rr, 0, Math.PI * 2); ctx.stroke(); }
            for (let a = -Math.PI; a <= Math.PI + 1e-6; a += Math.PI / 12) { ctx.beginPath(); const steps = 48; for (let i = 0; i <= steps; i++) { const t = -Math.PI / 2 + (i / steps) * Math.PI; const x = r * Math.cos(t) * Math.cos(a); const y = r * Math.sin(t); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke(); }
          }
          ctx.restore();
        }

        // Monde zeichnen und pickable machen
        if (this.settings.renderMoons && lod >= 3 && p.moons.length) {
          ctx.fillStyle = 'rgba(220,220,240,0.9)';
          for (const m of p.moons) {
            m.ang += m.speed * dt * this.settings.animSpeed;
            const mx = p.pos.x + Math.cos(m.ang) * (p.radius + m.dist);
            const my = p.pos.y + Math.sin(m.ang) * (p.radius + m.dist);
            ctx.beginPath(); ctx.arc(mx, my, m.r, 0, Math.PI * 2); ctx.fill();
            if (!this.visibleObjectsScreen) this.visibleObjectsScreen = [];
            const msc = this.camera.worldToScreen(new Vec2(mx, my), this.canvas);
            const mrScreen = Math.max(4, m.r * this.camera.zoom);
            this.visibleObjectsScreen.push({ kind: 'moon', obj: { planet: p, moon: m }, x: msc.x, y: msc.y, r: mrScreen });

            // Auswahl-Markierung für Mond
            if (this.selection && this.selection.kind === 'moon' && this.selection.moon === m) {
              ctx.save();
              ctx.strokeStyle = 'rgba(0,255,220,0.85)';
              ctx.lineWidth = Math.max(1, 2 / this.camera.zoom);
              ctx.setLineDash([6 / this.camera.zoom, 6 / this.camera.zoom]);
              ctx.beginPath(); ctx.arc(mx, my, m.r * 1.6, 0, Math.PI * 2); ctx.stroke();
              ctx.restore();
            }
          }
        }

        // Fokus-Markierung
        if (this.focusPlanet === p) {
          ctx.save(); ctx.strokeStyle = 'rgba(0,255,220,0.7)'; ctx.lineWidth = Math.max(1, 2 / this.camera.zoom);
          ctx.setLineDash([6 / this.camera.zoom, 6 / this.camera.zoom]); ctx.beginPath(); ctx.arc(p.pos.x, p.pos.y, p.radius * 1.08, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        }

        // Auswahl-Markierung für Planet
        if (this.selection && this.selection.kind === 'planet' && this.selection.planet === p) {
          ctx.save(); ctx.strokeStyle = 'rgba(0,255,220,0.85)'; ctx.lineWidth = Math.max(1, 2 / this.camera.zoom);
          ctx.setLineDash([6 / this.camera.zoom, 6 / this.camera.zoom]); ctx.beginPath(); ctx.arc(p.pos.x, p.pos.y, p.radius * 1.2, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  _drawShips(ships) {
    if (!this.settings.renderShips) return; if (!ships || !ships.length) return;
    const ctx = this.ctx; ctx.save(); this.camera.apply(ctx, this.canvas); ctx.lineWidth = 1 / this.camera.zoom;
    for (const s of ships) {
      const dir = (typeof s.dir === 'number') ? s.dir : Math.atan2(s.target.y - s.pos.y, s.target.x - s.pos.x);
      const l = 8; ctx.save(); ctx.translate(s.pos.x, s.pos.y); ctx.rotate(dir);
      ctx.fillStyle = s.isPlayer ? 'rgba(255,220,0,0.95)' : 'rgba(0,255,180,0.8)';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-l, 2.2); ctx.lineTo(-l, -2.2); ctx.closePath(); ctx.fill(); ctx.restore();
      // Name-Label für Remote-Schiffe, falls vorhanden
      if (s._remote && s.name) {
        const sc = this.camera.worldToScreen(s.pos, this.canvas);
        ctx.save(); ctx.setTransform(1,0,0,1,0,0);
        ctx.fillStyle = 'rgba(200,255,255,0.9)'; ctx.font = '11px monospace'; ctx.textAlign = 'center';
        ctx.fillText(s.name, sc.x, sc.y - 12);
        ctx.restore();
      }
      if (s.isPlayer) {
        ctx.strokeStyle = 'rgba(255,220,0,0.5)'; ctx.beginPath(); ctx.moveTo(s.pos.x, s.pos.y); ctx.lineTo(s.target.x, s.target.y); ctx.stroke();
        ctx.save(); ctx.translate(s.target.x, s.target.y); ctx.strokeStyle = 'rgba(255,220,0,0.8)';
        ctx.beginPath(); ctx.arc(0, 0, 6 / this.camera.zoom, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-6 / this.camera.zoom, 0); ctx.lineTo(6 / this.camera.zoom, 0); ctx.moveTo(0, -6 / this.camera.zoom); ctx.lineTo(0, 6 / this.camera.zoom); ctx.stroke(); ctx.restore();
      }
    }
    ctx.restore();
  }

  frame(dt, ships) {
    this.resize(); this._clear();
    this.visiblePlanetsScreen = []; this.visibleObjectsScreen = [];
    const wantsChunks = this.settings.renderStars || this.settings.renderPlanets || this.settings.renderOrbits;
    if (wantsChunks) {
      const visible = this._visibleChunks();
      for (const [ix, iy] of visible) { const ch = this.manager.getChunk(ix, iy, this.settings); this._drawStars(ch); this._drawPlanets(ch, dt); }
    }
    this._drawShips(ships);
  }
}
