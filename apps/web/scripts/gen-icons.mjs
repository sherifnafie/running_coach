// Generates the PWA icon PNGs (and icon.svg) into ../public without any dependencies.
// Run: node scripts/gen-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ACCENT = [0xe4, 0x57, 0x2e];
const WHITE = [255, 255, 255];

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Signed distance helpers in unit space (0..1). */
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

// The mark: a white speech bubble (the chat) with a running-track "O" cut out of it.
function shade(x, y, { maskable, rounded }) {
  const s = maskable ? 0.8 : 1; // maskable icons keep the mark inside the safe zone
  const u = (x - 0.5) / s + 0.5;
  const v = (y - 0.5) / s + 0.5;
  let bg = rounded ? sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) : -1;
  if (bg > 0) return [0, 0, 0, 0];
  const bubble = sdRoundRect(u, v, 0.5, 0.46, 0.28, 0.22, 0.12);
  const tail = (() => {
    // triangle under the bubble, left side
    const px = u, py = v;
    const a = [0.32, 0.66], b = [0.46, 0.66], c = [0.3, 0.8];
    const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    const p = [px, py];
    const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos) ? -1 : 1;
  })();
  const inBubble = bubble < 0 || tail < 0;
  const ring = Math.abs(Math.hypot(u - 0.5, v - 0.46) - 0.115) < 0.034;
  const col = inBubble && !ring ? WHITE : ACCENT;
  return [col[0], col[1], col[2], 255];
}

function render(size, opts) {
  const ss = 3;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, opts);
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const o = (py * size + px) * 4;
      if (a > 0) {
        buf[o] = Math.round(r / a); buf[o + 1] = Math.round(g / a); buf[o + 2] = Math.round(b / a);
        buf[o + 3] = Math.round(a / (ss * ss));
      }
    }
  }
  return png(size, size, buf);
}

writeFileSync(join(out, 'icon-192.png'), render(192, { maskable: false, rounded: true }));
writeFileSync(join(out, 'icon-512.png'), render(512, { maskable: false, rounded: true }));
writeFileSync(join(out, 'icon-maskable-512.png'), render(512, { maskable: true, rounded: false }));
writeFileSync(join(out, 'apple-touch-icon.png'), render(180, { maskable: true, rounded: false }));

writeFileSync(
  join(out, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#E4572E"/>
  <rect x="22" y="24" width="56" height="44" rx="12" fill="#fff"/>
  <path fill="#fff" d="M32 66h14L30 80z"/>
  <circle cx="50" cy="46" r="11.500" fill="none" stroke="#E4572E" stroke-width="6.800"/>
</svg>
`,
);
console.log('icons written to', out);
