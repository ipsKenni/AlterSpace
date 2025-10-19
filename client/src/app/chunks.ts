// Chunk-Generierung und -Verwaltung
//
// Best Practices:
// - Deterministische Generierung basierend auf Seed und Chunk-Koordinaten
// - Keine Render- oder DOM-Abhängigkeiten

import { Vec2 } from '../core/math.ts';
import { PRNG } from '../core/prng.ts';
import { WORLD, chunkKey } from './constants.ts';
import { Planet, PlanetType, Star } from './model.ts';

export class Chunk {
  readonly ix: number;
  readonly iy: number;
  readonly stars: Star[] = [];
  readonly planets: Planet[] = [];

  constructor(ix: number, iy: number) {
    this.ix = ix;
    this.iy = iy;
  }
}

type StarTypeDefinition = {
  code: string;
  w: number;
  color: string;
  lum: number;
  radius: number;
};

export interface GenerationSettings {
  seed: string;
  starDensity: number;
  planetDensity: number;
}

export class ChunkManager {
  private readonly seed: string;
  private readonly chunks = new Map<string, Chunk>();

  constructor(seed: string) {
    this.seed = seed;
  }

  private rngFor(ix: number, iy: number): PRNG {
    return new PRNG(`${this.seed}-c${ix}:${iy}`);
  }

  peek(ix: number, iy: number): Chunk | null {
    const key = chunkKey(ix, iy);
    return this.chunks.get(key) ?? null;
  }

  private nearbyStars(ix: number, iy: number, range = 1): Star[] {
    const result: Star[] = [];
    for (let dy = -range; dy <= range; dy += 1) {
      for (let dx = -range; dx <= range; dx += 1) {
        const k = chunkKey(ix + dx, iy + dy);
        const chunk = this.chunks.get(k);
        if (!chunk) {
          continue;
        }
        for (const star of chunk.stars) {
          result.push(star);
        }
      }
    }
    return result;
  }

  private generateChunk(ix: number, iy: number, settings: GenerationSettings): Chunk {
    const chunk = new Chunk(ix, iy);
    const rng = this.rngFor(ix, iy);

    const AU_WU = 200;
    const STAR_TYPES: StarTypeDefinition[] = [
      { code: 'O', w: 0.0003, color: '#9bbcff', lum: 50_000, radius: 8 },
      { code: 'B', w: 0.001, color: '#a7c4ff', lum: 2_000, radius: 5 },
      { code: 'A', w: 0.006, color: '#cfd9ff', lum: 80, radius: 2.1 },
      { code: 'F', w: 0.03, color: '#f8f7ff', lum: 6, radius: 1.3 },
      { code: 'G', w: 0.076, color: '#fff4d6', lum: 1.0, radius: 1.0 },
      { code: 'K', w: 0.12, color: '#ffd7a1', lum: 0.4, radius: 0.8 },
      { code: 'M', w: 0.7667, color: '#ffb07a', lum: 0.08, radius: 0.5 },
    ];

    const pickStarType = (random: PRNG): StarTypeDefinition => {
      const totalWeight = STAR_TYPES.reduce((sum, def) => sum + def.w, 0);
      let accumulator = random.next() * totalWeight;
      for (const definition of STAR_TYPES) {
        accumulator -= definition.w;
        if (accumulator <= 0) {
          return definition;
        }
      }
      const fallback = STAR_TYPES[STAR_TYPES.length - 1];
      if (!fallback) {
        throw new Error('Star type configuration missing');
      }
      return fallback;
    };

    const baseStars = WORLD.STAR_BASE_PER_CHUNK * settings.starDensity;
    const starCount = Math.floor(rng.float(0.8, 1.2) * baseStars);

    for (let starIndex = 0; starIndex < starCount; starIndex += 1) {
      const definition = pickStarType(rng);
      const size = 8 + Math.min(60, Math.sqrt(definition.lum) * 1.6) + rng.float(0, 6);
      const color = definition.color;

      const systemSeed = `${this.seed}-sys-${ix},${iy}-${starIndex}`;
      let systemExtent = 0;
      {
        const previewRng = new PRNG(systemSeed);
        const preBaseMean = definition.code === 'M'
          ? 4
          : definition.code === 'K'
            ? 5
            : definition.code === 'G'
              ? 5
              : definition.code === 'F'
                ? 4
                : definition.code === 'A'
                  ? 3
                  : definition.code === 'B' || definition.code === 'O'
                    ? 2
                    : 4;
        const preMean = preBaseMean * settings.planetDensity;
        const preNPlanets = Math.max(0, Math.min(12, Math.round(preMean + previewRng.float(-0.8, 0.8) * Math.sqrt(preMean + 1))));
        const preRatio = previewRng.float(1.5, 1.9);
        const preSnowLineAU = 2.7 * Math.sqrt(definition.lum);
        const preSnowLineWU = preSnowLineAU * AU_WU;
        const PRE_SAFETY_PLANETS = 120;
        let a0 = Math.max(50, size * 20 + previewRng.float(20, 60));
        let prevOrbit = 0;
        let prevRadius = 0;
        let lastOrbit = 0;
        let lastRadius = 0;
        for (let p = 0; p < preNPlanets; p += 1) {
          let orbit = a0 * preRatio ** p * previewRng.float(0.95, 1.05);
          if (p > 0) {
            const required = prevOrbit + prevRadius + lastRadius + PRE_SAFETY_PLANETS;
            if (orbit < required) {
              orbit = required;
            }
          }
          const Teq = 278 * Math.pow(definition.lum, 0.25) / Math.sqrt(Math.max(0.05, (orbit / AU_WU)));
          let pr;
          if (orbit < preSnowLineWU * 0.8) {
            pr = Teq > 230 && Teq < 330 && previewRng.bool(0.5) ? previewRng.float(12, 22) : previewRng.float(8, 20);
          } else if (previewRng.bool(0.45 + 0.15 * Math.tanh(orbit / AU_WU - preSnowLineAU))) {
            pr = previewRng.float(32, 72);
          } else {
            pr = previewRng.bool(0.6) ? previewRng.float(10, 22) : previewRng.float(10, 18);
          }
          if (p > 0) {
            const required = prevOrbit + prevRadius + pr + PRE_SAFETY_PLANETS;
            if (orbit < required) {
              orbit = required;
            }
          }
          prevOrbit = orbit;
          prevRadius = pr;
          lastOrbit = orbit;
          lastRadius = pr;
        }
        systemExtent = lastOrbit + lastRadius + 400;
      }

      const typeIsolation = definition.code === 'O'
        ? 3.0
        : definition.code === 'B'
          ? 2.5
          : definition.code === 'A'
            ? 2.0
            : definition.code === 'F'
              ? 1.6
              : definition.code === 'G'
                ? 1.4
                : definition.code === 'K'
                  ? 1.2
                  : 1.0;
      const density = Math.max(0.2, settings.starDensity);
      const baseSpacing = WORLD.CHUNK * 1.8 / Math.sqrt(density);
      const starSpacing = baseSpacing * typeIsolation * rng.float(0.9, 1.3);

      let attempts = 18;
      let starX = 0;
      let starY = 0;
      let placed = false;
      while (attempts-- > 0 && !placed) {
        starX = (ix + rng.next()) * WORLD.CHUNK;
        starY = (iy + rng.next()) * WORLD.CHUNK;
        const neighborRange = Math.max(1, Math.ceil((systemExtent + starSpacing) / WORLD.CHUNK) + 1);
        const nearby = this.nearbyStars(ix, iy, neighborRange);
        const conflicts = nearby.some((other) => {
          const otherExtent = other.systemExtent || WORLD.CHUNK * 0.4;
          const otherBuffer = other.starSpacing || 0;
          return Math.hypot(starX - other.pos.x, starY - other.pos.y) < systemExtent + otherExtent + starSpacing + otherBuffer;
        }) || chunk.stars.some((other) => {
          const otherExtent = other.systemExtent || WORLD.CHUNK * 0.4;
          const otherBuffer = other.starSpacing || 0;
          return Math.hypot(starX - other.pos.x, starY - other.pos.y) < systemExtent + otherExtent + starSpacing + otherBuffer;
        });
        if (!conflicts) {
          placed = true;
        }
      }
      if (!placed) {
        continue;
      }

      const star = new Star(new Vec2(starX, starY), size, color);
      star.type = definition.code;
      star.lum = definition.lum;
      star.radiusSolar = definition.radius;
      star.systemExtent = systemExtent;
      star.starSpacing = starSpacing;
      star.ix = ix;
      star.iy = iy;
      star.index = starIndex;
      star.id = `s:${ix},${iy}:${starIndex}`;
      chunk.stars.push(star);

      const sysRng = new PRNG(systemSeed);
      const baseMean = definition.code === 'M'
        ? 4
        : definition.code === 'K'
          ? 5
          : definition.code === 'G'
            ? 5
            : definition.code === 'F'
              ? 4
              : definition.code === 'A'
                ? 3
                : definition.code === 'B' || definition.code === 'O'
                  ? 2
                  : 4;
      const mean = baseMean * settings.planetDensity;
      const nPlanets = Math.max(0, Math.min(12, Math.round(mean + sysRng.float(-0.8, 0.8) * Math.sqrt(mean + 1))));
      const snowLineAU = 2.7 * Math.sqrt(definition.lum);
      const snowLineWU = snowLineAU * AU_WU;
      let a0 = Math.max(50, star.size * 20 + sysRng.float(20, 60));
      const ratio = sysRng.float(1.5, 1.9);
      let prevOrbit = 0;
      let prevRadius = 0;
      const SAFETY_PLANETS = 120;
      let systemFurthest = 0;

      for (let planetIndex = 0; planetIndex < nPlanets; planetIndex += 1) {
        let orbit = a0 * ratio ** planetIndex * sysRng.float(0.95, 1.05);
        let aAU = orbit / AU_WU;
        let Teq = 278 * Math.pow(definition.lum, 0.25) / Math.sqrt(Math.max(0.05, aAU));
        let planetType: PlanetType;
        let radius: number;
        if (orbit < snowLineWU * 0.8) {
          if (Teq > 230 && Teq < 330 && sysRng.bool(0.5)) {
            planetType = 'Ozeanplanet';
            radius = sysRng.float(12, 22);
          } else {
            planetType = 'Gesteinsplanet';
            radius = sysRng.float(8, 20);
          }
        } else if (sysRng.bool(0.45 + 0.15 * Math.tanh(aAU - snowLineAU))) {
          planetType = 'Gasriese';
          radius = sysRng.float(32, 72);
        } else {
          planetType = sysRng.bool(0.6) ? 'Eisplanet' : 'Gesteinsplanet';
          radius = planetType === 'Eisplanet' ? sysRng.float(10, 22) : sysRng.float(10, 18);
        }
        if (planetIndex > 0) {
          const required = prevOrbit + prevRadius + radius + SAFETY_PLANETS;
          if (orbit < required) {
            orbit = required;
          }
          aAU = orbit / AU_WU;
          Teq = 278 * Math.pow(definition.lum, 0.25) / Math.sqrt(Math.max(0.05, aAU));
        }

        const planet = new Planet(star.pos.clone(), radius, `${ix},${iy}:${starIndex}:${planetIndex}`);
        planet.star = star;
        planet.starIx = ix;
        planet.starIy = iy;
        planet.starIndex = starIndex;
        planet.index = planetIndex;
        planet.id = `p:${ix},${iy}:${starIndex}:${planetIndex}`;
        planet.type = planetType;
        if (planetType === 'Gasriese') {
          planet.mass = sysRng.float(60, 300);
          planet.gravity = sysRng.float(10, 35);
          planet.hasRings = sysRng.bool(0.35);
          planet.atmosphere = 'H/He, Spuren CH4';
          planet.dayLength = sysRng.float(8, 20);
        } else if (planetType === 'Eisplanet') {
          planet.mass = sysRng.float(0.2, 5);
          planet.gravity = sysRng.float(2, 12);
          planet.hasRings = sysRng.bool(0.1);
          planet.atmosphere = sysRng.bool(0.6) ? 'Dünn (N2/CO2)' : 'Keine';
          planet.dayLength = sysRng.float(10, 60);
        } else if (planetType === 'Ozeanplanet') {
          planet.mass = sysRng.float(0.5, 8);
          planet.gravity = sysRng.float(5, 14);
          planet.hasRings = sysRng.bool(0.05);
          planet.atmosphere = 'N2/O2, hohe Feuchte';
          planet.dayLength = sysRng.float(14, 40);
        } else {
          planet.mass = sysRng.float(0.3, 9);
          planet.gravity = sysRng.float(4, 18);
          planet.hasRings = sysRng.bool(0.02);
          planet.atmosphere = sysRng.bool(0.8) ? 'N2/O2' : 'Dünn (CO2)';
          planet.dayLength = sysRng.float(12, 48);
        }
        planet.temperature = Teq + sysRng.float(-15, 15);
        planet.axialTilt = sysRng.float(0, 35);

        planet.orbitCenter = star.pos;
        planet.orbitRadius = orbit;
        planet.orbitAngle = sysRng.float(0, Math.PI * 2);
        planet.orbitSpeed = (120 / Math.pow(orbit + 80, 1.25)) * (sysRng.bool() ? 1 : -1);

        const moonBias = planetType === 'Gasriese' ? 4 : planetType === 'Eisplanet' ? 2 : 1;
        const moonCount = Math.max(0, Math.min(6, sysRng.int(0, moonBias + 2)));
        let prevDist = planet.radius * 1.6;
        let prevMoonRadius = 0;
        const SAFETY_MOONS = Math.max(10, Math.round(planet.radius * 0.08));
        const maxMoonDist = planet.radius * (planetType === 'Gasriese' ? 12 : 6);
        for (let moonIndex = 0; moonIndex < moonCount; moonIndex += 1) {
          const moonRadius = planet.radius * sysRng.float(0.16, 0.35);
          const base = planet.radius * sysRng.float(1.8, 3.8) + moonIndex * planet.radius * 0.5;
          let dist = Math.max(base, prevDist + prevMoonRadius + moonRadius + SAFETY_MOONS);
          if (dist + moonRadius > maxMoonDist) {
            break;
          }
          prevDist = dist;
          prevMoonRadius = moonRadius;
          const ang = sysRng.float(0, Math.PI * 2);
          planet.moons.push({
            r: moonRadius,
            dist,
            ang,
            speed: sysRng.float(0.08, 0.35) * (sysRng.bool() ? 1 : -1),
            index: moonIndex,
            id: `m:${ix},${iy}:${starIndex}:${planetIndex}:${moonIndex}`,
          });
        }

        star.planets.push(planet);
        chunk.planets.push(planet);
        systemFurthest = Math.max(systemFurthest, orbit + planet.radius);
        prevOrbit = orbit;
        prevRadius = planet.radius;
      }

      star.systemExtent = Math.max(star.systemExtent, systemFurthest + 400);
    }

    return chunk;
  }

  getChunk(ix: number, iy: number, settings: GenerationSettings): Chunk {
    const key = chunkKey(ix, iy);
    if (!this.chunks.has(key)) {
      this.chunks.set(key, this.generateChunk(ix, iy, settings));
    }
    const chunk = this.chunks.get(key);
    if (!chunk) {
      throw new Error('Chunk generation failed');
    }
    return chunk;
  }
}
