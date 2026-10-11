import { blobToDataUrl } from "./base64";
import { call, generateId, sleep, unwrap } from "./host";
import { hubRectFor, type HubState, type Rect } from "./model";
import { renderHub } from "./render";

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
