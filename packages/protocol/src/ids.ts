import type { Clock } from './clock';

/**
 * ULID-based ids (time-sortable). Time component comes from the provided Clock so ids stay
 * ordered under the eval time machine. Monotonic within the same millisecond.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomDigits(): number[] {
  const bytes = randomBytes(16);
  const digits: number[] = [];
  for (let i = 0; i < 16; i++) digits.push(bytes[i]! % 32);
  return digits;
}

function incrementDigits(d: number[]): number[] {
  const out = [...d];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 31) {
      out[i] = out[i]! + 1;
      return out;
    }
    out[i] = 0;
  }
  return randomDigits();
}

export function ulid(ms: number): string {
  let rand: number[];
  if (ms <= lastTime) {
    rand = incrementDigits(lastRandom);
    ms = lastTime;
  } else {
    rand = randomDigits();
    lastTime = ms;
  }
  lastRandom = rand;
  return encodeTime(ms) + rand.map((d) => ENCODING[d]).join('');
}

export type IdPrefix =
  | 'evt' // events (message ids are event ids)
  | 'ath' // athletes
  | 'turn'
  | 'tsk' // helper tasks
  | 'sch' // schedules
  | 'ep' // epochs
  | 'call'
  | 'ses' // sessions
  | 'job'
  | 'tool'
  | 'up'; // ui versions etc.

export function newId(prefix: IdPrefix, clock?: Clock): string {
  const ms = clock ? clock.now().getTime() : Date.now();
  return `${prefix}_${ulid(ms)}`;
}

/** Random url-safe token (sessions, capability URLs). */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** Human-friendly pairing code like "K7QM-3XPD" (no ambiguous chars). */
export function pairingCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[b[i]! % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
