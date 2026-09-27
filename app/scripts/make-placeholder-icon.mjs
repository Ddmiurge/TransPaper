/**
 * 生成占位应用图标（纯色 PNG）。
 *
 * 为什么需要它：Tauri 的 codegen 在 bundle.icon 为空时会去找默认路径
 * `icons/icon.png` 等，文件不存在则构建直接失败 —— 所以骨架阶段必须先有图标文件，
 * 后续再换成正式设计稿。
 *
 * 用法：node scripts/make-placeholder-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../src-tauri/icons');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  // 必须是 RGBA（colortype 6）—— Tauri 的图标检查拒绝 truecolor RGB(2)，
  // 报错信息是 "is not RGBA"
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (1 + size * 4));
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p] = 0; // filter: none
    p += 1;
    for (let x = 0; x < size; x += 1) {
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
      raw[p + 3] = 255; // alpha
      p += 4;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
const color = [43, 76, 102]; // 与界面主色接近的深蓝灰
for (const [name, size] of [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
]) {
  writeFileSync(resolve(outDir, name), png(size, color));
}
console.log('占位图标已生成于 src-tauri/icons');
