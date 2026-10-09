// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// DEFLATE (RFC 1951). Decoding is synchronous (./inflate.js); encoding uses
// the platform's Compression Streams API, which browsers and Node.js
// (>= 21.2 for 'deflate-raw') provide. Generic.

import { inflate } from './inflate.js';

export { inflate };

/** Inflate raw DEFLATE data, ignoring anything after the end of the stream. */
export function inflateRaw(bytes, sizeHint) {
  return inflate(bytes, sizeHint).data;
}

/** Deflate to a raw DEFLATE stream (no zlib or gzip wrapper). */
export async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
