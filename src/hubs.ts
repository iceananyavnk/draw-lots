import { blobToDataUrl } from "./base64";
import { call, generateId, sleep, unwrap } from "./host";
import { log } from "./log";
import { discScale, hubRectFor, type HubState, type Rect } from "./model";
import { renderHub } from "./render";
import { tickTimes, type SpinSchedule } from "./spin-schedule";

/**
 * The interactive hub is a local, hit-testable preview element drawn by every client
 * that runs the extension. It is never committed, so it has no undo history, cannot be
 * orphaned, and pressing it does not change the selection. Preview elements cannot be
 * images, so it is a component whose image child is the rendered hub.
 */

const FADE_ALPHAS = [0.35, 0.7, 1];
const FADE_STEP_MS = 50;

/** What a hub looks like: its state and the wheel's wobble seed. */
export type HubLook = { state: HubState; seed: number };

type Hub = { discId: string; elementId: string; previewId: string; rect: Rect; look: HubLook };

const sameLook = (a: HubLook, b: HubLook) => a.state === b.state && a.seed === b.seed;

const hubs = new Map<string, Hub>();
const discByHubElement = new Map<string, string>();
/** Discs whose hub is hidden while they are dragged or resized. */
const suppressed = new Set<string>();
const creating = new Map<string, Promise<void>>();
const frames = new Map<string, Promise<string[]>>();

function hubFrames(look: HubLook): Promise<string[]> {
    const key = `${look.seed}:${look.state}`;
    let all = frames.get(key);
    if (!all) {
        all = Promise.all(FADE_ALPHAS.map(async (alpha) => blobToDataUrl(await renderHub(alpha, look.state, look.seed))));
        frames.set(key, all);
    }
    return all;
}

async function fullFrame(look: HubLook): Promise<string> {
    const all = await hubFrames(look);
    return all[all.length - 1];
}

/** Drops cached hub images, e.g. after a theme change; shown hubs are redrawn. */
export async function redrawHubs(): Promise<void> {
    frames.clear();
    for (const hub of hubs.values()) {
        await call({ type: "command:scene:update-drawdy-preview-elements", req: { elements: [schema(hub.elementId, hub.rect, await fullFrame(hub.look))] } });
    }
}

/** The hub preview for a disc; `lift` raises it, in wheel units, for the landing bounce. */
function schema(elementId: string, discRect: Rect, src: string, lift = 0) {
    const r = hubRectFor(discRect);
    return {
        type: "component" as const,
        drawdyElementId: elementId,
        ...r,
        y: r.y - lift * discScale(discRect),
        schema: {
            type: "image" as const,
            child: src,
            styles: { width: [r.width, "px"] as [number, "px"], height: [r.height, "px"] as [number, "px"], cursor: "pointer" as const },
        },
    };
}

export function discForHubElement(elementId: string): string | undefined {
    return discByHubElement.get(elementId);
}

async function create(discId: string, discRect: Rect, look: HubLook, fade: boolean): Promise<void> {
    const all = await hubFrames(look);
    const elementId = generateId();
    const { previewId } = unwrap(
        await call({
            type: "command:scene:create-drawdy-preview-elements",
            req: { elements: [schema(elementId, discRect, fade ? all[0] : all[all.length - 1])], hitTestable: true },
        })
    );
    const hub: Hub = { discId, elementId, previewId, rect: discRect, look };
    hubs.set(discId, hub);
    discByHubElement.set(elementId, discId);
    // The fade runs on its own so other hubs are not held back while it plays.
    if (fade) void fadeIn(hub, all.slice(1));
}

async function fadeIn(hub: Hub, steps: string[]): Promise<void> {
    for (const src of steps) {
        await sleep(FADE_STEP_MS);
        if (hubs.get(hub.discId) !== hub) return;
        await call({ type: "command:scene:update-drawdy-preview-elements", req: { elements: [schema(hub.elementId, hub.rect, src)] } });
    }
}

export async function removeHub(discId: string): Promise<void> {
    const hub = hubs.get(discId);
    if (!hub) return;
    hubs.delete(discId);
    discByHubElement.delete(hub.elementId);
    await call({ type: "command:scene:delete-drawdy-preview-elements", req: { previewIds: [hub.previewId] } });
}

/** Shows the hub for a disc, or moves or restyles it if it is already shown. */
export async function showHub(discId: string, discRect: Rect, look: HubLook, fade = false): Promise<void> {
    if (suppressed.has(discId)) return;
    const pending = creating.get(discId);
    if (pending) await pending;
    const hub = hubs.get(discId);
    if (!hub) {
        const work = create(discId, discRect, look, fade).finally(() => creating.delete(discId));
        creating.set(discId, work);
        return work;
    }
    if (sameRect(hub.rect, discRect) && sameLook(hub.look, look)) return;
    hub.rect = discRect;
    hub.look = look;
    await call({ type: "command:scene:update-drawdy-preview-elements", req: { elements: [schema(hub.elementId, discRect, await fullFrame(look))] } });
}

/** Hides the hub until releaseHub, e.g. for the length of a drag or resize. */
export async function suppressHub(discId: string): Promise<void> {
    suppressed.add(discId);
    await removeHub(discId);
}

export async function releaseHub(discId: string, discRect: Rect | null, look: HubLook): Promise<void> {
    suppressed.delete(discId);
    if (discRect) await showHub(discId, discRect, look, true);
}

export function isSuppressed(discId: string): boolean {
    return suppressed.has(discId);
}

export function hubLookOf(discId: string): HubLook | undefined {
    return hubs.get(discId)?.look;
}

/** Hands the hub of a disc being swapped to its replacement without hiding it. */
export async function rekeyHub(fromDiscId: string, toDiscId: string, discRect: Rect, look: HubLook): Promise<void> {
    const hub = hubs.get(fromDiscId);
    if (!hub) return showHub(toDiscId, discRect, look);
    hubs.delete(fromDiscId);
    hub.discId = toDiscId;
    hubs.set(toDiscId, hub);
    discByHubElement.set(hub.elementId, toDiscId);
    if (sameRect(hub.rect, discRect) && sameLook(hub.look, look)) return;
    hub.rect = discRect;
    hub.look = look;
    await call({ type: "command:scene:update-drawdy-preview-elements", req: { elements: [schema(hub.elementId, discRect, await fullFrame(look))] } });
}

/** Makes the set of shown hubs match the active discs. */
export async function syncHubs(active: { id: string; rect: Rect; look: HubLook }[], keep: (discId: string) => boolean): Promise<void> {
    const wanted = new Map(active.map((d) => [d.id, d]));
    for (const discId of [...hubs.keys()]) {
        if (!wanted.has(discId) && !keep(discId)) await removeHub(discId);
    }
    for (const [discId, d] of wanted) {
        await showHub(discId, d.rect, d.look, !hubs.has(discId));
    }
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
function sameRect(a: Rect, b: Rect): boolean {
    return near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}

// ---------------------------------------------------------------------------
// Spin animation: the notch wiggles at every tick and the hub bounces on landing

/** Notch angles pre-rendered for the wiggle; 0 is the resting hub. */
const WIGGLE_ANGLES = [0, -6, -11, -16];
/** The prototype's tick keyframes: 0 deg, -16 deg at 35 %, back to 0 at 110 ms, each step ease-out. */
const WIGGLE_MS = 110;
const WIGGLE_PEAK_AT = 0.35;
const WIGGLE_PEAK_DEG = -16;
/** The prototype's land keyframes: up 5 at 40 %, back down at 420 ms, each step cubic-bezier(.34,1.56,.64,1). */
const BOUNCE_MS = 420;
const BOUNCE_PEAK_AT = 0.4;
const BOUNCE_LIFT = 5;
const FRAME_MS = 16;

let reducedMotion = false;

/** Set from the panel, which can read prefers-reduced-motion; the worker cannot. */
export function setReducedMotion(value: boolean): void {
    reducedMotion = value;
}

const wiggleFrames = new Map<string, Promise<Map<number, string>>>();

/** Wiggle frames for a look, rendered once and reused for every spin of that wheel. */
function wiggleFramesFor(look: HubLook): Promise<Map<number, string>> {
    const key = `${look.seed}:${look.state}`;
    let all = wiggleFrames.get(key);
    if (!all) {
        all = (async () => {
            const byAngle = new Map<number, string>();
            for (const angle of WIGGLE_ANGLES) {
                byAngle.set(angle, angle === 0 ? await fullFrame(look) : await blobToDataUrl(await renderHub(1, look.state, look.seed, angle)));
            }
            return byAngle;
        })();
        wiggleFrames.set(key, all);
    }
    return all;
}

/** y(x) of a CSS cubic-bezier(x1, y1, x2, y2) timing function. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
    const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
    return (x) => {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2;
            if (at(x1, x2, mid) < x) lo = mid;
            else hi = mid;
        }
        return at(y1, y2, (lo + hi) / 2);
    };
}

const easeOut = cubicBezier(0, 0, 0.58, 1);
const overshoot = cubicBezier(0.34, 1.56, 0.64, 1);

/** Notch angle t ms into a wiggle, snapped to the nearest pre-rendered frame. */
function wiggleAngle(t: number): number {
    const peak = WIGGLE_MS * WIGGLE_PEAK_AT;
    const deg = t < peak ? WIGGLE_PEAK_DEG * easeOut(t / peak) : WIGGLE_PEAK_DEG * (1 - easeOut((t - peak) / (WIGGLE_MS - peak)));
    return WIGGLE_ANGLES.reduce((best, a) => (Math.abs(a - deg) < Math.abs(best - deg) ? a : best));
}

/** Hub lift t ms into the landing bounce, overshooting like the prototype. */
function bounceLift(t: number): number {
    const peak = BOUNCE_MS * BOUNCE_PEAK_AT;
    const lift = t < peak ? BOUNCE_LIFT * overshoot(t / peak) : BOUNCE_LIFT * (1 - overshoot((t - peak) / (BOUNCE_MS - peak)));
    return Math.round(lift * 4) / 4;
}

/**
 * Animates the hub of a spinning disc from the spin's schedule. `t0` is the spin's start on
 * performance.now(). One update is in flight at a time: when the host is slower than the
 * animation, frames in between are dropped and the next update jumps to the current pose,
 * so the hub never lags behind the wheel.
 */
export async function animateSpin(discId: string, schedule: SpinSchedule, t0: number): Promise<void> {
    const hub = hubs.get(discId);
    if (!hub || reducedMotion) return;
    const ticks = tickTimes(schedule);
    const look = hub.look;
    const frames = await wiggleFramesFor(look);
    const end = schedule.durationMs + BOUNCE_MS;
    let shown = { angle: 0, lift: 0 };
    let inFlight = false;
    let tickIndex = 0;
    let updates = 0;
    let dropped = 0;
    let wiggles = 0;
    let lastWiggleAt = -1;
    let updateMs = 0;
    let maxUpdateMs = 0;

    for (;;) {
        const now = performance.now() - t0;
        if (now > end || hubs.get(hub.discId) !== hub) break;
        while (tickIndex + 1 < ticks.length && ticks[tickIndex + 1] <= now) tickIndex++;
        const tick = ticks[tickIndex];
        const sinceTick = tick !== undefined && tick <= now ? now - tick : Infinity;
        const angle = sinceTick < WIGGLE_MS ? wiggleAngle(sinceTick) : 0;
        if (sinceTick < WIGGLE_MS && tick !== lastWiggleAt) {
            lastWiggleAt = tick;
            wiggles++;
        }
        const lift = now >= schedule.durationMs ? bounceLift(now - schedule.durationMs) : 0;

        if (angle !== shown.angle || lift !== shown.lift) {
            if (inFlight) {
                dropped++;
            } else {
                inFlight = true;
                shown = { angle, lift };
                const src = hub.look.state === look.state ? frames.get(angle) ?? (await fullFrame(hub.look)) : await fullFrame(hub.look);
                const sentAt = performance.now();
                void call({ type: "command:scene:update-drawdy-preview-elements", req: { elements: [schema(hub.elementId, hub.rect, src, lift)] } }).finally(() => {
                    const took = performance.now() - sentAt;
                    updateMs += took;
                    maxUpdateMs = Math.max(maxUpdateMs, took);
                    updates++;
                    inFlight = false;
                });
            }
        }
        await sleep(FRAME_MS);
    }

    // Settle on the resting hub of whatever look the disc has now (the result may have changed it).
    if (hubs.get(hub.discId) === hub) {
        await call({ type: "command:scene:update-drawdy-preview-elements", req: { elements: [schema(hub.elementId, hub.rect, await fullFrame(hub.look))] } });
    }
    const seconds = end / 1000;
    log("hub animation", {
        ticks: ticks.length,
        wiggles,
        updates,
        dropped,
        updatesPerSecond: Number((updates / seconds).toFixed(1)),
        avgUpdateMs: updates ? Number((updateMs / updates).toFixed(1)) : 0,
        maxUpdateMs: Number(maxUpdateMs.toFixed(1)),
    });
}
