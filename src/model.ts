/** Logical wheel geometry, in canvas units at scale 1. */
export const WHEEL_SIZE = 300;
export const RIM_RADIUS = 146;
export const HUB_RADIUS = 38;
export const PIXEL_RATIO = 2;

/** Hub image layout: the circle plus the notch above it. */
export const NOTCH_HEIGHT = 14;
export const NOTCH_HALF_WIDTH = 10;
export const HUB_PAD = 2;
export const HUB_WIDTH = 2 * (HUB_RADIUS + HUB_PAD);
/** Distance from the top of the hub image to the hub center. */
export const HUB_CENTER_Y = HUB_RADIUS + NOTCH_HEIGHT + HUB_PAD;
export const HUB_HEIGHT = HUB_CENTER_Y + HUB_RADIUS + HUB_PAD;

/** Result pill below the wheel. */
export const PILL_GAP = 12;
export const PILL_HEIGHT = 36;
export const RESULT_HEIGHT = WHEEL_SIZE + PILL_GAP + PILL_HEIGHT;

export const MIN_ITEMS = 2;
export const MAX_ITEMS = 20;

export const META_KEY = "drawLots";

export type WheelItem = {
    id: string;
    name: string;
};

export type DiscMeta = {
    role: "disc";
    wheelId: string;
    /** Increases by one on every swap. Among stacked copies of a wheel, the highest is the newest state. */
    version: number;
    items: WheelItem[];
    /** Clockwise rotation of the disc, in degrees, in [0, 360). */
    rotationDeg: number;
    /** Rotation the label flips were rendered for, when it differs from rotationDeg (the image that spins). */
    labelDeg?: number;
    /** Index into items of the last pick, or null when no result is shown. */
    winnerIndex: number | null;
};

export type Rect = { x: number; y: number; width: number; height: number };

/** Reads the disc meta, or "legacy-hub" for a committed hub written by builds before the preview hub. */
export function readMeta(meta: unknown): DiscMeta | "legacy-hub" | null {
    if (typeof meta !== "object" || meta === null) return null;
    const value = (meta as Record<string, unknown>)[META_KEY];
    if (typeof value !== "object" || value === null) return null;
    const role = (value as { role?: unknown }).role;
    if (role === "hub") return "legacy-hub";
    if (role !== "disc") return null;
    const disc = value as DiscMeta;
    if (typeof disc.wheelId !== "string" || !Array.isArray(disc.items)) return null;
    return { ...disc, version: typeof disc.version === "number" ? disc.version : 0 };
}

/** Disc scale from its committed rect; width always equals the wheel diameter. */
export function discScale(rect: Rect): number {
    return rect.width / WHEEL_SIZE;
}

export function discCenter(rect: Rect): { x: number; y: number } {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.width / 2 };
}

export function hubRectFor(discRect: Rect): Rect {
    const s = discScale(discRect);
    const c = discCenter(discRect);
    return {
        x: c.x - (HUB_WIDTH / 2) * s,
        y: c.y - HUB_CENTER_Y * s,
        width: HUB_WIDTH * s,
        height: HUB_HEIGHT * s,
    };
}

export function normalizeDeg(deg: number): number {
    return ((deg % 360) + 360) % 360;
}
