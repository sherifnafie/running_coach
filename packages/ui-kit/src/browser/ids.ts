/** ULID-style ids (26 chars, time-ordered, Crockford base32) for rows a view inserts directly. */
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(nowMs: number, random: (n: number) => Uint8Array): string {
  let t = Math.max(0, Math.floor(nowMs));
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ENC.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ENC.charAt((bytes[i] ?? 0) & 31);
  return time + rand;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  try {
    crypto.getRandomValues(out);
  } catch {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}
