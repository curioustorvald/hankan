#!/usr/bin/env node
// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Serve the built webapp (webpage-worker/public) for local testing, with
// the same headers as webpage-worker/src/_headers.
//
//   node tools/web/serve.js [--port 8080] [--mount /prefix=dir ...]
//
// --mount serves extra files (e.g. forms for ?demo=) under a prefix.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../webpage-worker/public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.hwp': 'application/x-hwp', '.hwpx': 'application/hwp+zip',
};
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
};

/** @param {{ port?: number, mounts?: Record<string, string> }} options */
export function serve({ port = 8080, mounts = {} } = {}) {
  const roots = [...Object.entries(mounts).map(([prefix, dir]) => [prefix.replace(/\/?$/, '/'), resolve(dir)]), ['/', ROOT]];
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    for (const [prefix, dir] of roots) {
      if (!path.startsWith(prefix)) continue;
      const file = normalize(join(dir, path.slice(prefix.length)));
      if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) break;
      res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, HEADERS).end('not found');
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  let port = 8080;
  const mounts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--mount') { const [p, d] = args[++i].split('='); mounts[p] = d; }
  }
  const server = await serve({ port, mounts });
  console.log(`serving webpage-worker/public at http://127.0.0.1:${server.address().port}/`);
}
