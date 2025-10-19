// Globale Konstanten und Hilfsfunktionen für Welt-Chunking
//
// Best Practices:
// - Single Source of Truth für Weltmaße

export const WORLD = {
  CHUNK: 12000,
  STAR_BASE_PER_CHUNK: 4,
  PLANET_BASE_PER_CHUNK: 10,
};

export function chunkKey(ix, iy) { return ix + "," + iy; }
export function worldToChunk(x) { return Math.floor(x / WORLD.CHUNK); }
