// Namensgenerator für Planeten
//
// Best Practices:
// - Keine Seiteneffekte; deterministisch basierend auf Seed

import { PRNG } from './prng.ts';

const PREFIXES = ['Al','Be','Ca','De','El','Fa','Ga','Hy','Io','Ka','Lu','Ma','Ne','Or','Pa','Qua','Ra','Si','Ta','Ul','Va','Xi','Ya','Ze'] as const;
const MIDDLES = ['ri','lo','na','ve','mi','ra','to','ka','za','qu','ph','the','shi','dra','chi'] as const;
const SUFFIXES = ['on','is','os','ea','um','ar','e','es',' Prime',' Minor',' Major'] as const;

export class PlanetNameGen {
  static generate(seedStr: string): string {
    const rng = new PRNG(`name-${seedStr}`);
    const num = rng.bool(0.6) ? `-${rng.int(1, 999)}` : '';
    const parts = [
      rng.pick(PREFIXES),
      rng.bool(0.7) ? rng.pick(MIDDLES) : '',
      rng.pick(SUFFIXES),
      num,
    ];
    return parts
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
