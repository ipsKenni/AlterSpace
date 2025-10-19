// Namensgenerator für Planeten
//
// Best Practices:
// - Keine Seiteneffekte; deterministisch basierend auf Seed

import { PRNG } from './prng.js';

export class PlanetNameGen {
  static generate(seedStr) {
    const rng = new PRNG('name-' + seedStr);
    const prefixes = ['Al','Be','Ca','De','El','Fa','Ga','Hy','Io','Ka','Lu','Ma','Ne','Or','Pa','Qua','Ra','Si','Ta','Ul','Va','Xi','Ya','Ze'];
    const middles = ['ri','lo','na','ve','mi','ra','to','ka','za','qu','ph','the','shi','dra','chi'];
    const suffixes = ['on','is','os','ea','um','ar','e','es',' Prime',' Minor',' Major'];
    const num = rng.bool(0.6) ? '-' + rng.int(1, 999) : '';
    return (rng.pick(prefixes) + (rng.bool(0.7) ? rng.pick(middles) : '') + rng.pick(suffixes) + num)
      .replace(/\s+/g, ' ')
      .trim();
  }
}
