import type { Context } from "./context";
import { BaseGen } from "./gen";
import { Sfc32 } from "./rng";

/** Digits and capitals without I and O, which read as 1 and 0. */
const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROUNDS = 6;

export interface UniqueIdGenParams {
  id?: string;
  /** Put before the code, e.g. "BUG-". */
  prefix?: string;
  /** Characters in the code (default 6). The ids run out at alphabet.length ** length rows. */
  length?: number;
  /** The characters of the code (default digits and capitals without I and O). */
  alphabet?: string;
  /**
   * Picks the permutation (default: the run's seed). Runs meant to be joined need the same key, so
   * give one if they have different seeds.
   */
  key?: number;
}

/**
 * Ids that look random but never repeat: `BUG-7KQ2MX`. The row index goes through a keyed
 * permutation of all codes of the given length (a Feistel network), so distinct rows always get
 * distinct ids, also across runs joined by `startIndex`, and nothing needs remembering. The ids do
 * not follow row order, so rows made later (e.g. by another run) cannot be told by their id.
 */
export class UniqueIdGen extends BaseGen<string> {
  readonly prefix: string;
  readonly length: number;
  readonly alphabet: string;
  readonly key: number | undefined;
  /** How many codes there are: alphabet.length ** length. */
  readonly size: number;
  /** The permutation runs over side * side >= size values, as two digits base `side`. */
  private readonly side: number;
  /** Round keys by permutation key. */
  private readonly roundKeys = new Map<string, number[]>();

  constructor({ id, prefix = "", length = 6, alphabet = ALPHABET, key }: UniqueIdGenParams = {}) {
    super(id);
    this.check(typeof prefix === "string", "prefix must be a string.");
    this.check(Number.isInteger(length) && length >= 1, `length must be an integer >= 1, got ${length}.`);
    this.check(typeof alphabet === "string" && alphabet.length >= 2, "alphabet needs at least 2 characters.");
    this.check(new Set(alphabet).size === alphabet.length, "alphabet has a repeated character.");
    this.check(key === undefined || Number.isInteger(key), `key must be an integer, got ${key}.`);
    this.size = alphabet.length ** length;
    this.check(this.size <= 2 ** 52, `alphabet.length ** length must be at most 2 ** 52, got ${alphabet.length} ** ${length}.`);
    this.prefix = prefix;
    this.length = length;
    this.alphabet = alphabet;
    this.key = key;
    this.side = Math.ceil(Math.sqrt(this.size));
  }

  generate(_inputs: {}, ctx: Context): string {
    const index = ctx.row.index;
    this.check(index < this.size, `row ${index} is past the last id: ${this.alphabet.length} ** ${this.length} = ${this.size} ids. Use a larger length.`);
    let n = this.permute(index, this.key === undefined ? ctx.global.seed : [this.key >>> 0]);
    let code = "";
    for (let i = 0; i < this.length; i++) {
      code = this.alphabet[n % this.alphabet.length] + code;
      n = Math.floor(n / this.alphabet.length);
    }
    return this.prefix + code;
  }

  /**
   * A bijection on [0, size): Feistel rounds on [0, side * side), cycle-walking until the value is
   * back in range (it always comes back, since the rounds are a bijection on the larger set).
   */
  private permute(index: number, key: readonly number[]): number {
    const side = this.side;
    let roundKeys = this.roundKeys.get(key.join(","));
    if (!roundKeys) {
      roundKeys = Array.from({ length: ROUNDS }, (_, i) => new Sfc32(key).fork(`UniqueIdGen:${i}`).nextUint32());
      this.roundKeys.set(key.join(","), roundKeys);
    }
    let n = index;
    do {
      let left = Math.floor(n / side);
      let right = n % side;
      for (const k of roundKeys) [left, right] = [right, (left + roundHash(right, k)) % side];
      n = left * side + right;
    } while (n >= this.size);
    return n;
  }
}

/** A 32-bit mix of a value and a round key (MurmurHash3's finalizer). */
function roundHash(value: number, key: number): number {
  let h = (Math.imul(value | 0, 0x9e3779b1) ^ key ^ Math.floor(value / 0x100000000)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
