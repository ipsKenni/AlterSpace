// Chunk-Generierung und -Verwaltung
//
// Best Practices:
// - Deterministische Generierung basierend auf Seed und Chunk-Koordinaten
// - Keine Render- oder DOM-Abhängigkeiten

import { Vec2 } from '../core/math.js';
import { PRNG } from '../core/prng.js';
import { WORLD, chunkKey } from './constants.js';
import { Star, Planet } from './model.js';

export class Chunk { constructor(ix, iy) { this.ix = ix; this.iy = iy; this.stars = []; this.planets = []; } }

export class ChunkManager {
  constructor(seed) {
    this.seed = seed;
    this.chunks = new Map();
  }
  _rngFor(ix, iy) { return new PRNG(`${this.seed}-c${ix}:${iy}`); }
  peek(ix, iy) { const key = chunkKey(ix, iy); return this.chunks.has(key) ? this.chunks.get(key) : null; }
  _nearbyStars(ix, iy, range = 1) {
    const out = [];
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        const k = chunkKey(ix + dx, iy + dy);
        const ch = this.chunks.get(k);
        if (ch) { for (const s of ch.stars) out.push(s); }
      }
    }
    return out;
  }
  _generateChunk(ix, iy, settings) {
    const ch = new Chunk(ix, iy);
    const rng = this._rngFor(ix, iy);

    // 1 AE in Welt-Einheiten (angepasst für größere Sternabstände)
    const AU_WU = 200;

    // Spektralverteilung der Sterne (vereinfachte Gewichte)
    const STAR_TYPES = [
      { code: 'O', w: 0.0003, color: '#9bbcff', lum: 50000, radius: 8 },
      { code: 'B', w: 0.001, color: '#a7c4ff', lum: 2000, radius: 5 },
      { code: 'A', w: 0.006, color: '#cfd9ff', lum: 80, radius: 2.1 },
      { code: 'F', w: 0.03, color: '#f8f7ff', lum: 6, radius: 1.3 },
      { code: 'G', w: 0.076, color: '#fff4d6', lum: 1.0, radius: 1.0 },
      { code: 'K', w: 0.12, color: '#ffd7a1', lum: 0.4, radius: 0.8 },
      { code: 'M', w: 0.7667, color: '#ffb07a', lum: 0.08, radius: 0.5 },
    ];
    function pickStarType(r) {
      let sum = STAR_TYPES.reduce((a, b) => a + b.w, 0);
      let t = r.next() * sum;
      for (const st of STAR_TYPES) { if ((t -= st.w) <= 0) return st; }
      return STAR_TYPES[STAR_TYPES.length - 1];
    }

    // Anzahl der Sterne pro Chunk (skaliert über Einstellung)
    const bs = WORLD.STAR_BASE_PER_CHUNK * settings.starDensity;
    const nStars = Math.floor(rng.float(0.8, 1.2) * bs);

    for (let i = 0; i < nStars; i++) {
      // Spektraltyp und visuelle Größe bestimmen
      const st = pickStarType(rng);
      const size = 8 + Math.min(60, Math.sqrt(st.lum) * 1.6) + rng.float(0, 6);
      const color = st.color;

      // System-Ausdehnung vorab schätzen (konsistent zum späteren Generator)
      const sysSeed = `${this.seed}-sys-${ix},${iy}-${i}`;
      let systemExtent = 0;
      {
        const previewRng = new PRNG(sysSeed);
        const preBaseMean = (st.code === 'M') ? 4 : (st.code === 'K') ? 5 : (st.code === 'G') ? 5 : (st.code === 'F') ? 4 : (st.code === 'A') ? 3 : (st.code === 'B' || st.code === 'O') ? 2 : 4;
        const preMean = preBaseMean * settings.planetDensity;
        const preNPlanets = Math.max(0, Math.min(12, Math.round(preMean + (previewRng.float(-0.8, 0.8)) * Math.sqrt(preMean + 1))));
        const preRatio = previewRng.float(1.5, 1.9);
        const preSnowLineAU = 2.7 * Math.sqrt(st.lum);
        const preSnowLineWU = preSnowLineAU * AU_WU;
        const PRE_SAFETY_PLANETS = 120;
        let a0 = Math.max(50, (size * 20) + previewRng.float(20, 60));
        let prevOrbit = 0, prevRadius = 0, lastOrbit = 0, lastRadius = 0;
        for (let p = 0; p < preNPlanets; p++) {
          let orbit = a0 * Math.pow(preRatio, p) * previewRng.float(0.95, 1.05);
          if (p > 0) {
            const required = (prevOrbit + prevRadius) + lastRadius + PRE_SAFETY_PLANETS;
            if (orbit < required) orbit = required;
          }
          const aAU = orbit / AU_WU;
          const Teq = 278 * Math.pow(st.lum, 0.25) / Math.sqrt(Math.max(0.05, aAU));
          let pr;
          if (orbit < preSnowLineWU * 0.8) {
            if (Teq > 230 && Teq < 330 && previewRng.bool(0.5)) pr = previewRng.float(12, 22);
            else pr = previewRng.float(8, 20);
          } else {
            if (previewRng.bool(0.45 + 0.15 * Math.tanh((aAU - preSnowLineAU)))) pr = previewRng.float(32, 72);
            else pr = previewRng.bool(0.6) ? previewRng.float(10, 22) : previewRng.float(10, 18);
          }
          if (p > 0) {
            const required = (prevOrbit + prevRadius) + pr + PRE_SAFETY_PLANETS;
            if (orbit < required) orbit = required;
          }
          prevOrbit = orbit; prevRadius = pr; lastOrbit = orbit; lastRadius = pr;
        }
        systemExtent = lastOrbit + lastRadius + 400;
      }

      // Typ-basierte Isolierung + Dichtefaktor → Mindestabstand
      const typeIso = (st.code === 'O') ? 3.0 : (st.code === 'B') ? 2.5 : (st.code === 'A') ? 2.0 : (st.code === 'F') ? 1.6 : (st.code === 'G') ? 1.4 : (st.code === 'K') ? 1.2 : 1.0;
      const dens = Math.max(0.2, settings.starDensity);
      const baseSpacing = WORLD.CHUNK * 1.8 / Math.sqrt(dens);
      const starSpacing = baseSpacing * typeIso * rng.float(0.9, 1.3);

      // Poisson-artige Platzierung: Systemausdehnung + Puffer berücksichtigen
      let attempts = 18, x, y, placed = false;
      do {
        x = (ix + rng.next()) * WORLD.CHUNK;
        y = (iy + rng.next()) * WORLD.CHUNK;
        const neighborRange = Math.max(1, Math.ceil((systemExtent + starSpacing) / WORLD.CHUNK) + 1);
        const nearby = this._nearbyStars(ix, iy, neighborRange);
        let ok = true;
        for (const s of nearby) {
          const sExt = (s.systemExtent || WORLD.CHUNK * 0.4);
          const sBuf = (s.starSpacing || 0);
          if (Math.hypot(x - s.pos.x, y - s.pos.y) < (systemExtent + sExt + starSpacing + sBuf)) { ok = false; break; }
        }
        if (ok && ch.stars && ch.stars.length) {
          for (const s2 of ch.stars) {
            const sExt = (s2.systemExtent || WORLD.CHUNK * 0.4);
            const sBuf = (s2.starSpacing || 0);
            if (Math.hypot(x - s2.pos.x, y - s2.pos.y) < (systemExtent + sExt + starSpacing + sBuf)) { ok = false; break; }
          }
        }
        if (ok) { placed = true; break; }
      } while ((attempts--) > 0);
      if (!placed) continue;

      const star = new Star(new Vec2(x, y), size, color);
      star.type = st.code; star.lum = st.lum; star.radiusSolar = st.radius; star.systemExtent = systemExtent; star.starSpacing = starSpacing;
      star.ix = ix; star.iy = iy; star.index = i; star.id = `s:${ix},${iy}:${i}`;
      ch.stars.push(star);

      // Planetensystem pro Stern
      const sysRng = new PRNG(`${this.seed}-sys-${ix},${iy}-${i}`);
      const baseMean = (st.code === 'M') ? 4 : (st.code === 'K') ? 5 : (st.code === 'G') ? 5 : (st.code === 'F') ? 4 : (st.code === 'A') ? 3 : (st.code === 'B' || st.code === 'O') ? 2 : 4;
      const mean = baseMean * settings.planetDensity;
      const nPlanets = Math.max(0, Math.min(12, Math.round(mean + (sysRng.float(-0.8, 0.8)) * Math.sqrt(mean + 1))));
      const hzCenterAU = Math.sqrt(st.lum);
      const snowLineAU = 2.7 * Math.sqrt(st.lum);
      const snowLineWU = snowLineAU * AU_WU;
      let a0 = Math.max(50, (star.size * 20) + sysRng.float(20, 60));
      const ratio = sysRng.float(1.5, 1.9);
      let prevOrbit = 0, prevRadius = 0;
      const SAFETY_PLANETS = 120;
      let systemFurthest = 0;

      for (let p = 0; p < nPlanets; p++) {
        let orbit = a0 * Math.pow(ratio, p) * sysRng.float(0.95, 1.05);
        let aAU = orbit / AU_WU;
        let Teq = 278 * Math.pow(st.lum, 0.25) / Math.sqrt(Math.max(0.05, aAU));
        let pType, pr;
        if (orbit < snowLineWU * 0.8) {
          if (Teq > 230 && Teq < 330 && sysRng.bool(0.5)) { pType = 'Ozeanplanet'; pr = sysRng.float(12, 22); }
          else { pType = 'Gesteinsplanet'; pr = sysRng.float(8, 20); }
        } else {
          if (sysRng.bool(0.45 + 0.15 * Math.tanh((aAU - snowLineAU)))) { pType = 'Gasriese'; pr = sysRng.float(32, 72); }
          else { pType = sysRng.bool(0.6) ? 'Eisplanet' : 'Gesteinsplanet'; pr = (pType === 'Eisplanet') ? sysRng.float(10, 22) : sysRng.float(10, 18); }
        }
        const planet = new Planet(star.pos.clone(), pr, `${ix},${iy}:${i}:${p}`);
        planet.star = star; // Rückverweis für UI/Hierarchie
        if (p > 0) {
          const required = (prevOrbit + prevRadius) + pr + SAFETY_PLANETS;
          if (orbit < required) orbit = required;
          aAU = orbit / AU_WU;
          Teq = 278 * Math.pow(st.lum, 0.25) / Math.sqrt(Math.max(0.05, aAU));
        }
        planet.starIx = ix; planet.starIy = iy; planet.starIndex = i; planet.index = p; planet.id = `p:${ix},${iy}:${i}:${p}`;
        planet.type = pType;
        if (pType === 'Gasriese') { planet.mass = sysRng.float(60, 300); planet.gravity = sysRng.float(10, 35); planet.hasRings = sysRng.bool(0.35); planet.atmosphere = 'H/He, Spuren CH4'; planet.dayLength = sysRng.float(8, 20); }
        else if (pType === 'Eisplanet') { planet.mass = sysRng.float(0.2, 5); planet.gravity = sysRng.float(2, 12); planet.hasRings = sysRng.bool(0.1); planet.atmosphere = sysRng.bool(0.6) ? 'Dünn (N2/CO2)' : 'Keine'; planet.dayLength = sysRng.float(10, 60); }
        else if (pType === 'Ozeanplanet') { planet.mass = sysRng.float(0.5, 8); planet.gravity = sysRng.float(5, 14); planet.hasRings = sysRng.bool(0.05); planet.atmosphere = 'N2/O2, hohe Feuchte'; planet.dayLength = sysRng.float(14, 40); }
        else { planet.mass = sysRng.float(0.3, 9); planet.gravity = sysRng.float(4, 18); planet.hasRings = sysRng.bool(0.02); planet.atmosphere = sysRng.bool(0.8) ? 'N2/O2' : 'Dünn (CO2)'; planet.dayLength = sysRng.float(12, 48); }
        planet.temperature = Teq + sysRng.float(-15, 15);
        planet.axialTilt = sysRng.float(0, 35);

        // Monde mit striktem Nicht-Überlappen und äußeren Kappungsradius
        planet.moons = [];
        const moonBias = (pType === 'Gasriese') ? 4 : (pType === 'Eisplanet') ? 2 : 1;
        const moonCount = Math.max(0, Math.min(6, sysRng.int(0, moonBias + 2)));
        let prevDist = planet.radius * 1.6;
        let prevMoonR = 0;
        const SAFETY_MOONS = Math.max(10, Math.round(planet.radius * 0.08));
        const maxMoonDist = planet.radius * ((pType === 'Gasriese') ? 12 : 6);
        for (let m = 0; m < moonCount; m++) {
          const mr = planet.radius * sysRng.float(0.16, 0.35);
          const base = planet.radius * sysRng.float(1.8, 3.8) + m * planet.radius * 0.5;
          let dist = Math.max(base, prevDist + prevMoonR + mr + SAFETY_MOONS);
          if (dist + mr > maxMoonDist) break;
          prevDist = dist; prevMoonR = mr;
          const ang = sysRng.float(0, Math.PI * 2);
          planet.moons.push({ r: mr, dist, ang, speed: sysRng.float(0.08, 0.35) * (sysRng.bool() ? 1 : -1), index: m, id: `m:${ix},${iy}:${i}:${p}:${m}` });
        }

        planet.orbitCenter = star.pos; planet.orbitRadius = orbit; planet.orbitAngle = sysRng.float(0, Math.PI * 2);
        planet.orbitSpeed = (120 / Math.pow(orbit + 80, 1.25)) * (sysRng.bool() ? 1 : -1);
        star.planets.push(planet); ch.planets.push(planet);
        systemFurthest = Math.max(systemFurthest, orbit + planet.radius);
        prevOrbit = orbit; prevRadius = planet.radius;
      }

      star.systemExtent = Math.max(star.systemExtent || 0, systemFurthest + 400);
    }

    return ch;
  }
  getChunk(ix, iy, settings) { const key = chunkKey(ix, iy); if (!this.chunks.has(key)) this.chunks.set(key, this._generateChunk(ix, iy, settings)); return this.chunks.get(key); }
}
