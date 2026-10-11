import { seedFrom } from "./hand";
import type { SpinSchedule } from "./spin-schedule";

/** Logical wheel geometry, in canvas units at scale 1. */
export const RIM_RADIUS = 146;
/** Room around the rim for its hand-drawn wobble (up to about 5) and half its 2.8 stroke. */
export const RIM_MARGIN = 8;
/** Side of the disc image; the wheel center is at its middle. */
export const WHEEL_SIZE = 2 * (RIM_RADIUS + RIM_MARGIN);
export const HUB_RADIUS = 38;
export const PIXEL_RATIO = 2;

/** Hub image layout: the circle plus the notch above it. */
export const NOTCH_HEIGHT = 14;
/** Room around the hub for its hand-drawn wobble and stroke. */
export const HUB_PAD = 5;
export const HUB_WIDTH = 2 * (HUB_RADIUS + HUB_PAD);
/** Distance from the top of the hub image to the hub center. */
export const HUB_CENTER_Y = HUB_RADIUS + NOTCH_HEIGHT + HUB_PAD;
export const HUB_HEIGHT = HUB_CENTER_Y + HUB_RADIUS + HUB_PAD;

/** Result pill below the wheel. */
/** The pill sits 14 below the wheel's 300 box, as in the prototype: 150 + 14 from the center. */
export const PILL_GAP = 164 - (RIM_RADIUS + RIM_MARGIN);
export const PILL_HEIGHT = 44;
export const RESULT_HEIGHT = WHEEL_SIZE + PILL_GAP + PILL_HEIGHT;

export const MIN_ITEMS = 2;
export const MAX_ITEMS = 20;

export const META_KEY = "drawLots";

export type WheelItem = {
    id: string;
    name: string;
    /** A small square image as a data URL (WebP or JPEG), encoded by the panel. */
    image?: string;
};

/** Images are drawn on the wheel only with this many visible items or fewer. */
export const IMAGE_ITEM_LIMIT = 10;
/** Upper bound for one stored image data URL; the panel targets about 16 000 characters (12 KB). */
export const MAX_IMAGE_CHARS = 64_000;

export function isImageDataUrl(value: unknown): value is string {
    return typeof value === "string" && value.length <= MAX_IMAGE_CHARS && /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(value);
}

export type DiscMeta = {
    role: "disc";
    wheelId: string;
    /** Increases by one on every write. Among stacked copies of a wheel, the highest is the newest state. */
    version: number;
    /** The full list, in order, including picked items. */
    items: WheelItem[];
    /** Clockwise rotation of the disc, in degrees, in [0, 360). */
    rotationDeg: number;
    /** Rotation the label flips were rendered for, when it differs from rotationDeg (the image that spins). */
    labelDeg?: number;
    /** Item id of the last pick while its result is shown, else null. */
    winnerId: string | null;
    /** Ids of items picked while removePicked was on, in pick order. */
    picked: string[];
    /** Picked items leave the wheel at the start of the next spin. */
    removePicked: boolean;
    /** Seed of the hand-drawn wobble: derived from the wheelId at creation and kept by copies. */
    seed: number;
    /** On the image that turns during a spin only: the spin's timing, for other clients' sound. */
    spin?: SpinSchedule;
};

export type Rect = { x: number; y: number; width: number; height: number };

/** Builds a meta object from what is stored, migrating earlier formats. */
function normalizeMeta(raw: Record<string, unknown>): DiscMeta | null {
    if (typeof raw.wheelId !== "string" || !Array.isArray(raw.items)) return null;
    // Phase 1 stored plain strings in some builds; their ids are derived from the position so every client agrees.
    const items: WheelItem[] = raw.items.flatMap((it, i) => {
        if (typeof it === "string") return [{ id: `item-${i}`, name: it }];
        if (typeof it === "object" && it !== null && typeof (it as WheelItem).name === "string") {
            const { id, name, image } = it as WheelItem;
            const item: WheelItem = { id: typeof id === "string" && id ? id : `item-${i}`, name };
            if (isImageDataUrl(image)) item.image = image;
            return [item];
        }
        return [];
    });
    let winnerId = typeof raw.winnerId === "string" ? raw.winnerId : null;
    // Phase 1 stored the winner as an index into items.
    if (winnerId === null && typeof raw.winnerIndex === "number") winnerId = items[raw.winnerIndex]?.id ?? null;
    const known = new Set(items.map((it) => it.id));
    return {
        role: "disc",
        wheelId: raw.wheelId,
        version: typeof raw.version === "number" ? raw.version : 0,
        items,
        rotationDeg: typeof raw.rotationDeg === "number" ? raw.rotationDeg : 0,
        labelDeg: typeof raw.labelDeg === "number" ? raw.labelDeg : undefined,
        winnerId: winnerId && known.has(winnerId) ? winnerId : null,
        picked: Array.isArray(raw.picked) ? raw.picked.filter((id): id is string => typeof id === "string" && known.has(id)) : [],
        removePicked: typeof raw.removePicked === "boolean" ? raw.removePicked : true,
        seed: typeof raw.seed === "number" ? raw.seed : seedFrom(raw.wheelId),
        spin: readSchedule(raw.spin),
    };
}

function readSchedule(raw: unknown): SpinSchedule | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const s = raw as Record<string, unknown>;
    const ok = ["durationMs", "startDeg", "deltaDeg", "count"].every((k) => typeof s[k] === "number" && Number.isFinite(s[k]));
    return ok ? { durationMs: s.durationMs as number, startDeg: s.startDeg as number, deltaDeg: s.deltaDeg as number, count: s.count as number } : undefined;
}

/** Reads the disc meta, or "legacy-hub" for a committed hub written by builds before the preview hub. */
export function readMeta(meta: unknown): DiscMeta | "legacy-hub" | null {
    if (typeof meta !== "object" || meta === null) return null;
    const value = (meta as Record<string, unknown>)[META_KEY];
    if (typeof value !== "object" || value === null) return null;
    const role = (value as { role?: unknown }).role;
    if (role === "hub") return "legacy-hub";
    if (role !== "disc") return null;
    return normalizeMeta(value as Record<string, unknown>);
}

/** Items a spin can land on: with removePicked on, the ones not picked yet. */
export function spinnableItems(meta: DiscMeta): WheelItem[] {
    if (!meta.removePicked) return meta.items;
    const picked = new Set(meta.picked);
    return meta.items.filter((it) => !picked.has(it.id));
}

/** Items drawn on the wheel: the spinnable ones, plus the shown winner while its result is up. */
export function visibleItems(meta: DiscMeta): WheelItem[] {
    if (!meta.removePicked) return meta.items;
    const picked = new Set(meta.picked);
    return meta.items.filter((it) => !picked.has(it.id) || it.id === meta.winnerId);
}

/** Index of the shown winner among the visible items, or null. */
export function visibleWinnerIndex(meta: DiscMeta): number | null {
    if (meta.winnerId === null) return null;
    const index = visibleItems(meta).findIndex((it) => it.id === meta.winnerId);
    return index >= 0 ? index : null;
}

/**
 * What the hub does: "spin" with at least two spinnable items, "reset" when picked items
 * leave fewer than two, "disabled" otherwise.
 */
export type HubState = "spin" | "reset" | "disabled";

export function hubState(meta: DiscMeta): HubState {
    if (spinnableItems(meta).length >= MIN_ITEMS) return "spin";
    if (meta.removePicked && meta.picked.length > 0) return "reset";
    return "disabled";
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
