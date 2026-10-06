/**
 * Seeded randomness for deterministic simulations (Appendix E §E.2: "Deterministic with a seed").
 * Never use Math.random() in this package.
 */

/** xmur3 string hash → 32-bit seed. */
export function hashSeed(...parts: Array<string | number>): number {
  const str = parts.join('|');
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32-backed generator with convenience samplers. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box–Muller. */
  normal(mean = 0, sd = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Log-normal sample parameterised by its median and 90th percentile (used for reply latency:
   * "median 20 min, p90 3 h"). z(0.9) ≈ 1.2816.
   */
  lognormal(median: number, p90: number): number {
    const m = Math.max(median, 1e-6);
    const sigma = Math.max(Math.log(Math.max(p90, m * 1.0001) / m) / 1.2816, 1e-6);
    return Math.exp(Math.log(m) + sigma * this.normal());
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() from empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j] as T, a[i] as T];
    }
    return a;
  }
}

/** Independent stream per (seed, labels...). Day-indexed streams keep results order-independent. */
export function rngFor(seed: number, ...labels: Array<string | number>): Rng {
  return new Rng(hashSeed(seed, ...labels));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function round(x: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
