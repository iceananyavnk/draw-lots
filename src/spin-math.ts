import { normalizeDeg } from "./model";

export const MIN_TURNS = 5;
export const MAX_TURNS = 7;
export const WINNER_MARGIN = 0.15;

export type SpinTarget = {
    winnerIndex: number;
    /** Where the notch lands inside the winning wedge, as a fraction in [WINNER_MARGIN, 1 - WINNER_MARGIN]. */
    offset: number;
    turns: number;
    /** Clockwise disc rotation after the spin, in [0, 360). */
    finalDeg: number;
    /** Clockwise rotation to animate from startDeg, in degrees. */
    deltaDeg: number;
};

export type RandomSource = {
    int(n: number): number;
    between(min: number, max: number): number;
};

/**
 * Picks the winner first, then the rotation that puts the notch (12 o'clock) inside it.
 * Wedge i spans [i, i + 1) * wedgeDeg clockwise from 12 o'clock at rotation 0, so after a
 * clockwise rotation R the notch sits at -R on the disc.
 */
export function pickSpin(count: number, startDeg: number, random: RandomSource): SpinTarget {
    const wedgeDeg = 360 / count;
    const winnerIndex = random.int(count);
    const offset = random.between(WINNER_MARGIN, 1 - WINNER_MARGIN);
    const finalDeg = normalizeDeg(-(winnerIndex + offset) * wedgeDeg);
    const turns = MIN_TURNS + random.int(MAX_TURNS - MIN_TURNS + 1);
    const deltaDeg = turns * 360 + normalizeDeg(finalDeg - startDeg);
    return { winnerIndex, offset, turns, finalDeg, deltaDeg };
}
