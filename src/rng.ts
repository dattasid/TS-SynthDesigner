/** A seedable random number source. Every Gen draws randomness through one of these, never `Math.random`. */
export interface Rng {
  /** Uniform unsigned 32-bit integer. */
  nextUint32(): number;
  /** Uniform float in [0, 1) with 53-bit resolution. */
  random(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /**
   * An independent stream derived from this stream's seed and `label`, not from its current state.
   * Forking the same label always gives the same stream, however many numbers the parent has drawn.
   */
  fork(label: string): Rng;
}

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;
// Larger than any UTF-16 code unit, so a key built as [...parentKey, SEPARATOR, ...labelCodeUnits] is unique per path.
const FORK_SEPARATOR = 0x10000;

/**
 * MT19937, a port of Matsumoto and Nishimura's mt19937ar.c.
 * A number seed uses `init_genrand`; an array seed (and every fork) uses `init_by_array`.
 */
export class MersenneTwister implements Rng {
  /** The seed key this stream was built from. Pass it back to the constructor to reproduce the stream. */
  readonly key: readonly number[];
  private readonly mt = new Uint32Array(N);
  private mti = N;

  constructor(seed: number | readonly number[]) {
    if (typeof seed === "number") {
      if (!Number.isInteger(seed)) throw new RangeError(`Seed must be an integer, got ${seed}.`);
      this.key = [seed >>> 0];
      this.initGenrand(seed >>> 0);
    } else {
      if (seed.length === 0) throw new RangeError("Seed array must not be empty.");
      this.key = seed.map((s) => s >>> 0);
      this.initByArray(this.key);
    }
  }

  nextUint32(): number {
    if (this.mti >= N) this.twist();
    let y = this.mt[this.mti++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random(): number {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new RangeError(`int(min, max) needs safe integers with min <= max, got (${min}, ${max}).`);
    }
    const range = max - min + 1;
    if (range > 0x100000000) return min + Math.floor(this.random() * range);
    // Rejection sampling removes the modulo bias.
    const limit = Math.floor(0x100000000 / range) * range;
    for (;;) {
      const u = this.nextUint32();
      if (u < limit) return min + (u % range);
    }
  }

  fork(label: string): MersenneTwister {
    const key = [...this.key, FORK_SEPARATOR];
    for (let i = 0; i < label.length; i++) key.push(label.charCodeAt(i));
    return new MersenneTwister(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: readonly number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = ((mt[i]! ^ Math.imul(prev, 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = ((mt[i]! ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
    }
    mt[0] = UPPER_MASK;
    this.mti = N;
  }

  private twist(): void {
    const mt = this.mt;
    for (let kk = 0; kk < N; kk++) {
      const y = (mt[kk]! & UPPER_MASK) | (mt[(kk + 1) % N]! & LOWER_MASK);
      mt[kk] = mt[(kk + M) % N]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
    }
    this.mti = 0;
  }
}
