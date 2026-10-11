import { loadFonts } from "./fonts";
import { decodeBase64 } from "./base64";
import { HandWheel, traceHandCircle, traceNotch } from "./hand";
import { token } from "./host";
import { fitLabel, measureLabel, renderLabel, truncateLabel, type TextStep } from "./labels";
import {
    HUB_CENTER_Y,
    HUB_HEIGHT,
    HUB_RADIUS,
    HUB_WIDTH,
    PILL_GAP,
    PILL_HEIGHT,
    PIXEL_RATIO,
    RESULT_HEIGHT,
    RIM_RADIUS,
    WHEEL_SIZE,
    IMAGE_ITEM_LIMIT,
    normalizeDeg,
    visibleItems,
    visibleWinnerIndex,
    type DiscMeta,
    type HubState,
    type WheelItem,
} from "./model";

type Ctx = OffscreenCanvasRenderingContext2D;

/** The wheel is a board object with fixed colors, independent of the Drawdy theme. */
const WEDGE_COLORS = ["#33DBCB", "#FFC67D", "#87A3FA", "#B5A1FF", "#FFA1B9"];
const LAST_WEDGE_FALLBACK = "#FFC67D";
const EMPTY_FILL = "#FFFFFF";
const WEDGE_TEXT = "#090909";
const ACCENT = "#C5F601";
const INK = "#090909";
/** Hand-drawn ink, as in the prototype. */
const INK_LINE = "#1F1B16";
const RIM_STROKE = 2.8;
const SEPARATOR_STROKE = 2.2;
const NOTCH_STROKE = 2.2;
const HUB_CIRCLE_STROKE = 2.4;
const HUB_WOBBLE = 0.9;
/** Bottom of the notch's bounding box: its base corners sit 8 inside the hub edge. */
const NOTCH_PIVOT_Y = -HUB_RADIUS + 8;
/** Hub circle seed offset from the wheel seed, as in the prototype. */
const HUB_SEED_OFFSET = 7;
const DIMMED_ALPHA = 0.35;
const WINNER_STROKE = 5;
const WINNER_OPACITY = 0.95;
const PILL_FILL = "#FFFFFF";
const PILL_BORDER = 2;
const PILL_LABEL = "rgba(0,0,0,0.5)";
const PILL_NAME = "#090909";
const PILL_DOT = 28;

/** Largest first. */
const WEDGE_STEPS: TextStep[] = [
    { size: 24, weight: 600 },
    { size: 20, weight: 600 },
    { size: 16, weight: 600 },
    { size: 14, weight: 500 },
    { size: 12, weight: 500 },
    { size: 11, weight: 500 },
];
const TEXT_PADDING = 24;
const HUB_LABEL: TextStep = { size: 15, weight: 700 };
const PILL_LABEL_STEP: TextStep = { size: 13, weight: 500 };
const PILL_NAME_STEP: TextStep = { size: 15, weight: 600 };
const PILL_MAX_WIDTH = 260;
/** Item images, as in the prototype: centred at 0.66 of the rim radius, with a white ring and an ink ring. */
const IMAGE_RADIUS_FACTOR = 0.66;
const IMAGE_MAX_RADIUS = 26;
const IMAGE_MIN_RADIUS = 14;
const IMAGE_RING = 2.5;
const IMAGE_RING_STROKE = 2;
const IMAGE_RING_WOBBLE = 0.7;
/** Ring seed per wedge: wheel seed + 31 * (index + 1), as in the prototype. */
const IMAGE_RING_SEED_STEP = 31;
const IMAGE_CACHE_SIZE = 64;

const bitmaps = new Map<string, Promise<ImageBitmap | null>>();

/** Decodes an image data URL once; later renders reuse the bitmap. Undecodable images give null. */
function bitmapFor(dataUrl: string): Promise<ImageBitmap | null> {
    let bitmap = bitmaps.get(dataUrl);
    if (!bitmap) {
        const comma = dataUrl.indexOf(",");
        const type = dataUrl.slice(5, dataUrl.indexOf(";"));
        bitmap = createImageBitmap(new Blob([decodeBase64(dataUrl.slice(comma + 1)) as Uint8Array<ArrayBuffer>], { type })).catch(() => null);
        bitmaps.set(dataUrl, bitmap);
        if (bitmaps.size > IMAGE_CACHE_SIZE) bitmaps.delete(bitmaps.keys().next().value as string);
    }
    return bitmap;
}

/** Radius of the item images on a wheel of `count` visible items, or 0 when images are not drawn. */
function imageRadius(count: number): number {
    if (count > IMAGE_ITEM_LIMIT || count < 1) return 0;
    const seg = (2 * Math.PI) / count;
    const r = Math.min(IMAGE_MAX_RADIUS, Math.sin(seg / 2) * RIM_RADIUS * IMAGE_RADIUS_FACTOR * 0.82, RIM_RADIUS * 0.2);
    return r >= IMAGE_MIN_RADIUS ? r : 0;
}

export function wedgeColors(count: number): string[] {
    const colors = Array.from({ length: count }, (_, i) => WEDGE_COLORS[i % WEDGE_COLORS.length]);
    if (count > 1 && colors[count - 1] === colors[0]) {
        colors[count - 1] = LAST_WEDGE_FALLBACK;
    }
    return colors;
}

/**
 * True when the wedge midpoint, measured clockwise from 12 o'clock at the given disc
 * rotation, lies strictly between 180 and 360 degrees. Radial text there would read
 * upside down, so it is turned 180 degrees about its own center.
 */
export function isLeftHalf(index: number, count: number, rotationDeg: number): boolean {
    const deg = normalizeDeg(((index + 0.5) * 360) / count + rotationDeg);
    return deg > 180 && deg < 360;
}

/** The opaque color of `hex` drawn at `alpha` over white. */
function mixWithWhite(hex: string, alpha: number): string {
    const n = parseInt(hex.slice(1), 16);
    const channel = (shift: number) => Math.round(((n >> shift) & 0xff) * alpha + 255 * (1 - alpha));
    return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

export type DiscRenderInput = {
    items: WheelItem[];
    /** Clockwise rotation of the wedges. */
    rotationDeg: number;
    /** Rotation the label flips are chosen for; defaults to rotationDeg. A spinning image uses its final rotation. */
    labelDeg?: number;
    winnerIndex: number | null;
    /** Seed of the hand-drawn wobble. */
    seed: number;
};

/**
 * Renders the disc in the hand-drawn style. Wedge i spans [i, i + 1) * wedgeAngle clockwise
 * from 12 o'clock before rotation. Fills and labels come first, then the winner outline,
 * then the ink (separators and rim), which is never dimmed. Without a result the hub is
 * baked in as the plain hand-drawn circle, which reads as a wheel without the extension and
 * rotates unseen under the preview hub. With a result the full hub, notch and pill are baked
 * in and the canvas grows downward for the pill, keeping the wheel in the top square.
 */
export async function renderDisc(input: DiscRenderInput): Promise<{ blob: Blob; width: number; height: number }> {
    await loadFonts();
    const { items, rotationDeg, winnerIndex } = input;
    const labelDeg = input.labelDeg ?? rotationDeg;
    const hasResult = winnerIndex !== null && items[winnerIndex] !== undefined;
    const height = hasResult ? RESULT_HEIGHT : WHEEL_SIZE;
    const canvas = new OffscreenCanvas(WHEEL_SIZE * PIXEL_RATIO, height * PIXEL_RATIO);
    const ctx = canvas.getContext("2d") as Ctx;
    ctx.scale(PIXEL_RATIO, PIXEL_RATIO);

    const hand = new HandWheel(input.seed, RIM_RADIUS, HUB_RADIUS);
    const count = items.length;
    const seg = (2 * Math.PI) / Math.max(count, 1);
    const midRadius = (RIM_RADIUS + HUB_RADIUS) / 2;
    const maxWidth = RIM_RADIUS - HUB_RADIUS - TEXT_PADDING;
    const maxThickness = 0.6 * 2 * midRadius * Math.sin(Math.min(seg, Math.PI) / 2);
    const colors = wedgeColors(count);
    const imgR = imageRadius(count);
    const images = await Promise.all(items.map((it) => (imgR > 0 && it.image ? bitmapFor(it.image) : Promise.resolve(null))));
    const pillImage = hasResult && items[winnerIndex].image ? await bitmapFor(items[winnerIndex].image!) : null;

    ctx.save();
    ctx.translate(WHEEL_SIZE / 2, WHEEL_SIZE / 2);
    ctx.rotate((rotationDeg * Math.PI) / 180);

    if (count === 0) {
        hand.traceRim(ctx, RIM_RADIUS);
        ctx.fillStyle = EMPTY_FILL;
        ctx.fill();
    }
    for (let i = 0; i < count; i++) {
        const a0 = i * seg;
        const dimmed = hasResult && i !== winnerIndex;
        // Only fills dim. They are pre-mixed with white and stay opaque, so whichever disc of a
        // stack is drawn on top fully hides the wedges below it.
        if (count === 1) hand.traceRim(ctx, RIM_RADIUS);
        else hand.traceWedge(ctx, a0, a0 + seg);
        ctx.globalAlpha = 1;
        ctx.fillStyle = dimmed ? mixWithWhite(colors[i], DIMMED_ALPHA) : colors[i];
        ctx.fill();

        const image = images[i];
        if (image) {
            drawItemImage(ctx, image, count === 1 ? 0 : a0 + seg / 2, imgR, input.seed + IMAGE_RING_SEED_STEP * (i + 1), dimmed);
            continue;
        }
        const layout = fitLabel(ctx, items[i].name, WEDGE_STEPS, maxWidth, maxThickness);
        ctx.save();
        // Canvas angles start at 3 o'clock; a single item's label sits on the radius toward 12 o'clock.
        ctx.rotate((count === 1 ? 0 : a0 + seg / 2) - Math.PI / 2);
        ctx.translate(midRadius, 0);
        if (count > 1 && isLeftHalf(i, count, labelDeg)) ctx.rotate(Math.PI);
        ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
        ctx.fillStyle = WEDGE_TEXT;
        renderLabel(ctx, layout);
        ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (hasResult && count > 1) {
        const a0 = winnerIndex * seg;
        hand.traceWinner(ctx, a0, a0 + seg);
        ctx.globalAlpha = WINNER_OPACITY;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = WINNER_STROKE;
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    // Ink sits above the fills and is never dimmed, like a colouring book.
    ctx.strokeStyle = INK_LINE;
    if (count > 1) {
        ctx.lineWidth = SEPARATOR_STROKE;
        ctx.lineCap = "round";
        for (let i = 0; i < count; i++) {
            hand.traceSeparator(ctx, i, i * seg);
            ctx.stroke();
        }
    }
    hand.traceRim(ctx, RIM_RADIUS);
    ctx.lineWidth = RIM_STROKE;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(WHEEL_SIZE / 2, WHEEL_SIZE / 2);
    drawHub(ctx, input.seed, hasResult ? "full" : "plain");
    ctx.restore();

    if (hasResult) drawPill(ctx, items[winnerIndex].name, pillImage);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { blob, width: WHEEL_SIZE, height };
}

/**
 * Draws an item image in its wedge at angle `mid` (clockwise from 12 o'clock): a white
 * hand-drawn ring, the image clipped to a circle, then the ink ring. The image's top faces
 * the rim. Dimmed images are drawn at 35 % over the white ring, so they stay opaque.
 */
function drawItemImage(ctx: Ctx, image: ImageBitmap, mid: number, imgR: number, seed: number, dimmed: boolean): void {
    ctx.save();
    ctx.rotate(mid);
    ctx.translate(0, -RIM_RADIUS * IMAGE_RADIUS_FACTOR);
    traceHandCircle(ctx, imgR + IMAGE_RING, seed, IMAGE_RING_WOBBLE);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, imgR, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
    drawCover(ctx, image, -imgR, -imgR, imgR * 2);
    ctx.restore();

    traceHandCircle(ctx, imgR + IMAGE_RING, seed, IMAGE_RING_WOBBLE);
    ctx.strokeStyle = dimmed ? mixWithWhite(INK_LINE, DIMMED_ALPHA) : INK_LINE;
    ctx.lineWidth = IMAGE_RING_STROKE;
    ctx.stroke();
    ctx.restore();
}

/** Draws an image centre-cropped to fill a square, like object-fit: cover. */
function drawCover(ctx: Ctx, image: ImageBitmap, x: number, y: number, size: number): void {
    const side = Math.min(image.width, image.height);
    ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, x, y, size, size);
}

/** Renders the disc a meta describes: its visible items, rotation, result and wobble. */
export function renderMeta(meta: DiscMeta): Promise<{ blob: Blob; width: number; height: number }> {
    return renderDisc({
        items: visibleItems(meta),
        rotationDeg: meta.rotationDeg,
        labelDeg: meta.labelDeg,
        winnerIndex: visibleWinnerIndex(meta),
        seed: meta.seed,
    });
}

function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/**
 * The prototype's hand-drawn result pill: white, 2px ink border, a circle (the winner's image,
 * or lime), "Picked" and the name.
 */
function drawPill(ctx: Ctx, name: string, image: ImageBitmap | null): void {
    const padLeft = 6;
    const padRight = 12;
    const gap = 8;
    const label = measureLabel(ctx, "Picked", PILL_LABEL_STEP);
    const fixed = PILL_BORDER * 2 + padLeft + PILL_DOT + gap + label.width + gap + padRight;
    const shown = truncateLabel(ctx, name, PILL_NAME_STEP, PILL_MAX_WIDTH - fixed);

    const width = fixed + shown.width;
    const x = (WHEEL_SIZE - width) / 2;
    const y = WHEEL_SIZE + PILL_GAP;
    const cy = y + PILL_HEIGHT / 2;

    const inset = PILL_BORDER / 2;
    roundRectPath(ctx, x + inset, y + inset, width - PILL_BORDER, PILL_HEIGHT - PILL_BORDER, (PILL_HEIGHT - PILL_BORDER) / 2);
    ctx.fillStyle = PILL_FILL;
    ctx.fill();
    ctx.strokeStyle = INK_LINE;
    ctx.lineWidth = PILL_BORDER;
    ctx.stroke();

    const dotX = x + PILL_BORDER + padLeft + PILL_DOT / 2;
    const dotR = PILL_DOT / 2 - PILL_BORDER / 2;
    ctx.beginPath();
    ctx.arc(dotX, cy, dotR, 0, Math.PI * 2);
    if (image) {
        ctx.save();
        ctx.clip();
        drawCover(ctx, image, dotX - dotR, cy - dotR, dotR * 2);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(dotX, cy, dotR, 0, Math.PI * 2);
    } else {
        ctx.fillStyle = ACCENT;
        ctx.fill();
    }
    ctx.strokeStyle = INK_LINE;
    ctx.lineWidth = PILL_BORDER;
    ctx.stroke();

    ctx.save();
    ctx.translate(dotX + PILL_DOT / 2 + gap, cy);
    ctx.fillStyle = PILL_LABEL;
    renderLabel(ctx, label, "left");
    ctx.translate(label.width + gap, 0);
    ctx.fillStyle = PILL_NAME;
    renderLabel(ctx, shown, "left");
    ctx.restore();
}

type HubColors = { fill: string; line: string; text: string; cover?: string };

const ACTIVE_HUB: HubColors = { fill: ACCENT, line: INK_LINE, text: INK };

/**
 * Draws the hand-drawn hub centered on the current origin, with the same paths in the disc
 * image and in the preview, so the two always line up. "plain" is the circle alone; "full"
 * adds the notch behind it and the label.
 */
function drawHub(ctx: Ctx, seed: number, style: "plain" | "full", label = "Spin", colors: HubColors = ACTIVE_HUB, notchDeg = 0): void {
    ctx.lineJoin = "round";
    if (style === "full") {
        // The notch turns about the middle of its base, like the prototype's transform-origin 50% 100%.
        ctx.save();
        ctx.translate(0, NOTCH_PIVOT_Y);
        ctx.rotate((notchDeg * Math.PI) / 180);
        ctx.translate(0, -NOTCH_PIVOT_Y);
        traceNotch(ctx, HUB_RADIUS);
        ctx.fillStyle = colors.fill;
        ctx.fill();
        strokeCovering(ctx, NOTCH_STROKE, colors);
        ctx.restore();
    }
    traceHandCircle(ctx, HUB_RADIUS, seed + HUB_SEED_OFFSET, HUB_WOBBLE);
    ctx.fillStyle = colors.fill;
    ctx.fill();
    strokeCovering(ctx, HUB_CIRCLE_STROKE, colors);
    if (style === "full") {
        ctx.fillStyle = colors.text;
        renderLabel(ctx, measureLabel(ctx, label, HUB_LABEL));
    }
}

/**
 * Strokes the current path. A translucent line is first laid over an opaque cover so it
 * hides the ink of the baked hub under the preview.
 */
function strokeCovering(ctx: Ctx, width: number, colors: HubColors): void {
    ctx.lineWidth = width + 0.5;
    if (colors.cover) {
        ctx.strokeStyle = colors.cover;
        ctx.stroke();
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = colors.line;
    ctx.stroke();
}

/**
 * Renders the interactive hub shown as a preview element, at the given opacity and notch
 * angle (negative turns it counterclockwise). The preview is drawn by each client, so the
 * disabled style follows that client's theme tokens.
 */
export async function renderHub(alpha: number, state: HubState, seed: number, notchDeg = 0): Promise<Blob> {
    await loadFonts();
    const canvas = new OffscreenCanvas(HUB_WIDTH * PIXEL_RATIO, HUB_HEIGHT * PIXEL_RATIO);
    const ctx = canvas.getContext("2d") as Ctx;
    ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
    ctx.translate(HUB_WIDTH / 2, HUB_CENTER_Y);
    ctx.globalAlpha = alpha;
    if (state === "disabled") {
        const elevated = token("--dd-surface-elevated", "#FFFFFF");
        drawHub(ctx, seed, "full", "Spin", {
            fill: elevated,
            line: token("--dd-border-subtle", "rgba(0,0,0,0.10)"),
            text: token("--dd-text-disabled", "rgba(0,0,0,0.30)"),
            cover: elevated,
        }, notchDeg);
    } else {
        drawHub(ctx, seed, "full", state === "reset" ? "Reset" : "Spin", ACTIVE_HUB, notchDeg);
    }
    return canvas.convertToBlob({ type: "image/png" });
}
