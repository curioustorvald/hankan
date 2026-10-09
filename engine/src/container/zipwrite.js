// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Writing a new ZIP archive (PKWARE APPNOTE.TXT), for handing many filled
// files over as one download. Generic. Names are stored as UTF-8 (flag bit
// 11); data is DEFLATE-compressed unless that does not make it smaller.

import { concat } from '../util/bytes.js';
import { crc32 } from '../util/crc32.js';
import { deflateRaw } from '../util/deflate.js';

/**
 * @param {Array<{ name: string, data: Uint8Array, date?: Date }>} files
 * @returns {Promise<Uint8Array>}
 */
export async function createZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const packed = await deflateRaw(f.data);
    const stored = packed.length >= f.data.length;
    const body = stored ? f.data : packed;
    const crc = crc32(f.data);
    const { time, date } = dosTime(f.date ?? new Date());
    const head = (sig, central) => {
      const h = new DataView(new ArrayBuffer(central ? 46 : 30));
      let p = 0;
      const u16 = (v) => { h.setUint16(p, v, true); p += 2; };
      const u32 = (v) => { h.setUint32(p, v >>> 0, true); p += 4; };
      u32(sig);
      if (central) u16(20); // version made by
      u16(20);              // version needed
      u16(0x0800);          // UTF-8 names
      u16(stored ? 0 : 8);
      u16(time); u16(date);
      u32(crc); u32(body.length); u32(f.data.length);
      u16(name.length); u16(0);
      if (central) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
      return new Uint8Array(h.buffer);
    };
    const local = concat([head(0x04034b50, false), name, body]);
    centrals.push(concat([head(0x02014b50, true), name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(centrals);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cd.length, true);
  end.setUint32(16, offset, true);
  return concat([...locals, cd, new Uint8Array(end.buffer)]);
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
