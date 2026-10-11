import { loadFonts } from "./fonts";
import { fitLabel, measureLabel, renderLabel, truncateLabel, type TextStep } from "./labels";
import {
    HUB_CENTER_Y,
    HUB_HEIGHT,
    HUB_RADIUS,
    HUB_WIDTH,
    NOTCH_HALF_WIDTH,
    NOTCH_HEIGHT,
    PILL_GAP,
    PILL_HEIGHT,
    PIXEL_RATIO,
    RESULT_HEIGHT,
    RIM_RADIUS,
    WHEEL_SIZE,
    normalizeDeg,
    type WheelItem,
} from "./model";

type Ctx = OffscreenCanvasRenderingContext2D;

/** The wheel is a board object with fixed colors, independent of the Drawdy theme. */
const WEDGE_COLORS = ["#33DBCB", "#FFC67D", "#87A3FA", "#B5A1FF", "#FFA1B9"];
const LAST_WEDGE_FALLBACK = "#FFC67D";
const WEDGE_TEXT = "#090909";
const ACCENT = "#C5F601";
const INK = "#090909";
const SEPARATOR = "#FFFFFF";
const SEPARATOR_WIDTH = 1.5;
const HUB_STROKE = 1.5;
const DIMMED_ALPHA = 0.35;
const WINNER_OUTLINE = 3;
const PILL_FILL = "#FFFFFF";
const PILL_BORDER = "rgba(0,0,0,0.12)";
const PILL_LABEL = "rgba(0,0,0,0.5)";
const PILL_NAME = "#090909";

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
const PILL_NAME_STEP: TextStep = { size: 13, weight: 600 };

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

function wedgePath(ctx: Ctx, start: number, end: number, radius: number): void {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, start, end);
    ctx.closePath();
}

export type DiscRenderInput = {
    items: WheelItem[];
    /** Clockwise rotation of the wedges. */
    rotationDeg: number;
    /** Rotation the label flips are chosen for; defaults to rotationDeg. A spinning image uses its final rotation. */
    labelDeg?: number;
    winnerIndex: number | null;
};

/**
 * Renders the disc. Wedge i spans [i, i + 1) * wedgeAngle clockwise from 12 o'clock
 * before rotation. Without a result the hub is baked in as a plain circle, which reads
 * as a wheel without the extension and can rotate unseen under the preview hub. With a
 * result the full hub, notch and pill are baked in and the canvas grows downward for
 * the pill, keeping the wheel in the top WHEEL_SIZE square.
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

    const count = Math.max(items.length, 1);
    const wedgeAngle = (2 * Math.PI) / count;
    const colors = wedgeColors(count);
    const top = -Math.PI / 2;
    const midRadius = (RIM_RADIUS + HUB_RADIUS) / 2;
    const maxWidth = RIM_RADIUS - HUB_RADIUS - TEXT_PADDING;
    const maxThickness = 0.6 * 2 * midRadius * Math.sin(Math.min(wedgeAngle, Math.PI) / 2);

    ctx.save();
    ctx.translate(WHEEL_SIZE / 2, WHEEL_SIZE / 2);
    ctx.rotate((rotationDeg * Math.PI) / 180);

    for (let i = 0; i < count; i++) {
        const start = top + i * wedgeAngle;
        const dimmed = hasResult && i !== winnerIndex;
        // Dimmed wedges are pre-mixed with white and stay opaque, so whichever disc of a stack
        // is drawn on top fully hides the wedges of the discs below it.
        ctx.globalAlpha = 1;
        wedgePath(ctx, start, start + wedgeAngle, RIM_RADIUS);
        ctx.fillStyle = dimmed ? mixWithWhite(colors[i], DIMMED_ALPHA) : colors[i];
        ctx.fill();
        ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;

        const item = items[i];
        if (!item) continue;
        const layout = fitLabel(ctx, item.name, WEDGE_STEPS, maxWidth, maxThickness);
        ctx.save();
        ctx.rotate(start + wedgeAngle / 2);
        ctx.translate(midRadius, 0);
        if (isLeftHalf(i, count, labelDeg)) ctx.rotate(Math.PI);
        ctx.fillStyle = WEDGE_TEXT;
        renderLabel(ctx, layout);
        ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (count > 1) {
        ctx.strokeStyle = SEPARATOR;
        ctx.lineWidth = SEPARATOR_WIDTH;
        ctx.lineCap = "butt";
        for (let i = 0; i < count; i++) {
            const angle = top + i * wedgeAngle;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(angle) * RIM_RADIUS, Math.sin(angle) * RIM_RADIUS);
            ctx.stroke();
        }
    }

    if (hasResult) {
        // Stroke at double width clipped to the wedge so the full outline sits inside it.
        const start = top + winnerIndex * wedgeAngle;
        ctx.save();
        wedgePath(ctx, start, start + wedgeAngle, RIM_RADIUS);
        ctx.clip();
        wedgePath(ctx, start, start + wedgeAngle, RIM_RADIUS);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = WINNER_OUTLINE * 2;
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.restore();
    }
    ctx.restore();

    ctx.save();
    ctx.translate(WHEEL_SIZE / 2, WHEEL_SIZE / 2);
    drawHub(ctx, hasResult ? "full" : "plain");
    ctx.restore();

    if (hasResult) drawPill(ctx, items[winnerIndex].name);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { blob, width: WHEEL_SIZE, height };
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

function drawPill(ctx: Ctx, name: string): void {
    const padX = 14;
    const gap = 6;
    const label = measureLabel(ctx, "Picked", PILL_LABEL_STEP);
    const maxNameWidth = WHEEL_SIZE - 2 * padX - label.width - gap - 2;
    const shown = truncateLabel(ctx, name, PILL_NAME_STEP, maxNameWidth);

    const width = padX * 2 + label.width + gap + shown.width;
    const x = (WHEEL_SIZE - width) / 2;
    const y = WHEEL_SIZE + PILL_GAP;
    const cy = y + PILL_HEIGHT / 2;

    roundRectPath(ctx, x + 0.5, y + 0.5, width - 1, PILL_HEIGHT - 1, (PILL_HEIGHT - 1) / 2);
    ctx.fillStyle = PILL_FILL;
    ctx.fill();
    ctx.strokeStyle = PILL_BORDER;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.translate(x + padX, cy);
    ctx.fillStyle = PILL_LABEL;
    renderLabel(ctx, label, "left");
    ctx.translate(label.width + gap, 0);
    ctx.fillStyle = PILL_NAME;
    renderLabel(ctx, shown, "left");
    ctx.restore();
}

const NOTCH_TIP_RADIUS = 3;
const NOTCH_FILLET_RADIUS = 2;
/** Where the notch edges would meet if extended into the hub, relative to the hub center. */
const NOTCH_BASE_Y = -HUB_RADIUS + 4;

type Point = { x: number; y: number };

/**
 * Right-side geometry of the notch outline: the sharp apex (placed so the rounded tip
 * keeps NOTCH_HEIGHT), and the fillet that blends the right edge into the hub circle.
 * The left side mirrors it.
 */
function notchGeometry(): { apex: Point; filletCenter: Point; edgeTangent: Point; hubTangent: Point } {
    const visibleTipY = -HUB_RADIUS - NOTCH_HEIGHT;
    // Rounding a corner of half-angle b with radius r moves the tip in by r / sin(b) - r.
    let apexY = visibleTipY;
    for (let i = 0; i < 4; i++) {
        const halfAngle = Math.atan2(NOTCH_HALF_WIDTH, NOTCH_BASE_Y - apexY);
        apexY = visibleTipY - (NOTCH_TIP_RADIUS / Math.sin(halfAngle) - NOTCH_TIP_RADIUS);
    }
    const apex = { x: 0, y: apexY };

    const len = Math.hypot(NOTCH_HALF_WIDTH, NOTCH_BASE_Y - apexY);
    const d = { x: NOTCH_HALF_WIDTH / len, y: (NOTCH_BASE_Y - apexY) / len };
    // Outward normal of the right edge.
    const n = { x: d.y, y: -d.x };
    const f = NOTCH_FILLET_RADIUS;
    // Fillet center: f away from the edge line, R + f from the hub center.
    const p = { x: apex.x + f * n.x, y: apex.y + f * n.y };
    const b = p.x * d.x + p.y * d.y;
    const c = p.x * p.x + p.y * p.y - (HUB_RADIUS + f) ** 2;
    const t = -b - Math.sqrt(b * b - c);
    const filletCenter = { x: p.x + t * d.x, y: p.y + t * d.y };
    const edgeTangent = { x: apex.x + t * d.x, y: apex.y + t * d.y };
    const k = HUB_RADIUS / (HUB_RADIUS + f);
    const hubTangent = { x: filletCenter.x * k, y: filletCenter.y * k };
    return { apex, filletCenter, edgeTangent, hubTangent };
}

/** One closed outline: hub circle, filleted notch base, rounded notch tip. */
function hubOutline(ctx: Ctx): void {
    const { apex, filletCenter: cr, edgeTangent: er, hubTangent: hr } = notchGeometry();
    const cl = { x: -cr.x, y: cr.y };
    const el = { x: -er.x, y: er.y };
    const hl = { x: -hr.x, y: hr.y };
    const angle = (from: Point, to: Point) => Math.atan2(to.y - from.y, to.x - from.x);

    ctx.beginPath();
    ctx.moveTo(er.x, er.y);
    ctx.arc(cr.x, cr.y, NOTCH_FILLET_RADIUS, angle(cr, er), angle(cr, hr), true);
    ctx.arc(0, 0, HUB_RADIUS, Math.atan2(hr.y, hr.x), Math.atan2(hl.y, hl.x) + 2 * Math.PI, false);
    ctx.arc(cl.x, cl.y, NOTCH_FILLET_RADIUS, angle(cl, hl), angle(cl, el), true);
    ctx.arcTo(apex.x, apex.y, er.x, er.y, NOTCH_TIP_RADIUS);
    ctx.closePath();
}

/**
 * Draws the hub centered on the current origin. "plain" is the lime circle alone;
 * "full" adds the notch and the "Spin" label.
 */
function drawHub(ctx: Ctx, style: "plain" | "full"): void {
    if (style === "full") {
        hubOutline(ctx);
    } else {
        ctx.beginPath();
        ctx.arc(0, 0, HUB_RADIUS, 0, Math.PI * 2);
    }
    ctx.fillStyle = ACCENT;
    ctx.fill();
    ctx.lineWidth = HUB_STROKE;
    ctx.strokeStyle = INK;
    ctx.lineJoin = "round";
    ctx.stroke();
    if (style === "full") {
        ctx.fillStyle = INK;
        renderLabel(ctx, measureLabel(ctx, "Spin", HUB_LABEL));
    }
}

/** Renders the interactive hub shown as a preview element, at the given opacity. */
export async function renderHub(alpha = 1): Promise<Blob> {
    await loadFonts();
    const canvas = new OffscreenCanvas(HUB_WIDTH * PIXEL_RATIO, HUB_HEIGHT * PIXEL_RATIO);
    const ctx = canvas.getContext("2d") as Ctx;
    ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
    ctx.translate(HUB_WIDTH / 2, HUB_CENTER_Y);
    ctx.globalAlpha = alpha;
    drawHub(ctx, "full");
    return canvas.convertToBlob({ type: "image/png" });
}
