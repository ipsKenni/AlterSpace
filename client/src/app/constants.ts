// Globale Konstanten und Hilfsfunktionen für Welt-Chunking
//
// Best Practices:
// - Single Source of Truth für Weltmaße

export const WORLD = {
  CHUNK: 12_000,
  STAR_BASE_PER_CHUNK: 4,
  PLANET_BASE_PER_CHUNK: 10,
} as const;

export type ChunkCoordinates = {
  ix: number;
  iy: number;
};

export function chunkKey(ix: number, iy: number): string {
  return `${ix},${iy}`;
}

export function worldToChunk(x: number): number {
  return Math.floor(x / WORLD.CHUNK);
}
