// Keccak-256 (the pre-standardization variant used by Ethereum), dependency-free.
//
// Implemented here rather than pulling in a library so the external-signing SDK
// has zero runtime dependencies: a partner can drop it into a wallet/dapp
// without a bundler resolution step. Correctness is pinned by known-answer
// tests against published Keccak-256 vectors.

const MASK64 = (1n << 64n) - 1n;

// Round constants (24 rounds).
const ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets, indexed [x + 5*y].
const ROTATIONS: number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl(x: bigint, n: number): bigint {
  if (n === 0) return x;
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF(state: bigint[]): void {
  const c = new Array<bigint>(5);
  const d = new Array<bigint>(5);
  const b = new Array<bigint>(25);

  for (let round = 0; round < 24; round++) {
    // Theta
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
    }
    for (let i = 0; i < 25; i++) {
      state[i] = state[i]! ^ d[i % 5]!;
    }

    // Rho + Pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const idx = x + 5 * y;
        const newX = y;
        const newY = (2 * x + 3 * y) % 5;
        b[newX + 5 * newY] = rotl(state[idx]!, ROTATIONS[idx]!);
      }
    }

    // Chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        state[i] = b[i]! ^ ((~b[((x + 1) % 5) + 5 * y]! & MASK64) & b[((x + 2) % 5) + 5 * y]!);
      }
    }

    // Iota
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

const RATE = 136; // 1088 bits for Keccak-256.

/** Keccak-256 of the input bytes. */
export function keccak256(input: Uint8Array): Uint8Array {
  const state = new Array<bigint>(25).fill(0n);

  // Keccak padding: 0x01 ... 0x80 within the rate block.
  const padLen = RATE - (input.length % RATE);
  const padded = new Uint8Array(input.length + padLen);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;

  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE; i++) {
      const lane = i >> 3;
      const shift = BigInt(8 * (i & 7));
      state[lane] = state[lane]! ^ (BigInt(padded[off + i]!) << shift);
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const lane = i >> 3;
    const shift = BigInt(8 * (i & 7));
    out[i] = Number((state[lane]! >> shift) & 0xffn);
  }
  return out;
}

/** Hex (0x-prefixed, lowercase) encoding. */
export function toHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Decode 0x-prefixed (or bare) hex to bytes. */
export function fromHex(hex: string): Uint8Array {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new Error("odd-length hex");
  // `Number.parseInt("2g", 16)` returns 2, not NaN, so a per-byte NaN check
  // silently accepts a valid nibble followed by garbage. Validate the whole
  // body against the hex alphabet first — callers hash addresses/metadata with
  // this, and a silently-truncated value produces a signature over wrong bytes.
  if (!/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error("invalid hex: non-hex character");
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/** UTF-8 encode a string. */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Left-pad a big-endian integer (given as decimal/bigint) to 32 bytes. */
export function uint256(value: bigint | number | string): Uint8Array {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) throw new Error("uint256 cannot be negative");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("value exceeds uint256");
  return out;
}

/** Left-pad an EVM address (20 bytes) to a 32-byte ABI word. */
export function addressWord(address: string): Uint8Array {
  const bytes = fromHex(address);
  if (bytes.length !== 20) throw new Error(`address must be 20 bytes, got ${bytes.length}`);
  const out = new Uint8Array(32);
  out.set(bytes, 12);
  return out;
}

/** Concatenate byte arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
