/**
 * Build the dashboard's favicons and login logo from shared/assets/logo.png.
 *
 *   pnpm icons
 *
 * Trims the transparent margins, centres the artwork in a square, and writes downscaled PNGs to
 * web/public. Uses only Node's zlib (no image libraries), so it handles the logo's format:
 * 8-bit RGBA, non-interlaced PNG.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SOURCE = resolve('shared/assets/logo.png');
const OUT_DIR = resolve('web/public');
const OUTPUTS: { file: string; size: number }[] = [
  { file: 'favicon-32.png', size: 32 },
  { file: 'favicon-48.png', size: 48 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'logo-256.png', size: 256 },
];

interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

function decodePng(buf: Buffer): Image {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const chunk = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      const [depth, colorType, , , interlace] = [chunk[8], chunk[9], chunk[10], chunk[11], chunk[12]];
      if (depth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(
          'Only 8-bit RGBA, non-interlaced PNGs are supported. Re-export the logo in that format.',
        );
      }
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const data = new Uint8Array(width * height * 4);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? data[dst + x - 4]! : 0;
      const up = y > 0 ? data[dst - stride + x]! : 0;
      const upLeft = y > 0 && x >= 4 ? data[dst - stride + x - 4]! : 0;
      const v = raw[src + x]!;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      if (predicted === undefined) throw new Error(`Unknown PNG filter ${filter}`);
      data[dst + x] = (v + predicted) & 0xff;
    }
  }
  return { width, height, data };
}

function encodePng(img: Image): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Bounding box of pixels that aren't (nearly) transparent. */
function contentBox(img: Image) {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > 8) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) throw new Error('The logo is fully transparent');
  return { minX, minY, maxX, maxY };
}

/** Centre the content in a transparent square with a little padding. */
function squareCrop(img: Image, paddingRatio = 0.04): Image {
  const b = contentBox(img);
  const w = b.maxX - b.minX + 1;
  const h = b.maxY - b.minY + 1;
  const side = Math.ceil(Math.max(w, h) * (1 + paddingRatio * 2));
  const offX = Math.floor((side - w) / 2) - b.minX;
  const offY = Math.floor((side - h) / 2) - b.minY;
  const data = new Uint8Array(side * side * 4);
  for (let y = b.minY; y <= b.maxY; y++) {
    for (let x = b.minX; x <= b.maxX; x++) {
      const s = (y * img.width + x) * 4;
      const d = ((y + offY) * side + (x + offX)) * 4;
      data.set(img.data.subarray(s, s + 4), d);
    }
  }
  return { width: side, height: side, data };
}

/** Area-average downscale with premultiplied alpha (no dark fringes around transparent edges). */
function resize(img: Image, size: number): Image {
  const out = new Uint8Array(size * size * 4);
  const scale = img.width / size;
  for (let ty = 0; ty < size; ty++) {
    const y0 = ty * scale;
    const y1 = y0 + scale;
    for (let tx = 0; tx < size; tx++) {
      const x0 = tx * scale;
      const x1 = x0 + scale;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const w = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * wy;
          const i = (sy * img.width + sx) * 4;
          const alpha = img.data[i + 3]! / 255;
          r += img.data[i]! * alpha * w;
          g += img.data[i + 1]! * alpha * w;
          b += img.data[i + 2]! * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }
      const o = (ty * size + tx) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / weight) * 255);
    }
  }
  return { width: size, height: size, data: out };
}

const square = squareCrop(decodePng(readFileSync(SOURCE)));
for (const { file, size } of OUTPUTS) {
  const png = encodePng(resize(square, size));
  writeFileSync(resolve(OUT_DIR, file), png);
  console.log(`${file.padEnd(22)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
