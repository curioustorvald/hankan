#!/usr/bin/env node
// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Build the webapp into webpage-worker/public: the page (webpage-worker/src)
// and the engine (engine/src, as webpage-worker/public/engine) are copied
// as they are, with no bundling or minifying, so what is served is the
// source. The service worker gets the list of files to cache and a version
// made from their contents.

import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'webpage-worker/src');
const OUT = join(ROOT, 'webpage-worker/public');
// Cloudflare Pages reads these itself; they are not part of the page.
const NOT_CACHED = new Set(['_headers', 'sw.js']);

function files(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

export function build() {
  rmSync(OUT, { recursive: true, force: true });
  cpSync(SRC, OUT, { recursive: true });
  cpSync(join(ROOT, 'engine/src'), join(OUT, 'engine'), { recursive: true });

  const cached = files(OUT).map((p) => relative(OUT, p).split(sep).join('/')).filter((p) => !NOT_CACHED.has(p));
  const hash = createHash('sha256');
  for (const p of cached) hash.update(p).update('\0').update(readFileSync(join(OUT, p)));
  const version = hash.digest('hex').slice(0, 12);

  const sw = join(OUT, 'sw.js');
  const text = readFileSync(sw, 'utf8');
  const stamped = text
    .replace("const VERSION = 'dev';", `const VERSION = '${version}';`)
    .replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(['./', ...cached], null, 2)};`);
  if (stamped === text) throw new Error('sw.js: VERSION/PRECACHE placeholders not found');
  writeFileSync(sw, stamped);
  return { out: OUT, version, files: cached.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { out, version, files: n } = build();
  console.log(`built ${relative(ROOT, out)}: ${n} files, version ${version}`);
}
