/**
 * Hand-drawn geometry, ported from the design prototype. Angles are measured clockwise from
 * 12 o'clock and points are relative to the wheel center, so a path traced here is the same
 * whether the context is rotated for the disc or not. All wobble is deterministic: the same
 * seed always produces the same outline on every client.
 */

type Ctx = OffscreenCanvasRenderingContext2D;
export type Point = [number, number];

/** mulberry32-style generator, as in the prototype. */
export function rng(seed: number): () => number {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A smooth periodic wobble: four sine terms with seeded amplitudes and phases. */
export function noise(seed: number, amp: number): (theta: number) => number {
    const r = rng(seed);
    const terms = [1, 2, 3, 5].map((k) => ({ k, a: (amp * (0.4 + r() * 0.6)) / Math.sqrt(k), p: r() * Math.PI * 2 }));
    return (theta) => terms.reduce((sum, t) => sum + t.a * Math.sin(t.k * theta + t.p), 0);
}

/** 32-bit FNV-1a hash, used to derive a wheel's wobble seed from its wheelId. */
export function seedFrom(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h | 0;
}

export const polar = (r: number, a: number): Point => [r * Math.sin(a), -r * Math.cos(a)];

/** Traces a Catmull-Rom spline through the points as cubic Béziers. */
export function traceSmooth(ctx: Ctx, pts: Point[], closed: boolean): void {
    const n = pts.length;
    const at = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < (closed ? n : n - 1); i++) {
        const p0 = at(i - 1);
        const p1 = at(i);
        const p2 = at(i + 1);
        const p3 = at(i + 2);
        ctx.bezierCurveTo(
            p1[0] + (p2[0] - p0[0]) / 6,
            p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6,
            p2[1] - (p3[1] - p1[1]) / 6,
            p2[0],
            p2[1]
        );
    }
    if (closed) ctx.closePath();
}

function tracePolyline(ctx: Ctx, pts: Point[]): void {
    ctx.lineTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
}

/** The wobbling rim of one wheel. */
export class HandWheel {
    readonly rimNoise: (theta: number) => number;

    constructor(readonly seed: number, readonly rim: number, readonly hub: number) {
        this.rimNoise = noise(seed, 1.8);
    }

    rimPts(base: number, a0: number, a1: number, step = 0.1): Point[] {
        const k = Math.max(2, Math.ceil((a1 - a0) / step));
        const out: Point[] = [];
        for (let j = 0; j <= k; j++) {
            const a = a0 + ((a1 - a0) * j) / k;
            out.push(polar(base + this.rimNoise(a), a));
        }
        return out;
    }

    /** The closed rim at radius `base`. */
    traceRim(ctx: Ctx, base: number): void {
        ctx.beginPath();
        traceSmooth(ctx, this.rimPts(base, 0, Math.PI * 2, 0.2).slice(0, -1), true);
    }

    /** A wedge from the center to the wobbling rim. */
    traceWedge(ctx: Ctx, a0: number, a1: number): void {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        tracePolyline(ctx, this.rimPts(this.rim, a0, a1));
        ctx.closePath();
    }

    /** The winner outline: inset 6 from the rim, 7 from the hub, 6 along each separator. */
    traceWinner(ctx: Ctx, a0: number, a1: number): void {
        const d = 6 / ((this.rim + this.hub) / 2);
        const pts = [polar(this.hub + 7, a0 + d), ...this.rimPts(this.rim - 6, a0 + d, a1 - d), polar(this.hub + 7, a1 - d)];
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        tracePolyline(ctx, pts.slice(1));
        ctx.closePath();
    }

    /** A slightly curved ink separator from just inside the hub to the rim at angle `a`. */
    traceSeparator(ctx: Ctx, index: number, a: number): void {
        const r = rng(this.seed + index * 97);
        const s = polar(this.hub - 2, a);
        const e = polar(this.rim + this.rimNoise(a), a);
        const m = polar((this.hub + this.rim) / 2, a);
        const off = (r() * 2 - 1) * 2.4;
        const c: Point = [m[0] + off * Math.cos(a), m[1] + off * Math.sin(a)];
        ctx.beginPath();
        ctx.moveTo(s[0], s[1]);
        ctx.quadraticCurveTo(c[0], c[1], e[0], e[1]);
    }
}

/** A wobbly circle centered on the origin. */
export function traceHandCircle(ctx: Ctx, r: number, seed: number, amp: number): void {
    const nz = noise(seed, amp);
    const pts: Point[] = [];
    for (let j = 0; j < 24; j++) {
        const a = (j / 24) * Math.PI * 2;
        const rr = r + nz(a);
        pts.push([rr * Math.sin(a), -rr * Math.cos(a)]);
    }
    ctx.beginPath();
    traceSmooth(ctx, pts, true);
}

/** The notch above a hub of radius `hubR`, with the rounded tip of the prototype. */
export function traceNotch(ctx: Ctx, hubR: number): void {
    const tip: Point = [0, -hubR - 14];
    const l: Point = [-11, -hubR + 8];
    const r: Point = [11, -hubR + 8];
    const t = 0.18;
    const tl: Point = [tip[0] + (l[0] - tip[0]) * t, tip[1] + (l[1] - tip[1]) * t];
    const tr: Point = [tip[0] + (r[0] - tip[0]) * t, tip[1] + (r[1] - tip[1]) * t];
    ctx.beginPath();
    ctx.moveTo(l[0], l[1]);
    ctx.lineTo(tl[0], tl[1]);
    ctx.quadraticCurveTo(tip[0], tip[1], tr[0], tr[1]);
    ctx.lineTo(r[0], r[1]);
    ctx.closePath();
}
