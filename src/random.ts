/** Uniform float in [0, 1) from crypto.getRandomValues. */
export function randomFloat(): number {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    // 53 random bits: 21 from the high word, 32 from the low word.
    return ((buf[0] >>> 11) * 2 ** 32 + buf[1]) / 2 ** 53;
}

/** Uniform integer in [0, n) without modulo bias. */
export function randomInt(n: number): number {
    if (n <= 1) return 0;
    const limit = Math.floor(2 ** 32 / n) * n;
    const buf = new Uint32Array(1);
    for (;;) {
        crypto.getRandomValues(buf);
        if (buf[0] < limit) return buf[0] % n;
    }
}

export function randomBetween(min: number, max: number): number {
    return min + (max - min) * randomFloat();
}

/** The random source a spin uses. */
export const cryptoRandom = { int: randomInt, between: randomBetween };
