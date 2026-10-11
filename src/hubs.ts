import { blobToDataUrl } from "./base64";
import { call, generateId, sleep, unwrap } from "./host";
import { hubRectFor, type Rect } from "./model";
import { renderHub } from "./render";

/**
 * The interactive hub is a local, hit-testable preview element drawn by every client
 * that runs the extension. It is never committed, so it has no undo history, cannot be
 * orphaned, and pressing it does not change the selection. Preview elements cannot be
 * images, so it is a component whose image child is the rendered hub.
 */

const FADE_ALPHAS = [0.35, 0.7, 1];
const FADE_STEP_MS = 50;

type Hub = { discId: string; elementId: string; previewId: string; rect: Rect };

const hubs = new Map<string, Hub>();
const discByHubElement = new Map<string, string>();
/** Discs whose hub is hidden while they are dragged or resized. */
const suppressed = new Set<string>();
const creating = new Map<string, Promise<void>>();
let frames: Promise<string[]> | null = null;

function hubFrames(): Promise<string[]> {
    frames ??= Promise.all(FADE_ALPHAS.map(async (alpha) => blobToDataUrl(await renderHub(alpha))));
    return frames;
}

function schema(elementId: string, discRect: Rect, src: string) {
    const r = hubRectFor(discRect);
    return {
        type: "component" as const,
        drawdyElementId: elementId,
        ...r,
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

async function create(discId: string, discRect: Rect, fade: boolean): Promise<void> {
    const all = await hubFrames();
    const elementId = generateId();
    const { previewId } = unwrap(
        await call({
            type: "command:scene:create-drawdy-preview-elements",
            req: { elements: [schema(elementId, discRect, fade ? all[0] : all[all.length - 1])], hitTestable: true },
        })
    );
    const hub: Hub = { discId, elementId, previewId, rect: discRect };
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

/** Shows the hub for a disc, or moves it if it is already shown. */
export async function showHub(discId: string, discRect: Rect, fade = false): Promise<void> {
    if (suppressed.has(discId)) return;
    const pending = creating.get(discId);
    if (pending) await pending;
    const hub = hubs.get(discId);
    if (!hub) {
        const work = create(discId, discRect, fade).finally(() => creating.delete(discId));
        creating.set(discId, work);
        return work;
    }
    if (sameRect(hub.rect, discRect)) return;
    hub.rect = discRect;
    const all = await hubFrames();
    await call({ type: "command:scene:update-drawdy-preview-elements", req: { elements: [schema(hub.elementId, discRect, all[all.length - 1])] } });
}

/** Hides the hub until releaseHub, e.g. for the length of a drag or resize. */
export async function suppressHub(discId: string): Promise<void> {
    suppressed.add(discId);
    await removeHub(discId);
}

export async function releaseHub(discId: string, discRect: Rect | null): Promise<void> {
    suppressed.delete(discId);
    if (discRect) await showHub(discId, discRect, true);
}

export function isSuppressed(discId: string): boolean {
    return suppressed.has(discId);
}

/** Hands the hub of a disc being swapped to its replacement without hiding it. */
export async function rekeyHub(fromDiscId: string, toDiscId: string, discRect: Rect): Promise<void> {
    const hub = hubs.get(fromDiscId);
    if (!hub) return showHub(toDiscId, discRect);
    hubs.delete(fromDiscId);
    hub.discId = toDiscId;
    hubs.set(toDiscId, hub);
    discByHubElement.set(hub.elementId, toDiscId);
    if (sameRect(hub.rect, discRect)) return;
    hub.rect = discRect;
    const all = await hubFrames();
    await call({ type: "command:scene:update-drawdy-preview-elements", req: { elements: [schema(hub.elementId, discRect, all[all.length - 1])] } });
}

/** Makes the set of shown hubs match the active discs. */
export async function syncHubs(active: { id: string; rect: Rect }[], keep: (discId: string) => boolean): Promise<void> {
    const wanted = new Map(active.map((d) => [d.id, d.rect]));
    for (const discId of [...hubs.keys()]) {
        if (!wanted.has(discId) && !keep(discId)) await removeHub(discId);
    }
    for (const [discId, rect] of wanted) {
        await showHub(discId, rect, !hubs.has(discId));
    }
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
function sameRect(a: Rect, b: Rect): boolean {
    return near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}
