import type { SubscribedDrawdyElement } from "@drawdy/driver-protocol";
import { call, generateId, sleep, unwrap } from "./host";
import { discForHubElement, isSuppressed, rekeyHub, releaseHub, removeHub, suppressHub, syncHubs } from "./hubs";
import {
    HUB_RADIUS,
    META_KEY,
    MIN_ITEMS,
    WHEEL_SIZE,
    discCenter,
    discScale,
    readMeta,
    type DiscMeta,
    type Rect,
    type WheelItem,
} from "./model";
import { cryptoRandom } from "./random";
import { isLeftHalf, renderDisc } from "./render";
import { pickSpin } from "./spin-math";
import { debug, error, log } from "./log";

const SPIN_DURATION_MS = 3500;
const FRAME_MS = 16;
/** Time given to a freshly added image to decode and paint before the image under it is removed. */
const SWAP_SETTLE_MS = 150;
/** Clicks on discs that appeared or were dragged this recently never start a spin. */
const CLICK_GUARD_MS = 500;
const REFRESH_DELAY_MS = 50;
const RESIZE_SETTLE_MS = 150;
const PLACEMENT_GAP = 40;
const STACK_EPSILON = 1;


type Disc = {
    id: string;
    meta: DiscMeta;
    rect: Rect;
    locked: boolean;
    frameId?: string;
    groupId?: string;
    /** Position in the scene order returned by Drawdy; higher is drawn later, on top. */
    z: number;
};

/** Disc ids this session has seen on the board; a new id carrying a known wheelId is a copy. */
const seen = new Set<string>();
const appearedAt = new Map<string, number>();
const movedAt = new Map<string, number>();
const lastRect = new Map<string, Rect>();
const wheelOfDisc = new Map<string, string>();
/** Selected element ids, plus ids deselected in the last moment (a delete clears the selection first). */
let selection = new Set<string>();
const recentlySelected = new Map<string, number>();
const SELECTION_GRACE_MS = 1000;
/** Disc ids this client added and has not yet classified. */
const ownAdds = new Set<string>();
/** Every top-left a wheel's discs have occupied this session, by wheelId. */
const knownSpots = new Map<string, { x: number; y: number }[]>();
/** Disc ids reported by elements-added or elements-replaced since the last refresh. */
const pendingAppeared = new Set<string>();
/** wheelIds with a spin in progress on this client. */
const spinning = new Set<string>();
let notify: (text: string) => void = () => {};

export function setNotifier(fn: (text: string) => void): void {
    notify = fn;
}

// ---------------------------------------------------------------------------
// Scene access

function rectOf(el: SubscribedDrawdyElement): Rect | null {
    if (el.x === undefined || el.y === undefined || el.width === undefined || el.height === undefined) return null;
    return { x: el.x, y: el.y, width: el.width, height: el.height };
}

async function queryBoard(): Promise<{ discs: Disc[]; legacyHubs: { id: string; locked: boolean }[] }> {
    const { drawdyElements } = unwrap(
        await call({
            type: "command:scene:get-drawdy-elements",
            req: { properties: ["meta", "x", "y", "width", "height", "locked", "frameId", "groupId"] },
        })
    );
    const discs: Disc[] = [];
    const legacyHubs: { id: string; locked: boolean }[] = [];
    for (const [z, el] of drawdyElements.entries()) {
        const meta = readMeta(el.meta);
        if (meta === "legacy-hub") {
            legacyHubs.push({ id: el.id, locked: el.locked === true });
            continue;
        }
        const rect = rectOf(el);
        if (!meta || !rect) continue;
        discs.push({ id: el.id, meta, rect, locked: el.locked === true, frameId: el.frameId, groupId: el.groupId, z });
    }
    return { discs, legacyHubs };
}

function noteAppeared(ids: string[]): void {
    const now = Date.now();
    for (const id of ids) appearedAt.set(id, now);
}

/** Records discs reported by elements-added or elements-replaced; the next refresh classifies them. */
export function discsAppeared(ids: string[]): void {
    noteAppeared(ids);
    ids.forEach((id) => pendingAppeared.add(id));
    scheduleRefresh();
}

function rememberSpot(wheelId: string, rect: Rect): void {
    const spots = knownSpots.get(wheelId) ?? [];
    if (!spots.some((p) => isStacked(p, rect))) spots.push({ x: rect.x, y: rect.y });
    knownSpots.set(wheelId, spots);
}

/** Removes elements, unlocking first where needed. */
async function removeElements(elements: { id: string; locked: boolean }[]): Promise<void> {
    if (elements.length === 0) return;
    const locked = elements.filter((el) => el.locked);
    if (locked.length > 0) {
        await call({
            type: "command:scene:update-drawdy-elements",
            req: { updates: locked.map((el) => ({ drawdyElementId: el.id, properties: { locked: false } })) },
        });
    }
    await call({ type: "command:scene:remove-drawdy-elements", req: { drawdyElementIds: elements.map((el) => el.id) } });
}

const isStacked = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < STACK_EPSILON && Math.abs(a.y - b.y) < STACK_EPSILON;

/**
 * The disc of a stack that owns the hub: the one drawn on top (latest in scene order),
 * then the most recently added or restored, then the highest version.
 */
function topOf(stack: Disc[]): Disc {
    return stack.reduce((a, b) => {
        if (a.z !== b.z) return b.z > a.z ? b : a;
        const ta = appearedAt.get(a.id) ?? 0;
        const tb = appearedAt.get(b.id) ?? 0;
        if (ta !== tb) return tb > ta ? b : a;
        return b.meta.version > a.meta.version ? b : a;
    });
}

/** Undo can leave several discs of one wheel stacked at one spot; only the top one shows a hub. */
function stackOwners(discs: Disc[]): Disc[] {
    return discs.filter((d) => {
        const stack = stackOf(d, discs);
        const owner = topOf([d, ...stack]);
        if (owner.id === d.id && stack.length > 0) {
            debug("stack", { owner: d.id, members: [d, ...stack].map((m) => ({ id: m.id, version: m.meta.version, z: m.z })) });
        }
        return owner.id === d.id;
    });
}

/**
 * Removes every disc of `wheelId` stacked at `spot` except `keepId`. Only called for user
 * actions (drag, resize, delete), never in response to undo, so it cannot loop with history.
 */
async function clearStackAt(wheelId: string, spot: { x: number; y: number }, keepId: string | null, discs: Disc[], action: string): Promise<void> {
    if (spinning.has(wheelId)) return;
    const others = discs.filter((d) => d.id !== keepId && d.meta.wheelId === wheelId && isStacked(d.rect, spot));
    if (others.length === 0) return;
    log("removing stacked discs on a user action", { action, keep: keepId, remove: others.map((d) => d.id) });
    for (const d of others) await removeHub(d.id);
    await removeElements(others);
}

function stackOf(disc: Disc, discs: Disc[]): Disc[] {
    return discs.filter((d) => d.id !== disc.id && d.meta.wheelId === disc.meta.wheelId && isStacked(d.rect, disc.rect));
}

// ---------------------------------------------------------------------------
// Board refresh: legacy cleanup, copies, hubs

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshChain: Promise<void> = Promise.resolve();
let firstRefresh = true;

let refreshRunning = false;
let refreshAgain = false;

/**
 * Refreshes at most REFRESH_DELAY_MS after the first change of a burst. The timer is not
 * reset by later events, so a long burst of undos cannot hold hubs back until it ends; a
 * change during a running refresh queues exactly one more.
 */
export function scheduleRefresh(): void {
    if (refreshTimer) return;
    if (refreshRunning) {
        refreshAgain = true;
        return;
    }
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshRunning = true;
        refreshChain = refreshChain
            .then(refresh)
            .catch((err) => error("refresh failed", { err }))
            .finally(() => {
                refreshRunning = false;
                if (refreshAgain) {
                    refreshAgain = false;
                    scheduleRefresh();
                }
            });
    }, REFRESH_DELAY_MS);
}

/** Runs a refresh right away, e.g. from activate. */
export function refreshNow(): Promise<void> {
    refreshChain = refreshChain.then(refresh);
    return refreshChain;
}

async function refresh(): Promise<void> {
    const { discs, legacyHubs } = await queryBoard();

    // Committed hubs from builds before the preview hub.
    if (legacyHubs.length > 0) {
        log("removing committed hubs from an earlier build", { ids: legacyHubs.map((h) => h.id) });
        await removeElements(legacyHubs);
    }

    if (firstRefresh) {
        firstRefresh = false;
        discs.forEach((d) => seen.add(d.id));
    } else {
        await classifyAppeared(discs);
    }

    for (const d of discs) {
        lastRect.set(d.id, d.rect);
        wheelOfDisc.set(d.id, d.meta.wheelId);
        rememberSpot(d.meta.wheelId, d.rect);
    }
    // Every disc gets exactly one hub, centred on it; spinning wheels manage their own.
    const shown = stackOwners(discs).filter((d) => !spinning.has(d.meta.wheelId) && !isSuppressed(d.id));
    const keepSpinning = (discId: string) => discs.some((d) => d.id === discId && spinning.has(d.meta.wheelId));
    await syncHubs(shown, keepSpinning);
}

type Decision = "own" | "restore" | "swap" | "new" | "copy";

/**
 * Classifies every disc that appeared since the last refresh and logs the decision. Only a
 * disc whose wheelId is already on the board at a different spot, and never at this spot, is
 * a copy (Duplicate, Paste, an insert from the library); it becomes its own wheel. Nothing
 * here moves a disc.
 */
async function classifyAppeared(discs: Disc[]): Promise<void> {
    const updates: { drawdyElementId: string; properties: { meta: Record<string, unknown> } }[] = [];
    for (const d of discs) {
        const reported = pendingAppeared.delete(d.id);
        const unseen = !seen.has(d.id);
        if (!reported && !unseen && !ownAdds.has(d.id)) continue;

        const others = discs.filter((o) => o.id !== d.id && o.meta.wheelId === d.meta.wheelId);
        const stackedUnder = others.filter((o) => isStacked(o.rect, d.rect));
        const wasHere = (knownSpots.get(d.meta.wheelId) ?? []).some((p) => isStacked(p, d.rect));
        let decision: Decision;
        let reason: string;
        if (ownAdds.delete(d.id)) {
            decision = "own";
            reason = "added by this client (new wheel or spin swap)";
        } else if (!unseen) {
            decision = "restore";
            reason = "id seen before this session (undo or redo)";
        } else if (others.length === 0) {
            decision = "new";
            reason = "no other disc of this wheel on the board";
        } else if (stackedUnder.length > 0) {
            const lower = stackedUnder.some((o) => o.meta.version < d.meta.version);
            decision = lower ? "swap" : "restore";
            reason = lower ? "on top of a lower version of the same wheel (a spin)" : "at the spot of another disc of the same wheel";
        } else if (wasHere) {
            decision = "restore";
            reason = "at a spot this wheel occupied before";
        } else {
            decision = "copy";
            reason = "same wheelId exists at a different spot";
        }
        seen.add(d.id);
        log("disc appeared", { id: d.id, wheelId: d.meta.wheelId, version: d.meta.version, x: d.rect.x, y: d.rect.y, decision, reason });

        if (decision === "copy") {
            const wheelId = generateId();
            log("copy gets a new wheelId", { id: d.id, from: d.meta.wheelId, to: wheelId });
            d.meta = { ...d.meta, wheelId };
            updates.push({ drawdyElementId: d.id, properties: { meta: { [META_KEY]: d.meta } } });
        }
    }
    pendingAppeared.clear();
    if (updates.length > 0) {
        await call({ type: "command:scene:update-drawdy-elements", req: { updates } });
    }
}

// ---------------------------------------------------------------------------
// Adding

function overlaps(a: Rect, b: Rect, gap: number): boolean {
    return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

function discElement(id: string, rect: Rect, blob: Blob, meta: DiscMeta, frameId?: string) {
    return { type: "image" as const, drawdyElementId: id, ...rect, blob, meta: { [META_KEY]: meta }, ...(frameId ? { frameId } : {}) };
}

/** Places a new wheel at the viewport center, shifted right past any wheel it would overlap. */
export async function addWheel(items: WheelItem[]): Promise<void> {
    const { rect: viewport } = unwrap(await call({ type: "command:camera:get-viewport-rect" }));
    const { discs } = await queryBoard();

    const meta: DiscMeta = { role: "disc", wheelId: generateId(), version: 1, items, rotationDeg: 0, winnerIndex: null };
    const image = await renderDisc(meta);
    const rect: Rect = {
        x: viewport.x + viewport.width / 2 - WHEEL_SIZE / 2,
        y: viewport.y + viewport.height / 2 - WHEEL_SIZE / 2,
        width: image.width,
        height: image.height,
    };
    for (let i = 0; i < 50 && discs.some((d) => overlaps(rect, d.rect, PLACEMENT_GAP / 2)); i++) {
        rect.x += WHEEL_SIZE + PLACEMENT_GAP;
    }

    const id = generateId();
    ownAdds.add(id);
    noteAppeared([id]);
    unwrap(await call({ type: "command:scene:add-drawdy-elements", req: { elements: [discElement(id, rect, image.blob, meta)] } }));
    log("added wheel", { wheelId: meta.wheelId, discId: id, rect });
    scheduleRefresh();
}

/**
 * Adds a disc image rendered from `meta` at the rect of `like`, in the same frame and
 * with the same lock state. The hub moves over to it.
 */
async function addReplacement(like: Disc, meta: DiscMeta): Promise<Disc> {
    const scale = discScale(like.rect);
    const image = await renderDisc(meta);
    const rect: Rect = { x: like.rect.x, y: like.rect.y, width: image.width * scale, height: image.height * scale };
    const id = generateId();
    ownAdds.add(id);
    noteAppeared([id]);
    unwrap(await call({ type: "command:scene:add-drawdy-elements", req: { elements: [discElement(id, rect, image.blob, meta, like.frameId)] } }));
    if (like.locked) {
        await call({ type: "command:scene:update-drawdy-elements", req: { updates: [{ drawdyElementId: id, properties: { locked: true } }] } });
    }
    await rekeyHub(like.id, id, rect);
    // A freshly added element is drawn on top of everything.
    return { id, meta, rect, locked: like.locked, frameId: like.frameId, z: Number.MAX_SAFE_INTEGER };
}

// ---------------------------------------------------------------------------
// Spinning

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

function flipsDiffer(count: number, fromDeg: number, toDeg: number): boolean {
    for (let i = 0; i < count; i++) {
        if (isLeftHalf(i, count, fromDeg) !== isLeftHalf(i, count, toDeg)) return true;
    }
    return false;
}

export type SpinTrigger = { hubElementId: string; cursor: { x: number; y: number } };

/** Starts a spin from a click on a preview hub. Every accepted or ignored trigger is logged. */
export async function spinFromClick(trigger: SpinTrigger): Promise<void> {
    const discId = discForHubElement(trigger.hubElementId);
    if (!discId) return;
    const now = Date.now();
    const appeared = now - (appearedAt.get(discId) ?? 0);
    if (appeared < CLICK_GUARD_MS) {
        log("spin ignored: disc appeared recently", { msAgo: appeared, ...trigger });
        return;
    }
    const moved = now - (movedAt.get(discId) ?? 0);
    if (moved < CLICK_GUARD_MS) {
        log("spin ignored: disc was dragged recently", { msAgo: moved, ...trigger });
        return;
    }

    const { discs } = await queryBoard();
    const disc = discs.find((d) => d.id === discId);
    if (!disc) {
        log("spin ignored: disc no longer on the board", { discId });
        return;
    }
    const wheelId = disc.meta.wheelId;
    if (spinning.has(wheelId)) {
        log("spin ignored: already spinning", { wheelId });
        return;
    }
    const c = discCenter(disc.rect);
    if (Math.hypot(trigger.cursor.x - c.x, trigger.cursor.y - c.y) > (HUB_RADIUS + 2) * discScale(disc.rect)) {
        log("spin ignored: click outside the hub circle", trigger);
        return;
    }
    if (disc.meta.items.length < MIN_ITEMS) {
        log("spin ignored: too few items", { min: MIN_ITEMS, items: disc.meta.items.length });
        return;
    }
    if (disc.groupId) {
        log("spin ignored: grouped wheels cannot be previewed", { groupId: disc.groupId });
        notify("Ungroup the wheel to spin it.");
        return;
    }

    spinning.add(wheelId);
    let previewing = false;
    try {
        log("spin trigger: scene:click on preview hub", { wheelId, discId, cursor: trigger.cursor });
        await call({ type: "command:scene:clear-selection" });

        const count = disc.meta.items.length;
        const startDeg = disc.meta.rotationDeg;
        const target = pickSpin(count, startDeg, cryptoRandom);
        log("spin target", {
            winnerIndex: target.winnerIndex,
            winner: disc.meta.items[target.winnerIndex]?.name,
            offset: Number(target.offset.toFixed(4)),
            turns: target.turns,
            startDeg: Number(startDeg.toFixed(2)),
            finalDeg: Number(target.finalDeg.toFixed(2)),
            deltaDeg: Number(target.deltaDeg.toFixed(2)),
        });
        const stack = stackOf(disc, discs);

        // The image that turns must already have its labels flipped for the final rotation, and
        // a result image cannot turn (it is taller than the wheel). Otherwise the disc turns as is.
        const needsSpinImage =
            disc.meta.winnerIndex !== null || flipsDiffer(count, disc.meta.labelDeg ?? startDeg, target.finalDeg);
        let turning = disc;
        let leftovers: Disc[] = stack;
        if (needsSpinImage) {
            turning = await addReplacement(disc, {
                ...disc.meta,
                winnerIndex: null,
                labelDeg: target.finalDeg,
                version: disc.meta.version + 1,
            });
            leftovers = [disc, ...stack];
        }

        const { began } = unwrap(await call({ type: "command:scene:begin-preview", req: { drawdyElementIds: [turning.id] } }));
        if (!began.includes(turning.id)) {
            log("spin aborted: begin-preview rejected the disc", { began });
            if (began.length > 0) await call({ type: "command:scene:end-preview", req: {} });
            return;
        }
        previewing = true;

        // The image under the turning one (and its pill) goes once the turning image has painted.
        const clearOld = sleep(SWAP_SETTLE_MS).then(() => removeElements(leftovers));

        const t0 = performance.now();
        for (;;) {
            const frameStart = performance.now();
            const t = Math.min(1, (frameStart - t0) / SPIN_DURATION_MS);
            const rotation = (target.deltaDeg * easeOutQuart(t) * Math.PI) / 180;
            await call({
                type: "command:scene:preview-transforms",
                req: { previews: [{ drawdyElementId: turning.id, transform: { x: 0, y: 0, scale: 1, rotation } }] },
            });
            if (t >= 1) break;
            await sleep(Math.max(0, FRAME_MS - (performance.now() - frameStart)));
        }
        await clearOld;

        const result = await addReplacement(turning, {
            ...turning.meta,
            rotationDeg: target.finalDeg,
            labelDeg: undefined,
            winnerIndex: target.winnerIndex,
            version: turning.meta.version + 1,
        });
        await sleep(SWAP_SETTLE_MS);
        previewing = false;
        await call({ type: "command:scene:end-preview", req: {} });
        // One removal: the turning image plus any disc of this wheel an undo restored at this spot during the spin.
        const { discs: now } = await queryBoard();
        const restored = stackOf(result, now).filter((d) => d.id !== turning.id);
        if (restored.length > 0) log("removing discs restored during the spin", { ids: restored.map((d) => d.id) });
        await removeElements([turning, ...restored]);
    } finally {
        if (previewing) await call({ type: "command:scene:end-preview", req: {} });
        spinning.delete(wheelId);
        scheduleRefresh();
    }
}

// ---------------------------------------------------------------------------
// Drag and resize: the hub hides and fades back in when the disc settles

const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Discs whose hub is hidden for the current drag. */
let draggedDiscs: string[] = [];

/**
 * Hides the hub of every disc that moves with this drag: the disc itself, a disc inside a
 * dragged frame, or a disc in the same group as a dragged element.
 */
export async function onDragStart(ids: readonly string[]): Promise<void> {
    draggedDiscs = [];
    if (ids.length === 0) return;
    const dragged = new Set(ids);
    const { discs } = await queryBoard();
    const { drawdyElements } = unwrap(
        await call({ type: "command:scene:get-drawdy-elements", req: { properties: ["groupId"], drawdyElementIds: [...ids] } })
    );
    const groups = new Set(drawdyElements.map((el) => el.groupId).filter((g): g is string => !!g));
    const moving = discs.filter(
        (d) => dragged.has(d.id) || (d.frameId !== undefined && dragged.has(d.frameId)) || (d.groupId !== undefined && groups.has(d.groupId))
    );
    const movable = moving.filter((d) => !spinning.has(d.meta.wheelId));

    // A stack would come apart when dragged: keep the top dragged disc of each stack, remove the rest.
    const keep = new Map<string, Disc>();
    for (const d of movable) {
        const key = `${d.meta.wheelId}@${Math.round(d.rect.x)},${Math.round(d.rect.y)}`;
        const current = keep.get(key);
        keep.set(key, current ? topOf([current, d]) : d);
    }
    for (const d of keep.values()) await clearStackAt(d.meta.wheelId, d.rect, d.id, discs, "drag");

    draggedDiscs = [...keep.values()].map((d) => d.id);
    for (const id of draggedDiscs) await suppressHub(id);
}

export function onDragging(): void {
    const now = Date.now();
    for (const id of draggedDiscs) movedAt.set(id, now);
}

/** Shows the hidden hubs again, faded in and centred on each disc's new position. */
export async function onDragEnd(): Promise<void> {
    const hidden = draggedDiscs;
    draggedDiscs = [];
    if (hidden.length === 0) return;
    const { rects } = unwrap(await call({ type: "command:scene:element-rects", req: { drawdyElementIds: hidden } }));
    for (const id of hidden) {
        const rect = rects.find((r) => r.drawdyElementId === id)?.rect ?? null;
        if (rect) lastRect.set(id, rect);
        await releaseHub(id, rect);
    }
    scheduleRefresh();
}

/** A disc whose size changed outside a drag is being resized: hide the hub until updates stop. */
export async function onDiscUpdated(el: SubscribedDrawdyElement): Promise<void> {
    if (!seen.has(el.id)) {
        scheduleRefresh();
        return;
    }
    const rect = rectOf(el);
    if (!rect) return;
    const previous = lastRect.get(el.id);
    lastRect.set(el.id, rect);
    const resized = previous !== undefined && (Math.abs(previous.width - rect.width) > 0.5 || Math.abs(previous.height - rect.height) > 0.5);
    if (!resized && !resizeTimers.has(el.id)) {
        const moved = previous !== undefined && (Math.abs(previous.x - rect.x) > 0.5 || Math.abs(previous.y - rect.y) > 0.5);
        if (moved && !draggedDiscs.includes(el.id)) {
            debug("disc moved outside a drag (e.g. undo of an earlier move)", { id: el.id, from: { x: previous.x, y: previous.y }, to: { x: rect.x, y: rect.y } });
        }
        scheduleRefresh();
        return;
    }
    if (!resizeTimers.has(el.id)) {
        await suppressHub(el.id);
        const wheelId = wheelOfDisc.get(el.id);
        if (wheelId && previous) await clearStackAt(wheelId, previous, el.id, (await queryBoard()).discs, "resize");
    }
    clearTimeout(resizeTimers.get(el.id));
    resizeTimers.set(
        el.id,
        setTimeout(() => {
            resizeTimers.delete(el.id);
            void releaseHub(el.id, lastRect.get(el.id) ?? null).then(scheduleRefresh);
        }, RESIZE_SETTLE_MS)
    );
}

/**
 * A disc was removed. If it was selected, the user deleted it, so the rest of its stack goes
 * too. A removal by undo or redo does not involve the selection and is left alone.
 */
export async function onDiscRemoved(id: string): Promise<void> {
    const rect = lastRect.get(id);
    const wheelId = wheelOfDisc.get(id);
    lastRect.delete(id);
    await removeHub(id);
    if (rect && wheelId && wasSelected(id)) {
        await clearStackAt(wheelId, rect, null, (await queryBoard()).discs, "delete");
    }
    scheduleRefresh();
}

export function onSelection(ids: readonly string[]): void {
    const now = Date.now();
    for (const id of selection) if (!ids.includes(id)) recentlySelected.set(id, now);
    selection = new Set(ids);
}

function wasSelected(id: string): boolean {
    if (selection.has(id)) return true;
    const at = recentlySelected.get(id);
    return at !== undefined && Date.now() - at < SELECTION_GRACE_MS;
}

/** True for a disc, a legacy hub, or an id this session knows as a disc. */
export function isWheelElement(el: SubscribedDrawdyElement): boolean {
    return readMeta(el.meta) !== null || seen.has(el.id);
}
