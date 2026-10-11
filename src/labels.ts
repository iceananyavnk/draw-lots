import { fontFamily } from "./fonts";

type Ctx = OffscreenCanvasRenderingContext2D;

/** A text size step: px and CSS weight. */
export type TextStep = { size: number; weight: number };

/** Measured text, ready to draw. All wheel text goes through measureLabel and renderLabel. */
export type LabelLayout = {
    text: string;
    font: string;
    width: number;
    /** Ink extents from the baseline, including Thai tone marks and lower vowels. */
    ascent: number;
    descent: number;
};

const ELLIPSIS = "…";

function fontString(step: TextStep): string {
    return `${step.weight} ${step.size}px ${fontFamily()}`;
}

export function measureLabel(ctx: Ctx, text: string, step: TextStep): LabelLayout {
    const font = fontString(step);
    ctx.font = font;
    const m = ctx.measureText(text);
    return {
        text,
        font,
        width: m.width,
        ascent: Math.max(0, m.actualBoundingBoxAscent),
        descent: Math.max(0, m.actualBoundingBoxDescent),
    };
}

/** Splits into user-perceived characters so a Thai base letter keeps its marks. */
function graphemes(text: string): string[] {
    const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, opts?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
    if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
    return Array.from(text);
}

/** Shortens text with an ellipsis until it fits maxWidth at the given step. */
export function truncateLabel(ctx: Ctx, text: string, step: TextStep, maxWidth: number): LabelLayout {
    const full = measureLabel(ctx, text, step);
    if (full.width <= maxWidth) return full;
    const parts = graphemes(text);
    let lo = 0;
    let hi = parts.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureLabel(ctx, parts.slice(0, mid).join("").trimEnd() + ELLIPSIS, step).width <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return measureLabel(ctx, parts.slice(0, lo).join("").trimEnd() + ELLIPSIS, step);
}

/**
 * Picks the largest step whose text fits within maxWidth along the radius and whose ink
 * height fits maxThickness across it; truncates at the smallest step otherwise.
 */
export function fitLabel(ctx: Ctx, text: string, steps: TextStep[], maxWidth: number, maxThickness: number): LabelLayout {
    for (const step of steps) {
        const layout = measureLabel(ctx, text, step);
        if (layout.width <= maxWidth && layout.ascent + layout.descent <= maxThickness) return layout;
    }
    return truncateLabel(ctx, text, steps[steps.length - 1], maxWidth);
}

/**
 * Draws a label with its ink box centered on the current origin, reading along +x.
 * The caller sets the transform (position, radial rotation, flip) and fill style.
 */
export function renderLabel(ctx: Ctx, layout: LabelLayout, align: "center" | "left" = "center"): void {
    ctx.font = layout.font;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(layout.text, 0, (layout.ascent - layout.descent) / 2);
}
