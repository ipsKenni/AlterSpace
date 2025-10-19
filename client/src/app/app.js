// Anwendung/Controller: Verbindet Eingabe, Renderer, Welt und HUD
//
// Best Practices:
// - UI-Bindings klar getrennt von Rendering/Model
// - URL-Hash als Deep-Link für Ansicht und Auswahl

import { Vec2 } from '../core/math.js';
import { PRNG } from '../core/prng.js';
import { Camera } from '../core/camera.js';
import { InputController } from '../core/input.js';
import { WORLD } from './constants.js';
import { ChunkManager } from './chunks.js';
import { PlayerShip, Ship } from './model.js';
import { Renderer } from '../render/renderer.js';
import { NetClient } from '../net/client.js';
import { ScaleTiers } from './scale.js';
import { ShipInterior } from '../interior/interior.js';
import { SurfaceView } from '../surface/surface.js';

export class UniverseApp {
  constructor(canvas) {
    this.canvas = canvas;
    this.camera = new Camera();
    this.view = 'space'; // 'space' | 'interior' | 'surface'
    const env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};
    const configuredSignalUrl = env.VITE_SIGNAL_URL || '';
    this.settings = {
      seed: 'sol-42', starDensity: 1.0, planetDensity: 1.0, shipCount: 12, animSpeed: 1.0, zoomSpeed: 1.0, labels: true,
      renderStars: true, renderPlanets: true, renderOrbits: true, renderMoons: true, renderCities: true, renderGrid: true, renderShips: true,
      followShip: false,
      multiplayer: true,
      signalUrl: configuredSignalUrl, // leer = automatisch ermitteln (gleiches Host/Proto)
    };
    this.manager = new ChunkManager(this.settings.seed);
    this.renderer = new Renderer(canvas, this.camera, this.manager, this.settings);
    // Interior setup: dynamic canvas overlay
    this.interiorCanvas = document.getElementById('interiorCanvas');
    if (!this.interiorCanvas) {
      const ic = document.createElement('canvas'); ic.id = 'interiorCanvas';
      document.body.appendChild(ic); this.interiorCanvas = ic;
    }
  const playerNameEl = document.getElementById('playerName');
  const pname = playerNameEl ? (playerNameEl.value || 'Du') : 'Du';
    this.interior = new ShipInterior(this.interiorCanvas, { name: pname, onExit: () => { this.view = 'space'; if (this._updateViewSwitch) this._updateViewSwitch(); }, onConsole: () => {
      this.view = 'space';
      this.settings.followShip = true;
      try { const cb = document.getElementById('followShip'); if (cb) { cb.checked = true; } } catch {}
      if (this._updateViewSwitch) this._updateViewSwitch();
    } });
  // Surface setup
  this.surfaceCanvas = document.getElementById('surfaceCanvas');
  if (!this.surfaceCanvas) { const sc = document.createElement('canvas'); sc.id = 'surfaceCanvas'; document.body.appendChild(sc); this.surfaceCanvas = sc; }
  this.surface = new SurfaceView(this.surfaceCanvas, { seed: this.settings.seed, name: pname, onExit: () => { this.view = 'interior'; if (this._updateViewSwitch) this._updateViewSwitch(); } });
    this.focusPlanet = null;
    this.selection = null;
    this.autoFocus = null;
    this.input = new InputController(canvas, this.camera, this.settings, this);
    this.ships = [];
    this.playerShip = new PlayerShip(new Vec2(0, 0));
    this._spawnShips();

    // Multiplayer
    this.remoteShips = new Map(); // idHash -> { pos: Vec2, last, name, hash, dir }
    if (this.settings.multiplayer) {
      const url = this.settings.signalUrl || this._computeSignalUrl();
      this.net = new NetClient({
        url,
        onSnapshot: (list) => this._applySnapshot(list),
      });
      this.net.onChat = (evt) => this._onChat(evt);
      // Beam request from others
      this.net.onBeamRequest = (evt) => {
        // Simple confirm dialog; accept beams you into sender's context
        const ok = confirm(`${evt.name||'Spieler'} möchte dich beamen. Annehmen?`);
        if (!ok) { this.net.respondBeam(evt.from>>>0, false); return; }
        // Accept: reply with our target (current view or interior/space)
        const scene = this.view === 'surface' ? 1 : (this.view === 'interior' ? 2 : 0);
        const body = scene === 1 ? this._currentBodyId() : 0;
        const ship = scene === 2 ? 1 : 0;
        let tileX = 0, tileY = 0;
        if (scene === 1 && this.surface) { const t = this.surface.getAvatarTile(); tileX = t.x|0; tileY = t.y|0; }
        if (scene === 2 && this.interior) { tileX = this.interior.avatar.x|0; tileY = this.interior.avatar.y|0; }
        this.net.respondBeam(evt.from>>>0, true, scene, body, tileX, tileY, ship);
      };
      // Beam response to our outgoing request
      this.net.onBeamResponse = (evt) => {
        if (!evt.accept) { this._appendChatSystem(`${evt.name||'Spieler'} hat deine Beam-Anfrage abgelehnt.`); return; }
        // Move into target's scene
        if (evt.scene === 0) { this.view = 'space'; }
        if (evt.scene === 2) { this.view = 'interior'; }
        if (evt.scene === 1) {
          // Ensure surface context
          if (!this.focusPlanet) { /* keep current */ }
          if (this.surface) {
            this.surface.avatar.x = evt.tileX|0; this.surface.avatar.y = evt.tileY|0;
            this.surface.avatar.px = this.surface.avatar.x; this.surface.avatar.py = this.surface.avatar.y; this.surface.avatar.path = [];
          }
          this.view = 'surface';
        }
        if (this._updateViewSwitch) this._updateViewSwitch();
        // Presence will update automatically on next tick
      };
      // Remote move targets -> simulate locally
      this.net.onRemoteMove = (evt) => {
        const hash = evt.from>>>0;
        const e = this.remoteShips.get(hash);
        if (e) {
          e.target = new Vec2(evt.x, evt.y);
        } else {
          // create a ghost entry to simulate until snapshot arrives
          this.remoteShips.set(hash, { pos: new Vec2(evt.x, evt.y), target: new Vec2(evt.x, evt.y), last: performance.now(), name: '', hash, dir: 0, scene: 0, body: 0, tileX: 0, tileY: 0 });
        }
      };
      this.net.connect().catch(()=>{});
    }

    this._hookHUD();
    this._bindResize();
    this._bindPicking();
  this._bindViewSwitch();
    this._initStartView();
    this.currentId = null; this._lastViewStr = '';
    this.running = true;
    this._loop();
  }

  _initStartView() {
    if ((location.hash || '').length > 1) return;
    this.camera.pos = new Vec2(0, 0);
    this.camera.zoom = 0.3;
  }

  _bindResize() {
  let rafId = 0;
  const onRes = () => { if (rafId) cancelAnimationFrame(rafId); rafId = requestAnimationFrame(() => { this.renderer.resize(); this.interior.resize(); this.surface.resize(); }); };
  window.addEventListener('resize', onRes);
  if (window.visualViewport) { try { window.visualViewport.addEventListener('resize', onRes, { passive: true }); } catch {} }
  this.renderer.resize();
  this.interior.resize(); this.surface.resize();
  }

  _bindPicking() {
    this.canvas.addEventListener('click', (e) => {
      if (this.view !== 'space') return;
      const world = this.camera.screenToWorld(new Vec2(e.clientX, e.clientY), this.canvas);
      const sel = this._pickObject(world);
      if (!sel) return;
      if (sel.kind === 'star') {
        this._focusStar(sel.obj);
        this._setSelection({ kind: 'star', star: sel.obj });
        this.currentId = sel.obj.id; this._setHash(this.currentId);
      } else if (sel.kind === 'planet') {
        this._focusPlanet(sel.obj, true);
        this._setSelection({ kind: 'planet', planet: sel.obj, star: sel.obj.star });
        this.currentId = sel.obj.id; this._setHash(this.currentId);
      } else if (sel.kind === 'moon') {
        this._focusPlanet(sel.obj.planet, true);
        this._setSelection({ kind: 'moon', moon: sel.obj.moon, planet: sel.obj.planet, star: sel.obj.planet.star });
        this.currentId = sel.obj.moon.id; this._setHash(this.currentId);
      }
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      if (this.view !== 'space') return false;
      e.preventDefault();
      const world = this.camera.screenToWorld(new Vec2(e.clientX, e.clientY), this.canvas);
      const sel = this._pickObject(world);
      if (!sel) { this.playerShip.target = world.clone(); return false; }
      if (sel.kind === 'star') { this.playerShip.target = sel.obj.pos.clone(); return false; }
      if (sel.kind === 'planet') { this.playerShip.target = sel.obj.pos.clone(); return false; }
      if (sel.kind === 'moon') {
        const m = sel.obj.moon, p = sel.obj.planet;
        const mx = p.pos.x + Math.cos(m.ang) * (p.radius + m.dist);
        const my = p.pos.y + Math.sin(m.ang) * (p.radius + m.dist);
        this.playerShip.target = new Vec2(mx, my);
        return false;
      }
      return false;
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.focusPlanet = null; this.renderer.focusPlanet = null; this.autoFocus = null;
        const pi = document.getElementById('planetInfo'); pi.style.display = 'none';
      }
    });
    window.addEventListener('hashchange', () => this._navigateFromHash());
    this._navigateFromHash();
  }

  // Called by InputController on touch tap
  onTap(clientX, clientY) {
  if (this.view !== 'space') return;
    const world = this.camera.screenToWorld(new Vec2(clientX, clientY), this.canvas);
    const sel = this._pickObject(world);
    if (!sel) return;
    if (sel.kind === 'star') {
      this._focusStar(sel.obj);
      this._setSelection({ kind: 'star', star: sel.obj });
      this.currentId = sel.obj.id; this._setHash(this.currentId);
    } else if (sel.kind === 'planet') {
      this._focusPlanet(sel.obj, true);
      this._setSelection({ kind: 'planet', planet: sel.obj, star: sel.obj.star });
      this.currentId = sel.obj.id; this._setHash(this.currentId);
    } else if (sel.kind === 'moon') {
      this._focusPlanet(sel.obj.planet, true);
      this._setSelection({ kind: 'moon', moon: sel.obj.moon, planet: sel.obj.planet, star: sel.obj.planet.star });
      this.currentId = sel.obj.moon.id; this._setHash(this.currentId);
    }
  }

  _bindViewSwitch() {
    const btn = document.getElementById('viewSwitch'); if (!btn) return;
  const update = () => {
      const isInterior = this.view === 'interior';
      const isSurface = this.view === 'surface';
  this.interior.active = isInterior;
  this.surface.active = isSurface;
      this.interiorCanvas.style.display = isInterior ? 'block' : 'none';
      this.surfaceCanvas.style.display = isSurface ? 'block' : 'none';
      this.canvas.style.display = (!isInterior && !isSurface) ? 'block' : 'none';
      btn.textContent = isInterior ? 'Welt' : 'Innen';
      const landBtn = document.getElementById('landBtn'); const takeoffBtn = document.getElementById('takeoffBtn');
      if (landBtn && takeoffBtn) { landBtn.style.display = (!isInterior && !isSurface && this._canLandHere()) ? 'block' : 'none'; takeoffBtn.style.display = isSurface ? 'block' : 'none'; takeoffBtn.textContent = 'Beamen'; }
      // Mobile bar sync
      const mb = document.getElementById('mobileBar');
      const mbView = document.getElementById('mb_view');
      const mbLand = document.getElementById('mb_land');
      const mbBeam = document.getElementById('mb_beam');
      if (mbView) mbView.textContent = isInterior ? 'Welt' : 'Innen';
      if (mbLand) mbLand.style.display = (!isInterior && !isSurface && this._canLandHere()) ? 'inline-block' : 'none';
      if (mbBeam) mbBeam.style.display = isSurface ? 'inline-block' : 'none';
      // D-Pad visibility on view change
      const dpadEl = document.getElementById('dpad');
      if (dpadEl) {
        const isMobile = window.matchMedia('(max-width: 900px)').matches;
        dpadEl.style.display = (isMobile && (isSurface || isInterior)) ? 'flex' : 'none';
      }
    };
  this._updateViewSwitch = update;
    btn.addEventListener('click', () => { this.view = (this.view === 'space') ? 'interior' : 'space'; update(); this._sendPresence(); });
    // Mobile bar handlers
    const mbView = document.getElementById('mb_view');
    const mbLand = document.getElementById('mb_land');
    const mbBeam = document.getElementById('mb_beam');
    if (mbView) mbView.addEventListener('click', () => { this.view = (this.view === 'space') ? 'interior' : 'space'; update(); this._sendPresence(); });
    if (mbLand) mbLand.addEventListener('click', () => this._tryLand());
    if (mbBeam) mbBeam.addEventListener('click', () => { this.view = 'interior'; update(); this._sendPresence(); });
    update();

    // Landing buttons
    const landBtn = document.getElementById('landBtn'); const takeoffBtn = document.getElementById('takeoffBtn');
  if (landBtn) landBtn.addEventListener('click', () => this._tryLand());
  if (takeoffBtn) takeoffBtn.addEventListener('click', () => { this.view = 'interior'; update(); this._sendPresence(); });

    // D-pad controls for mobile
    const dpad = document.getElementById('dpad');
    const applyDpadVis = () => {
      if (!dpad) return;
      dpad.style.display = (window.matchMedia('(max-width: 900px)').matches && (this.view === 'surface' || this.view === 'interior')) ? 'flex' : 'none';
    };
    applyDpadVis();
    window.addEventListener('resize', applyDpadVis);
    const dirMap = { left: [-1,0], right:[1,0], nw:[-1,-1], se:[1,1] };
    if (dpad) dpad.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const v = dirMap[btn.dataset.dir]; if (!v) return;
      const view = this.view === 'surface' ? this.surface : (this.view === 'interior' ? this.interior : null);
      if (view && typeof view._tryStep === 'function') view._tryStep(v[0], v[1]);
    });
  }

  _setSelection(sel) { this.selection = sel; this.renderer.selection = sel; this._updateSelectionPanel(); }

  _updateSelectionPanel() {
    const panel = document.getElementById('selectionInfo');
    if (!this.selection) { panel.style.display = 'none'; return; }
    const s = this.selection; const n = id => document.getElementById(id);
    let name = '–', type = '–', path = '–', stats = '';
    if (s.kind === 'star') {
      name = s.star.id; type = `Stern ${s.star.type}`; path = 'Stern'; stats = `Leuchtkraft: ${s.star.lum.toFixed(2)} • Größe: ${s.star.size.toFixed(0)} wu`;
    } else if (s.kind === 'planet') {
      name = s.planet.name; type = s.planet.type + (s.planet.hasRings ? ' • Ringe' : '');
      const starLabel = s.star ? (s.star.id) : 'Stern'; path = `Planet → ${starLabel}`; stats = `Radius: ${s.planet.radius.toFixed(0)} wu • Monde: ${s.planet.moons.length}`;
    } else if (s.kind === 'moon') {
      name = `${s.planet.name} – Mond ${s.moon.index + 1}`; type = 'Mond';
      const starLabel = s.star ? s.star.id : 'Stern'; path = `Mond → Planet ${s.planet.name} → ${starLabel}`;
      stats = `Mond-Radius: ${s.moon.r.toFixed(0)} wu • Bahn: ${(s.planet.radius + s.moon.dist).toFixed(0)} wu`;
    }
    n('sel_kind').textContent = s.kind.charAt(0).toUpperCase() + s.kind.slice(1);
    n('sel_name').textContent = name; n('sel_type').textContent = type; n('sel_path').textContent = path; n('sel_stats').textContent = stats;
    panel.style.display = 'block';
  }

  _focusPlanet(p, autoZoom) {
    this.focusPlanet = p; this.renderer.focusPlanet = p; this.camera.pos = p.pos.clone();
    if (autoZoom) { const targetZoom = Math.max(25, this.camera.zoom * 1.8); this.autoFocus = { targetZoom, speed: 2.2 }; }
  }

  _focusStar(s) { this.focusPlanet = null; this.renderer.focusPlanet = null; this.camera.pos = s.pos.clone(); this.autoFocus = null; }

  _pickObject(worldPt) {
    const sc = this.camera.worldToScreen(worldPt, this.canvas);
    const vos = this.renderer.visibleObjectsScreen; const vps = this.renderer.visiblePlanetsScreen;
    const list = (vos && vos.length) ? vos : (vps || []);
    let best = null, bestD = 1e9;
    for (const it of list) { const d = Math.hypot(sc.x - it.x, sc.y - it.y) - it.r; if (d < bestD) { bestD = d; best = it; } }
    const th = 30; if (!(best && bestD < th)) return null;
    if (!best.kind && best.p) { return { kind: 'planet', obj: best.p, x: best.x, y: best.y, r: best.r }; }
    return best;
  }

  _setHash(id) {
    try {
      const seedPart = `seed=${encodeURIComponent(this.settings.seed)}`;
      const x = Math.round(this.camera.pos.x), y = Math.round(this.camera.pos.y), z = Number(this.camera.zoom.toFixed(4));
      const viewPart = `view=${x},${y},${z}`; const parts = [seedPart, viewPart]; if (id) parts.push(`id=${id}`);
      const newHash = parts.join(';'); const cur = (location.hash || '').replace(/^#/, ''); if (cur === newHash) return;
      if (history && history.replaceState) { history.replaceState(null, '', '#' + newHash); } else { location.hash = newHash; }
    } catch {}
  }

  _navigateFromHash() {
    const raw = (location.hash || '').replace(/^#/, ''); if (!raw) return;
    let seed = null, view = null, id = null; const segs = raw.split(';');
    for (const seg of segs) {
      if (!seg) continue; if (seg.startsWith('seed=')) seed = decodeURIComponent(seg.slice(5));
      else if (seg.startsWith('view=')) view = seg.slice(5);
      else if (seg.startsWith('id=')) id = seg.slice(3); else if (/^[spm]:/.test(seg)) id = seg;
    }
    if (seed && seed !== this.settings.seed) { this.settings.seed = seed; const seedInput = document.getElementById('seed'); if (seedInput) seedInput.value = seed; this._regen(); return; }
    if (!id && view) { const [sx, sy, sz] = view.split(','); const x = parseFloat(sx), y = parseFloat(sy), z = parseFloat(sz); if (isFinite(x) && isFinite(y) && isFinite(z)) { this.camera.pos = new Vec2(x, y); this.camera.zoom = Math.min(this.camera.maxZoom, Math.max(this.camera.minZoom, z)); this.focusPlanet = null; this.renderer.focusPlanet = null; this.autoFocus = null; } }
    if (!id) return; this.currentId = id; const parts = id.split(':'); if (parts.length < 2) return; const kind = parts[0];
    const parsePair = (s) => s.split(',').map(x => parseInt(x, 10));
    if (kind === 's' && parts.length >= 3) {
      const [ix, iy] = parsePair(parts[1]); const si = parseInt(parts[2], 10);
      if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(si)) return;
      const ch = this.manager.getChunk(ix, iy, this.settings);
      let s = null; if (ch && ch.stars) s = ch.stars.find(st => st.index === si) || null; if (s) this._focusStar(s);
    } else if (kind === 'p' && parts.length >= 4) {
      const [ix, iy] = parsePair(parts[1]); const si = parseInt(parts[2], 10); const pi = parseInt(parts[3], 10);
      if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(si) || !Number.isFinite(pi)) return;
      const ch = this.manager.getChunk(ix, iy, this.settings);
      let s = null; if (ch && ch.stars) s = ch.stars.find(st => st.index === si) || null; if (s && s.planets && s.planets[pi]) this._focusPlanet(s.planets[pi], true);
    } else if (kind === 'm' && parts.length >= 5) {
      const [ix, iy] = parsePair(parts[1]); const si = parseInt(parts[2], 10); const pi = parseInt(parts[3], 10); const mi = parseInt(parts[4], 10);
      if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(si) || !Number.isFinite(pi) || !Number.isFinite(mi)) return;
      const ch = this.manager.getChunk(ix, iy, this.settings);
      let s = null; if (ch && ch.stars) s = ch.stars.find(st => st.index === si) || null; if (s && s.planets && s.planets[pi]) { const p = s.planets[pi]; if (p.moons && p.moons[mi]) this._focusPlanet(p, true); }
    }
  }

  _updateViewHash() { const id = this.currentId; this._setHash(id); }

  _computeSignalUrl() {
    const env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};
    if (env.VITE_SIGNAL_URL) return env.VITE_SIGNAL_URL;
    if (env.DEV) return 'ws://localhost:8080';
    try {
      const loc = window.location;
      const isHttps = loc.protocol === 'https:';
      const proto = isHttps ? 'wss:' : 'ws:';
      const host = loc.host || 'localhost:8080';
      return `${proto}//${host}`;
    } catch { return 'ws://localhost:8080'; }
  }

  _hookHUD() {
    const el = id => document.getElementById(id);
    // HUD toggle (mobile)
    const hud = el('hud'); const hudToggle = el('hudToggle');
    if (hud && hudToggle) {
      const show = (v) => { hud.style.display = v ? 'block' : 'none'; hudToggle.setAttribute('aria-pressed', v ? 'true' : 'false'); };
      // default: hidden on small screens, visible on large
      const mq = window.matchMedia('(max-width: 900px)');
      const apply = () => { show(!mq.matches ? true : false); };
      try { mq.addEventListener('change', apply); } catch { mq.onchange = apply; }
      apply();
      hudToggle.addEventListener('click', () => { show(hud.style.display === 'none'); });
    }
    el('seed').value = this.settings.seed;
    el('regen').addEventListener('click', () => { this.settings.seed = el('seed').value || 'seed'; this._regen(); });
    el('pause').addEventListener('click', () => { this.running = !this.running; el('pause').textContent = this.running ? 'Pause' : 'Start'; if (this.running) this._loop(); });
    el('zoomSpeed').addEventListener('input', e => this.settings.zoomSpeed = parseFloat(e.target.value));
    el('starDensity').addEventListener('input', e => this.settings.starDensity = parseFloat(e.target.value));
    el('planetDensity').addEventListener('input', e => this.settings.planetDensity = parseFloat(e.target.value));
    el('shipCount').addEventListener('input', e => { this.settings.shipCount = parseInt(e.target.value, 10); this._spawnShips(); });
    el('animSpeed').addEventListener('input', e => this.settings.animSpeed = parseFloat(e.target.value));
    el('labels').addEventListener('change', e => this.settings.labels = !!e.target.checked);
    el('renderStars').addEventListener('change', e => this.settings.renderStars = !!e.target.checked);
    el('renderPlanets').addEventListener('change', e => this.settings.renderPlanets = !!e.target.checked);
    el('renderOrbits').addEventListener('change', e => this.settings.renderOrbits = !!e.target.checked);
    el('renderMoons').addEventListener('change', e => this.settings.renderMoons = !!e.target.checked);
    el('renderCities').addEventListener('change', e => this.settings.renderCities = !!e.target.checked);
    el('renderGrid').addEventListener('change', e => this.settings.renderGrid = !!e.target.checked);
    el('renderShips').addEventListener('change', e => this.settings.renderShips = !!e.target.checked);
    el('followShip').addEventListener('change', e => this.settings.followShip = !!e.target.checked);

    const nameEl = el('playerName');
    if (nameEl) {
      // aus localStorage laden
      try { const saved = localStorage.getItem('playerName') || ''; if (saved) nameEl.value = saved; } catch {}
      const set = () => {
        const v = (nameEl.value||'').trim();
        try { localStorage.setItem('playerName', v); } catch {};
        if (this.net) this.net.setName(v);
        // Update local avatar names in interior and surface
        if (this.interior && this.interior.avatar) this.interior.avatar.name = v || 'Du';
        if (this.surface && this.surface.avatar) this.surface.avatar.name = v || 'Du';
      };
      nameEl.addEventListener('change', set); nameEl.addEventListener('keydown', (e)=>{ if (e.key==='Enter') set(); });
      set();
    }

    const flyBtn = el('sel_fly');
    if (flyBtn) {
      flyBtn.addEventListener('click', () => {
        if (!this.selection) return; let targetPos = null;
        if (this.selection.kind === 'star') targetPos = this.selection.star.pos.clone();
        else if (this.selection.kind === 'planet') targetPos = this.selection.planet.pos.clone();
        else if (this.selection.kind === 'moon') {
          const m = this.selection.moon, p = this.selection.planet;
          targetPos = new Vec2(p.pos.x + Math.cos(m.ang) * (p.radius + m.dist), p.pos.y + Math.sin(m.ang) * (p.radius + m.dist));
        }
        if (targetPos) {
          this.playerShip.target = targetPos;
          if (this.net) this.net.sendMoveTarget(targetPos.x, targetPos.y);
        }
      });
    }

    window.addEventListener('keypress', e => {
      if (e.key.toLowerCase() === 'r') { this._initStartView(); this.focusPlanet = null; this.renderer.focusPlanet = null; }
    });

    // Chat Controls
    const chatSend = el('chatSend'); const chatInput = el('chatInput');
    if (chatSend && chatInput) {
      chatSend.addEventListener('click', () => {
        const txt = chatInput.value.trim(); if (!txt) return;
        const pos = this.playerShip ? this.playerShip.pos : new Vec2(0,0);
        if (this.net) this.net.sendChatPublic(pos.x, pos.y, 8000, txt);
        chatInput.value = '';
      });
      chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') chatSend.click(); });
    }
    const pmSend = el('pmSend'); const pmTarget = el('pmTarget'); const pmInput = el('pmInput');
    if (pmSend && pmTarget && pmInput) {
      pmSend.addEventListener('click', () => {
        const txt = pmInput.value.trim(); const tgt = parseInt(pmTarget.value, 10);
        if (!txt || !Number.isFinite(tgt)) return;
        if (this.net) this.net.sendChatPrivate(tgt >>> 0, txt);
        pmInput.value = '';
      });
      pmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pmSend.click(); });
    }
  }

  _regen() {
    this.manager = new ChunkManager(this.settings.seed);
    this.renderer.manager = this.manager;
    this._spawnShips();
    if ((location.hash || '').length > 1) this._navigateFromHash();
  }

  _spawnShips() {
    const pr = new PRNG('ships-' + this.settings.seed);
    const ships = []; const n = this.settings.shipCount;
    for (let i = 0; i < n; i++) {
      const p = new Vec2(pr.float(-1, 1) * WORLD.CHUNK * 2, pr.float(-1, 1) * WORLD.CHUNK * 2);
      const t = Vec2.add(p, Vec2.fromPolar(pr.float(1000, 4000), pr.float(0, Math.PI * 2)));
      ships.push(new Ship(p, t));
    }
    if (!this.playerShip) this.playerShip = new PlayerShip(new Vec2(0, 0));
    this.playerShip.speed = 180;
    this.ships = [this.playerShip, ...ships];
  }

  _updateShips(dt) {
    if (!this.settings.renderShips) return;
    // simulate local player ship
    if (this.playerShip && typeof this.playerShip.update === 'function') this.playerShip.update(dt);
    // simulate remotes toward their last move target if present
    for (const e of this.remoteShips.values()) {
      if (!e || !e.target) continue;
      const dirx = e.target.x - e.pos.x, diry = e.target.y - e.pos.y; const d = Math.hypot(dirx, diry);
      const speed = 160; // wu/s for remotes
      if (d > 1) { e.pos.x += (dirx / d) * speed * dt; e.pos.y += (diry / d) * speed * dt; }
    }
    // Optionally send position at a low rate if needed for interest grid
    if (this.net && this.playerShip) { this.net.sendPosition(this.playerShip.pos.x, this.playerShip.pos.y); }
  }

  _updateHUD(dt) {
    const fpsEl = document.getElementById('fps'); this._fpsAcc = (this._fpsAcc || 0) * 0.9 + (1 / dt) * 0.1; if (isFinite(this._fpsAcc)) fpsEl.textContent = `${this._fpsAcc.toFixed(0)} FPS`;
    const label = document.getElementById('scaleLabel'); const detail = document.getElementById('scaleDetail');
    const viewWU = (this.canvas.width / (window.devicePixelRatio || 1)) / this.camera.zoom; const tier = ScaleTiers.pick(viewWU);
    label.textContent = `Bereich: ${tier.name}`; detail.textContent = `ca. Ausdehnung: ${tier.pretty}`;

    const pi = document.getElementById('planetInfo');
    if (this.focusPlanet) {
      pi.style.display = 'block'; const p = this.focusPlanet; const n = id => document.getElementById(id);
      n('pi_name').textContent = p.name; n('pi_type').textContent = `${p.type}${p.hasRings ? ' • Ringe' : ''}`;
      const deg = x => `${x.toFixed(0)}°`; const hrs = x => `${x.toFixed(1)} h`;
      n('pi_stats').textContent = `Radius: ${(p.radius).toFixed(0)} wu • Masse: ${p.mass.toFixed(1)} M⊕ • g: ${p.gravity.toFixed(1)} m/s² • Tag: ${hrs(p.dayLength)} • Achse: ${deg(p.axialTilt)}`;
      n('pi_env').textContent = `Temperatur: ${p.temperature.toFixed(0)} K • Atmosphäre: ${p.atmosphere} • Monde: ${p.moons.length}`;
    } else { pi.style.display = 'none'; }

    const si = document.getElementById('shipInfo');
    if (this.settings.renderShips && this.playerShip) {
      si.style.display = 'block'; const n = id => document.getElementById(id);
      const pos = this.playerShip.pos; const tgt = this.playerShip.target; const dist = Math.hypot(tgt.x - pos.x, tgt.y - pos.y);
      const eta = this.playerShip.speed > 0 ? dist / this.playerShip.speed : Infinity;
      n('si_pos').textContent = `${pos.x.toFixed(0)}, ${pos.y.toFixed(0)} wu`;
      n('si_speed').textContent = `${this.playerShip.speed.toFixed(0)} wu/s`;
      n('si_target').textContent = `${tgt.x.toFixed(0)}, ${tgt.y.toFixed(0)} wu`;
      n('si_dist').textContent = `${dist.toFixed(0)} wu`;
      n('si_eta').textContent = isFinite(eta) ? `${eta.toFixed(1)} s` : '–';
    } else { si.style.display = 'none'; }

    // Nearby players: innerhalb ~8000 wu anzeigen, plus Präsenzmeldungen
    const nearListElId = 'nearbyList';
    let nearEl = document.getElementById(nearListElId);
    if (!nearEl) { nearEl = document.createElement('div'); nearEl.id = nearListElId; nearEl.style.marginTop = '6px'; const chatPanel = document.getElementById('chatPanel'); if (chatPanel) chatPanel.appendChild(nearEl); }
    const me = this.playerShip ? this.playerShip.pos : new Vec2(0,0);
    const near = [];
    for (const e of this.remoteShips.values()) {
      const dx = e.pos.x - me.x, dy = e.pos.y - me.y; const d2 = dx*dx + dy*dy;
      if (d2 < 8000*8000) near.push({ name: e.name||'', hash: e.hash >>> 0, dist2: d2 });
    }
    near.sort((a,b)=>a.dist2-b.dist2);
    // Presence join/leave
    const prev = this._nearSet || new Set();
    const cur = new Set(near.map(it => it.hash >>> 0));
    for (const h of cur) if (!prev.has(h)) { const ent = near.find(x => (x.hash>>>0) === h); if (ent) this._appendChatSystem(`in Reichweite: ${ent.name||'Spieler'} (#${this._fmtHash(h)})`); }
    for (const h of prev) if (!cur.has(h)) { this._appendChatSystem(`außer Reichweite: #${this._fmtHash(h)}`); }
    this._nearSet = cur;

    const lines = near.slice(0,8).map(it => `• ${it.name||'Spieler'} (#${this._fmtHash(it.hash||0)})`);
    nearEl.textContent = lines.length ? `Nahe Spieler: ${lines.join('  ')}` : 'Nahe Spieler: –';
    // Add simple beam request action when selecting a nearby target via prompt (first item)
    if (near.length) {
      let ui = document.getElementById('beamReqBtn');
      if (!ui) {
        ui = document.createElement('button'); ui.id = 'beamReqBtn'; ui.textContent = 'Beam-Anfrage an Nächsten'; ui.style.marginLeft = '8px';
        nearEl.appendChild(ui);
        ui.addEventListener('click', () => {
          const tgt = near[0]; if (!tgt) return;
          if (this.net) this.net.requestBeam(tgt.hash>>>0, 'Lass mich zu dir beamen?');
          this._appendChatSystem(`Beam-Anfrage an #${this._fmtHash(tgt.hash||0)} gesendet.`);
        });
      }
    }
  }

  _fmtHash(h) { const x = (h>>>0).toString(16).padStart(8,'0'); return x; }

  _loop() {
    let last = performance.now();
    const tick = (t) => {
      if (!this.running) return;
      const now = performance.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (this.view === 'space') { this.renderer.time += dt; this.input.update(dt); this._updateShips(dt); }
      if (this.focusPlanet) {
        this.renderer.focusPlanet = this.focusPlanet; this.camera.pos = this.focusPlanet.pos.clone();
        if (this.autoFocus) {
          const zt = this.autoFocus.targetZoom; const z = this.camera.zoom; const dz = (zt - z) * Math.min(1, this.autoFocus.speed * dt);
          this.camera.zoom = Math.min(this.camera.maxZoom, Math.max(this.camera.minZoom, z + dz));
          if (Math.abs(this.camera.zoom - zt) < 0.02) this.autoFocus = null;
        }
      } else if (this.settings.followShip && this.playerShip) { this.camera.pos = this.playerShip.pos.clone(); }
      // Remote-Schiffe mergen
      this._syncRemoteShipsToScene();
      if (this.view === 'space') {
        this.renderer.frame(dt, this.ships);
        if (this._updateViewSwitch) this._updateViewSwitch(); // keep landing button state fresh
      } else if (this.view === 'interior') {
        this.interior.frame(dt);
      } else if (this.view === 'surface') {
        // Map nearby remotes into the current surface context
        const rem = [];
        const curBody = this._currentBodyId()|0;
        for (const e of this.remoteShips.values()) {
          // Only show players also on surface and same body id
          if ((e.scene|0) !== 1) continue; // 1 = surface
          if ((e.body|0) !== curBody) continue;
          // Prefer tile coords from presence; fallback to mapped ship pos
          const tx = Number.isFinite(e.tileX) ? (e.tileX|0) : ((e.pos.x/50)|0);
          const ty = Number.isFinite(e.tileY) ? (e.tileY|0) : ((e.pos.y/50)|0);
          rem.push({ id: (e.hash>>>0), x: tx, y: ty, name: e.name||'' });
        }
        this.surface.setRemotes(rem);
        this.surface.frame(dt);
      }
      this._sendPresence(dt);
      this._updateHUD(dt);
      if (this.view === 'space') this._updateViewHash();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _canLandHere() {
    if (!this.settings.renderPlanets) return false;
    const list = this.renderer.visiblePlanetsScreen || [];
    const cx = (this.canvas.width / (window.devicePixelRatio||1)) / 2; const cy = (this.canvas.height / (window.devicePixelRatio||1)) / 2;
    let best = null, bestD = Infinity;
    for (const it of list) { const d = Math.hypot(it.x - cx, it.y - cy) - it.r; if (d < bestD) { bestD = d; best = it; } }
    return best && bestD < 40;
  }

  _tryLand() {
    if (!this._canLandHere()) return;
    const cx = (this.canvas.width / (window.devicePixelRatio||1)) / 2; const cy = (this.canvas.height / (window.devicePixelRatio||1)) / 2;
    const pick = () => {
      const vos = this.renderer.visibleObjectsScreen || [];
      let best = null, bestD = Infinity;
      for (const it of vos) { if (it.kind !== 'planet' && it.kind !== 'moon') continue; const d = Math.hypot(it.x - cx, it.y - cy) - it.r; if (d < bestD) { bestD = d; best = it; } }
      return best && bestD < 40 ? best : null;
    };
    const target = pick(); if (!target) return;
    let bodyName = 'Körper', bodyType = 'planetar', gravity = 9.8;
    if (target.kind === 'planet') { const p = target.obj; bodyName = p.name; bodyType = p.type; gravity = p.gravity||9.8; }
    else if (target.kind === 'moon') { const m = target.obj.moon, p = target.obj.planet; bodyName = `${p.name} – Mond ${m.index+1}`; bodyType = 'Mond'; gravity = (p.gravity||9.8)*0.16; }
    this.surface.setBody({ name: bodyName, type: bodyType, gravity });
    // place avatar on landing pad center (procedural world)
    if (this.surface) {
      const pad = this.surface.pad || { x: 0, y: 0 };
      this.surface.avatar.x = pad.x; this.surface.avatar.y = pad.y;
      this.surface.avatar.px = pad.x; this.surface.avatar.py = pad.y;
      this.surface.avatar.path = [];
    }
    this.view = 'surface'; if (this._updateViewSwitch) this._updateViewSwitch(); this._sendPresence();
  }

  _currentBodyId() {
    const p = this.focusPlanet; if (!p) return 0;
    // Derive a stable id from chunk/indices if available; fallback: hash by name
    try { const s = p.star; if (s && Number.isFinite(s.index) && Number.isFinite(p.index)) return ((s.index & 0xffff) << 16) | (p.index & 0xffff); } catch {}
    try { let h = 2166136261>>>0; const str = String(p.name||''); for(let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h,16777619);} return h>>>0; } catch { return 0; }
  }

  _sendPresence() {
    if (!this.net) return;
    const scene = this.view === 'surface' ? 1 : (this.view === 'interior' ? 2 : 0);
    const body = scene === 1 ? this._currentBodyId() : 0;
    const ship = scene === 2 ? 1 : 0; // TODO: real ship id when available
    let tileX = 0, tileY = 0;
    if (scene === 1 && this.surface) { const t = this.surface.getAvatarTile(); tileX = t.x|0; tileY = t.y|0; }
    if (scene === 2 && this.interior) { const t = { x: this.interior.avatar.x|0, y: this.interior.avatar.y|0 }; tileX = t.x; tileY = t.y; }
    this.net.sendState(scene, body, tileX, tileY, ship);
  }

  _applySnapshot(list) {
    const now = performance.now();
    for (const it of list) {
      let e = this.remoteShips.get(it.idHash);
      if (!e) {
  e = { pos: new Vec2(it.x, it.y), last: now, name: it.name || '', hash: it.idHash >>> 0, dir: 0, scene: it.scene||0, body: it.body||0, tileX: it.tileX||0, tileY: it.tileY||0 };
        this.remoteShips.set(it.idHash, e);
      } else {
        const dx = it.x - e.pos.x; const dy = it.y - e.pos.y; const d2 = dx*dx + dy*dy;
        if (d2 > 1e-3) { e.dir = Math.atan2(dy, dx); }
  e.pos.x = it.x; e.pos.y = it.y; e.last = now; if (it.name) e.name = it.name; e.hash = it.idHash >>> 0; e.scene = it.scene||0; e.body = it.body||0; e.tileX = it.tileX||0; e.tileY = it.tileY||0;
      }
    }
    // Entferne veraltete Einträge
    for (const [k, v] of this.remoteShips) { if (now - v.last > 10000) this.remoteShips.delete(k); }
  }

  _syncRemoteShipsToScene() {
    if (!this._remoteRenderList) this._remoteRenderList = [];
    this._remoteRenderList.length = 0;
    for (const e of this.remoteShips.values()) {
      this._remoteRenderList.push({ pos: e.pos, target: e.pos, speed: 0, phase: 0, isPlayer: false, _remote: true, name: e.name||'', dir: e.dir, _hash: e.hash >>> 0 });
    }
    const locals = [this.playerShip, ...this.ships.filter(s => !s.isPlayer && !s._remote)];
    this.ships = [...locals, ...this._remoteRenderList];
  }

  // Chat/Presence Handling
  _onChat(evt) {
    const box = document.getElementById('chatBox'); if (!box) return;
    const line = document.createElement('div');
    line.textContent = evt.type === 'private' ? `(PM) ${evt.name||evt.from}: ${evt.text}` : `${evt.name||evt.from}: ${evt.text}`;
    box.appendChild(line); box.scrollTop = box.scrollHeight;
  }

  _appendChatSystem(text) {
    const box = document.getElementById('chatBox'); if (!box) return;
    const line = document.createElement('div');
    line.textContent = `[system] ${text}`;
    line.style.opacity = '0.8';
    box.appendChild(line); box.scrollTop = box.scrollHeight;
  }

  onDrag(dx, dy, e) {
    if (!this.focusPlanet) return false; if (this.camera.zoom < 4) return false;
    const v = dx * 0.01; this.focusPlanet.userSpin = (this.focusPlanet.userSpin || 0) + dx * 0.01; this.focusPlanet.userSpinVel = v; return true;
  }

  onKeyDown(e) {
    if (this.focusPlanet) {
      if (e.key === '+' || e.key === '=') this.camera.zoom = Math.min(this.camera.maxZoom, this.camera.zoom * 1.1);
      if (e.key === '-' || e.key === '_') this.camera.zoom = Math.max(this.camera.minZoom, this.camera.zoom / 1.1);
    }
  }


  onDragEnd(e) { if (!this.focusPlanet) return; /* Trägheit läuft über userSpinVel weiter */ }
}
