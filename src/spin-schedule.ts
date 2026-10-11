/**
 * Timing of one spin, shared by the notch animation in the driver and the sound in the panel.
 * The panel receives the same fields in one message and repeats tickTimes there.
 */
export type SpinSchedule = {
    durationMs: number;
    /** Clockwise disc rotation at the start, in degrees. */
    startDeg: number;
    /** Clockwise rotation added by the spin, in degrees (several full turns). */
    deltaDeg: number;
    /** Wedges on the turning image. */
    count: number;
};

/** Ticks closer together than this are dropped, as in the prototype. */
export const MIN_TICK_GAP_MS = 45;

export const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

/**
 * Times, in ms from the start, at which a wedge boundary passes the notch. The disc shows
 * wedge floor(-rotation / wedge) under the notch, so a boundary passes whenever the
 * rotation crosses a multiple of the wedge angle. Inverting rotation = start + delta *
 * easeOutQuart(t) gives t = 1 - (1 - u)^(1/4) for u = (boundary - start) / delta.
 */
export function tickTimes(s: SpinSchedule): number[] {
    if (s.count < 2 || s.deltaDeg <= 0) return [];
    const wedge = 360 / s.count;
    const end = s.startDeg + s.deltaDeg;
    const times: number[] = [];
    let last = -Infinity;
    for (let m = Math.floor(s.startDeg / wedge) + 1; m * wedge <= end; m++) {
        const u = (m * wedge - s.startDeg) / s.deltaDeg;
        const t = (1 - (1 - u) ** 0.25) * s.durationMs;
        if (t - last >= MIN_TICK_GAP_MS) {
            times.push(t);
            last = t;
        }
    }
    return times;
}
