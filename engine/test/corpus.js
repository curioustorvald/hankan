// Helpers for tests that use the regression corpus (provenance/Corpus).
// The corpus is not distributed; tests that need it skip when it is absent.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CORPUS = fileURLToPath(new URL('../../provenance/Corpus/', import.meta.url));

export function corpusFiles(kind, { limit = Infinity, stride = 1 } = {}) {
  const dir = CORPUS + kind + '/';
  if (!existsSync(dir)) return [];
  // The corpus folders also hold the reference renders (JPEG).
  const all = readdirSync(dir).filter((f) => /\.hwpx?$/i.test(f)).sort();
  const out = [];
  for (let i = 0; i < all.length && out.length < limit; i += stride) out.push(dir + all[i]);
  return out;
}

export function load(path) {
  return new Uint8Array(readFileSync(path));
}
