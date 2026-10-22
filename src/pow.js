/**
 * DeepSeek web proof-of-work.
 *
 * chat.deepseek.com gates `POST /api/v0/chat/completion` behind a PoW
 * challenge. The response header is:
 *
 *   X-DS-PoW-Response: base64(JSON.stringify({
 *     algorithm, challenge, salt, answer, signature, target_path,
 *   }))
 *
 * The `answer` is the smallest integer `i` in `[0, difficulty)` such that
 *
 *   DeepSeekHashV1(`${salt}_${expire_at}_${i}`) === challenge
 *
 * `DeepSeekHashV1` is *not* standard SHA3-256. It is a customised Keccak
 * sponge transcribed from the site's own worker chunk:
 *
 *   - the rate is 136 bytes with the padding byte 0x06 (SHA3 domain), but
 *   - every 64-bit lane swaps its two 32-bit halves on absorb and on squeeze, and
 *   - the permutation runs rounds 1..23 (23 rounds) with tables that already
 *     fold rho/pi together.
 *
 * Absorb and squeeze apply the same swap, so the digest is well defined.
 * Transcibing the site's own implementation is what makes the answer byte-for-byte
 * identical to the one its worker would produce.
 *
 * @module src/pow
 */
'use strict';

/** Round-constant words, consumed from index 2 (round 1) to 47 (round 23). */
const RC_WORDS = new Uint32Array([
  0, 1, 0, 32898, 0x80000000, 32906, 0x80000000, 0x80008000, 0, 32907, 0, 0x80000001,
  0x80000000, 0x80008081, 0x80000000, 32777, 0, 138, 0, 136, 0, 0x80008009, 0, 0x8000000a,
  0, 0x8000808b, 0x80000000, 139, 0x80000000, 32905, 0x80000000, 32771, 0x80000000, 32770,
  0x80000000, 128, 0, 32778, 0x80000000, 0x8000000a, 0x80000000, 0x80008081, 0x80000000,
  32896, 0, 0x80000001, 0x80000000, 0x80008008,
]);

/** Rotation offsets for rounds 0..23. */
const RHO = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
/** Pi lane permutation for rounds 0..23 (already folded with rho). */
const PI = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];

/** Sponge rate in bytes: 200 - capacity(256 bits)/4. */
const RATE = 136;
/** Digest size in bytes. */
const DIGEST_BYTES = 32;
/** SHA3 domain-separation padding byte. */
const SHA3_PAD = 0x06;

const scratchC = new Uint32Array(10);
const scratchD = new Uint32Array(10);
const scratchW = new Uint32Array(2);

/** Copy one 64-bit lane between word arrays. */
function copyLane(src, srcLane, dst, dstLane) {
  dst[dstLane * 2] = src[srcLane * 2];
  dst[dstLane * 2 + 1] = src[srcLane * 2 + 1];
}

/** theta */
function theta(A, C, D, W) {
  for (let t = 0; t < 5; t++) {
    const a = t * 2, b = (t + 5) * 2, c = (t + 10) * 2, d = (t + 15) * 2, e = (t + 20) * 2;
    C[a] = A[a] ^ A[b] ^ A[c] ^ A[d] ^ A[e];
    C[a + 1] = A[a + 1] ^ A[b + 1] ^ A[c + 1] ^ A[d + 1] ^ A[e + 1];
  }
  for (let t = 0; t < 5; t++) {
    copyLane(C, (t + 1) % 5, W, 0);
    const lo = W[0], hi = W[1];
    W[0] = (lo << 1) | (hi >>> 31);
    W[1] = (hi << 1) | (lo >>> 31);
    const prev = ((t + 4) % 5) * 2;
    D[t * 2] = C[prev] ^ W[0];
    D[t * 2 + 1] = C[prev + 1] ^ W[1];
    for (let r = 0; r < 25; r += 5) {
      A[(r + t) * 2] ^= D[t * 2];
      A[(r + t) * 2 + 1] ^= D[t * 2 + 1];
    }
  }
}

/** rho + pi, with the 32-bit halves swapped for rotations >= 32. */
function rhoPi(A, C, W) {
  let i = 0;
  copyLane(A, i + 1, W, 0);
  for (; i < 24; i++) {
    const lane = RHO[i], rot = PI[i];
    copyLane(A, lane, C, 0);
    const lo = W[0], hi = W[1];
    const shift = 32 - rot;
    const slot = rot < 32 ? 0 : 1;
    W[slot] = (lo << rot) | (hi >>> shift);
    W[(slot + 1) % 2] = (hi << rot) | (lo >>> shift);
    copyLane(W, 0, A, lane);
    copyLane(C, 0, W, 0);
  }
}

/** chi */
function chi(A, C) {
  for (let base = 0; base < 25; base += 5) {
    for (let n = 0; n < 5; n++) copyLane(A, base + n, C, n);
    for (let n = 0; n < 5; n++) {
      const dst = (base + n) * 2;
      const p = ((n + 1) % 5) * 2;
      const q = ((n + 2) % 5) * 2;
      A[dst] ^= ~C[p] & C[q];
      A[dst + 1] ^= ~C[p + 1] & C[q + 1];
    }
  }
}

/** iota */
function iota(A, round) {
  A[0] ^= RC_WORDS[round * 2];
  A[1] ^= RC_WORDS[round * 2 + 1];
}

/** One full permutation: rounds 1..23 inclusive. */
function permute(state) {
  for (let round = 1; round < 24; round++) {
    theta(state, scratchC, scratchD, scratchW);
    rhoPi(state, scratchC, scratchW);
    chi(state, scratchC);
    iota(state, round);
    scratchC.fill(0);
    scratchD.fill(0);
    scratchW.fill(0);
  }
}

/** XOR one rate-sized byte block into the state, lane halves swapped. */
function absorbBlock(state, block) {
  for (let r = 0; r < RATE; r += 8) {
    const lane = r / 4;
    state[lane] ^= (block[r + 7] << 24) | (block[r + 6] << 16) | (block[r + 5] << 8) | block[r + 4];
    state[lane + 1] ^= (block[r + 3] << 24) | (block[r + 2] << 16) | (block[r + 1] << 8) | block[r];
  }
}

/** Write the state into `out` starting at `offset`, lane halves swapped back. */
function squeezeInto(state, out, offset) {
  for (let r = 0; r < RATE && offset + r < out.length; r += 8) {
    const lane = r / 4;
    out[offset + r] = state[lane + 1];
    out[offset + r + 1] = state[lane + 1] >>> 8;
    out[offset + r + 2] = state[lane + 1] >>> 16;
    out[offset + r + 3] = state[lane + 1] >>> 24;
    out[offset + r + 4] = state[lane];
    out[offset + r + 5] = state[lane] >>> 8;
    out[offset + r + 6] = state[lane] >>> 16;
    out[offset + r + 7] = state[lane] >>> 24;
  }
}

/**
 * A reusable sponge so one worker can hash many candidates without reallocating.
 * Not reentrant: callers own one instance per solve.
 */
export class DeepSeekHash {
  constructor() {
    this.state = new Uint32Array(50);
    this.block = new Uint8Array(RATE);
    this.offset = 0;
  }

  reset() {
    this.state.fill(0);
    this.block.fill(0);
    this.offset = 0;
    return this;
  }

  /** Absorb UTF-8 bytes. */
  write(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      this.block[this.offset++] = bytes[i];
      if (this.offset === RATE) {
        absorbBlock(this.state, this.block);
        permute(this.state);
        this.block.fill(0);
        this.offset = 0;
      }
    }
    return this;
  }

  /** Absorb an ASCII string (the answer digits and the prefix are both ASCII). */
  writeAscii(str) {
    for (let i = 0; i < str.length; i++) {
      this.block[this.offset++] = str.charCodeAt(i) & 0xff;
      if (this.offset === RATE) {
        absorbBlock(this.state, this.block);
        permute(this.state);
        this.block.fill(0);
        this.offset = 0;
      }
    }
    return this;
  }

  /** Squeeze the 32-byte digest as lowercase hex. */
  digestHex() {
    const block = this.block;
    block.fill(0, this.offset);
    block[this.offset] |= SHA3_PAD;
    block[RATE - 1] |= 0x80;
    absorbBlock(this.state, block);
    const out = new Uint8Array(DIGEST_BYTES);
    for (let t = 0; t < out.length; t += RATE) {
      permute(this.state);
      squeezeInto(this.state, out, t);
    }
    let hex = '';
    for (let i = 0; i < out.length; i++) hex += (out[i] < 16 ? '0' : '') + out[i].toString(16);
    return hex;
  }
}

/**
 * Solve one challenge.
 *
 * @param {object} challenge - the `challenge` object from `create_pow_challenge`.
 * @param {{ signal?: AbortSignal, budgetMs?: number }} [options]
 * @returns {number | undefined} the answer, or `undefined` when unsolved.
 * @throws {Error} when the algorithm is unknown or the attempt is aborted.
 */
export function solvePow(challenge, options = {}) {
  const { signal, budgetMs = 60_000 } = options;
  if (challenge.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`unsupported PoW algorithm: ${challenge.algorithm}`);
  }
  const difficulty = Number(challenge.difficulty) || 0;
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const hasher = new DeepSeekHash();
  const deadline = Date.now() + budgetMs;

  for (let answer = 0; answer < difficulty; answer++) {
    if ((answer & 0x3ff) === 0) {
      if (signal?.aborted) throw new Error('PoW solve aborted');
      if (Date.now() > deadline) break;
    }
    hasher.reset();
    hasher.writeAscii(prefix);
    hasher.writeAscii(String(answer));
    if (hasher.digestHex() === challenge.challenge) return answer;
  }
  return undefined;
}

/**
 * Build the `X-DS-PoW-Response` header value for a solved challenge.
 *
 * @param {object} challenge - the challenge that was solved.
 * @param {number} answer - the solved integer.
 * @returns {string} base64-encoded JSON payload.
 */
export function powResponseHeader(challenge, answer) {
  const payload = JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  });
  return Buffer.from(payload, 'utf8').toString('base64');
}
