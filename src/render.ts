import { loadFonts } from "./fonts";
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

    if (hasResult) drawPill(ctx, items[winnerIndex].name);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { blob, width: WHEEL_SIZE, height };
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

/** The prototype's hand-drawn result pill: white, 2px ink border, lime dot, "Picked" and the name. */
function drawPill(ctx: Ctx, name: string): void {
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
    ctx.beginPath();
    ctx.arc(dotX, cy, PILL_DOT / 2 - PILL_BORDER / 2, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
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
function drawHub(ctx: Ctx, seed: number, style: "plain" | "full", label = "Spin", colors: HubColors = ACTIVE_HUB): void {
    ctx.lineJoin = "round";
    if (style === "full") {
        traceNotch(ctx, HUB_RADIUS);
        ctx.fillStyle = colors.fill;
        ctx.fill();
        strokeCovering(ctx, NOTCH_STROKE, colors);
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
 * Renders the interactive hub shown as a preview element, at the given opacity. The preview
 * is drawn by each client, so the disabled style follows that client's theme tokens.
 */
export async function renderHub(alpha: number, state: HubState, seed: number): Promise<Blob> {
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
        });
    } else {
        drawHub(ctx, seed, "full", state === "reset" ? "Reset" : "Spin");
    }
    return canvas.convertToBlob({ type: "image/png" });
}
