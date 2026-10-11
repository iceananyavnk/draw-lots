import { UnauthorizedError, call, generateId, styling, tokens } from "./host";
import { setReducedMotion } from "./hubs";
import { error, log } from "./log";
import { seedFrom } from "./hand";
import { IMAGE_ITEM_LIMIT, MAX_ITEMS, MIN_ITEMS, isImageDataUrl, visibleItems, type DiscMeta, type WheelItem } from "./model";
import { PANEL_HTML } from "./panel-html";
import {
    addWheel,
    isBusy,
    isOwnSelectionChange,
    onBoardChanged,
    onSelectionChanged,
    onSpinEvent,
    readWheel,
    selectedWheelIds,
    writeWheel,
    type SpinEvent,
    type WheelView,
} from "./wheels";

export const WEBVIEW_ID = "draw-lots:panel";
const EDIT_DEBOUNCE_MS = 400;
const MAX_NAME_LENGTH = 60;

type Mode = "draft" | "edit";

/** A list row as the panel sees it; the image itself is sent once, by key. */
type PanelItem = { id: string; name: string; imageKey: string | null };

type PanelState = {
    mode: Mode;
    items: PanelItem[];
    /** Items the wheel draws; the panel notes that images only show with IMAGE_ITEM_LIMIT or fewer. */
    visibleCount: number;
    imageLimit: number;
    picked: string[];
    removePicked: boolean;
    status: "idle" | "pending";
    max: number;
    notice: string | null;
};

type PanelMessage =
    | { type: "ready"; reducedMotion?: boolean; soundStored?: boolean }
    | { type: "reducedMotion"; value: boolean }
    | { type: "setMuted"; muted: boolean }
    | { type: "add"; names: string[] }
    | { type: "rename"; id: string; name: string }
    | { type: "remove"; id: string }
    | { type: "clear" }
    | { type: "setRemovePicked"; value: boolean }
    | { type: "resetPicked" }
    | { type: "addWheel" }
    | { type: "setImage"; id: string; image: string }
    | { type: "removeImage"; id: string };

/** A change waiting to be written to the target wheel. */
type Change = (meta: DiscMeta) => DiscMeta;

let mode: Mode = "draft";
/** The new-wheel list; kept for the session while the panel edits wheels. */
let draft: WheelItem[] = [];
/**
 * The current wheel the panel edits, by wheelId so swaps and spins keep it. It changes only
 * when a single wheel is selected, a wheel is added from the panel, or the wheel leaves the
 * board (then the draft shows). Per client and session; nothing is stored.
 */
let target: string | null = null;
/** Set while "Add wheel to board" runs, so the new wheel's selection binds the panel to it. */
let addingWheel = false;
/** The target wheel's meta as last read from the board. */
let targetMeta: DiscMeta | null = null;
/** Local list edits not yet written to the wheel; null when the wheel is up to date. */
let working: WheelItem[] | null = null;
/** Other changes (toggle, reset) waiting for the same write. */
let queued: Change[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let notice: string | null = null;
/** Sound setting for this session; null until read from storage or changed. */
let muted: boolean | null = null;
const SETTINGS_KEY = "settings";

// ---------------------------------------------------------------------------
// Webview

/** Off-state switch track; the theme tokens have no fill with 3:1 contrast against the panel. */
const SWITCH_OFF = { light: "#71717A", dark: "#8E8E93" };

function themeCss(): string {
    const theme = styling?.theme === "dark" ? "dark" : "light";
    const vars = Object.entries(tokens())
        .map(([name, value]) => `${name}: ${value};`)
        .join("");
    return `color-scheme: ${theme};--dl-switch-off: ${SWITCH_OFF[theme]};${vars}`;
}

function post(message: unknown): void {
    void call({ type: "command:webview:post-message", req: { webviewDomId: WEBVIEW_ID, message } });
}

/** Opens the panel, or hides it when it is showing. */
export async function togglePanel(): Promise<void> {
    const rect = await call({ type: "command:dom:element-rect", req: { elementId: WEBVIEW_ID } });
    if (rect.res.value && rect.res.value.width > 0 && rect.res.value.height > 0) {
        await call({ type: "command:webview:hide", req: { webviewDomId: WEBVIEW_ID } });
        return;
    }
    const created = await call({
        type: "command:webview:create",
        req: { webviewDomId: WEBVIEW_ID, htmlContent: PANEL_HTML.replace("/*__THEME__*/", themeCss()), keepStateWhenClosed: false },
    });
    if (created.res.error) error("panel could not open", created.res.error);
}

export function onThemeChanged(): void {
    post({ type: "theme", css: themeCss() });
}

/** Shows a short message in the panel, e.g. when a permission was denied. */
export function showNotice(text: string): void {
    notice = text;
    pushState();
}

// ---------------------------------------------------------------------------
// State

function currentItems(): WheelItem[] {
    return mode === "draft" ? draft : working ?? targetMeta?.items ?? [];
}

/** Image keys this panel instance already has; reset when a new panel document starts. */
let sentImages = new Set<string>();

const imageKey = (image: string) => `${image.length.toString(36)}-${(seedFrom(image) >>> 0).toString(36)}`;

/** Sends the images the panel does not have yet, then the rows refer to them by key. */
function panelItems(items: WheelItem[]): PanelItem[] {
    const fresh: Record<string, string> = {};
    const rows = items.map((it) => {
        if (!it.image) return { id: it.id, name: it.name, imageKey: null };
        const key = imageKey(it.image);
        if (!sentImages.has(key)) {
            fresh[key] = it.image;
            sentImages.add(key);
        }
        return { id: it.id, name: it.name, imageKey: key };
    });
    if (Object.keys(fresh).length > 0) post({ type: "images", images: fresh });
    return rows;
}

function visibleCount(items: WheelItem[]): number {
    if (mode !== "edit" || !targetMeta) return items.length;
    return visibleItems({ ...targetMeta, items }).length;
}

function pushState(): void {
    const meta = mode === "edit" ? targetMeta : null;
    const items = currentItems();
    const state: PanelState = {
        mode,
        items: panelItems(items),
        visibleCount: visibleCount(items),
        imageLimit: IMAGE_ITEM_LIMIT,
        picked: meta?.picked ?? [],
        removePicked: pendingRemovePicked() ?? meta?.removePicked ?? true,
        status: working !== null || queued.length > 0 || flushing ? "pending" : "idle",
        max: MAX_ITEMS,
        notice,
    };
    post({ type: "state", state });
}

/** The toggle value a queued change will write, so the switch reflects the click at once. */
let lastRemovePicked: boolean | null = null;
function pendingRemovePicked(): boolean | null {
    return queued.length > 0 ? lastRemovePicked : null;
}

async function setTarget(nextMode: Mode, wheelId: string | null): Promise<void> {
    if (target && target !== wheelId && (working !== null || queued.length > 0)) {
        // Leaving a wheel with unsaved edits: write them before switching.
        await flush();
    }
    mode = nextMode;
    if (target !== wheelId) {
        target = wheelId;
        working = null;
        queued = [];
        targetMeta = wheelId ? await readWheel(wheelId) : null;
    }
    pushState();
}

/**
 * Selecting exactly one wheel binds the panel to it. Deselecting, selecting other elements or
 * several wheels, and the driver's own selection changes (spins, swaps) leave the binding alone.
 */
async function onSelection(): Promise<void> {
    if (isOwnSelectionChange() && !addingWheel) return;
    const wheels = await selectedWheelIds();
    if (wheels.length === 1 && (mode !== "edit" || target !== wheels[0])) {
        log("panel bound to wheel", { wheelId: wheels[0] });
        await setTarget("edit", wheels[0]);
    }
}

function onBoard(wheels: WheelView[]): void {
    if (!target) return;
    const view = wheels.find((w) => w.meta.wheelId === target);
    if (!view) {
        // Every disc of the wheel is gone (deleted, or undone away); a swap always keeps one.
        if (!isBusy(target)) {
            log("panel unbound: wheel left the board", { wheelId: target });
            void setTarget("draft", null);
        }
        return;
    }
    // Meta is the source of truth: another client's change shows up here.
    targetMeta = view.meta;
    if ((working !== null || queued.length > 0) && !flushTimer && !flushing) void flush();
    pushState();
}

// ---------------------------------------------------------------------------
// List operations

function newItems(names: string[], room: number): WheelItem[] {
    return names
        .map((n) => n.trim().slice(0, MAX_NAME_LENGTH))
        .filter((n) => n.length > 0)
        .slice(0, Math.max(0, room))
        .map((name) => ({ id: generateId(), name }));
}

function applyListChange(change: (items: WheelItem[]) => WheelItem[]): void {
    if (mode === "draft") {
        draft = change(draft);
        pushState();
        return;
    }
    if (mode !== "edit" || !targetMeta) return;
    working = change(working ?? targetMeta.items);
    pushState();
    scheduleFlush();
}

function queueChange(change: Change): void {
    queued.push(change);
    pushState();
    scheduleFlush(0);
}

function scheduleFlush(delay = EDIT_DEBOUNCE_MS): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
    }, delay);
}

/**
 * Writes the pending list and queued changes to the target wheel in one write. A list
 * change clears a shown result (back to rest, same rotation). While the wheel spins the
 * write waits; the next board refresh after the spin retries it.
 */
async function flush(): Promise<void> {
    if (!target || flushing || (working === null && queued.length === 0)) return;
    if (isBusy(target)) return;
    flushing = true;
    const wheelId = target;
    const items = working;
    const changes = queued;
    working = null;
    queued = [];
    pushState();
    try {
        const result = await writeWheel(
            wheelId,
            (meta) => {
                let next = meta;
                if (items) {
                    const ids = new Set(items.map((it) => it.id));
                    next = { ...next, items, picked: next.picked.filter((id) => ids.has(id)), winnerId: null, labelDeg: undefined };
                }
                for (const change of changes) next = change(next);
                return next;
            },
            items ? "list edit" : "panel setting"
        );
        if (result === "busy") {
            // Keep the edits; newer ones made meanwhile win.
            working ??= items;
            queued = [...changes, ...queued];
        }
        if (result === "missing") log("panel edit dropped: wheel not on the board", { wheelId });
    } catch (err) {
        if (err instanceof UnauthorizedError) showNotice("Draw Lots needs access to the board. Re-enable it in the extension permissions.");
        else error("panel write failed", { err });
    } finally {
        flushing = false;
        pushState();
        if (working !== null || queued.length > 0) scheduleFlush();
    }
}

// ---------------------------------------------------------------------------
// Sound settings and spin sound

/**
 * Reads the stored sound setting. Only called when the panel reports that it was stored
 * before, which means the storage permission was already decided, so reading never prompts.
 */
async function loadMuted(): Promise<void> {
    const res = await call({ type: "command:kv-storage:get", req: { key: SETTINGS_KEY } });
    const stored = res.res.value?.got?.muted;
    if (typeof stored === "boolean") muted = stored;
}

/** Keeps the setting for the session and stores it; the first store asks for the storage permission. */
async function saveMuted(value: boolean): Promise<void> {
    muted = value;
    const res = await call({ type: "command:kv-storage:set", req: { key: SETTINGS_KEY, payload: { muted: value } } });
    if (res.res.error) {
        log("sound setting kept for this session only", { error: res.res.error.type });
        return;
    }
    post({ type: "soundStored" });
}

/** Forwards spin timing to the panel, which plays the sound. A closed panel just drops it. */
function onSpin(event: SpinEvent): void {
    const bound = mode === "edit" && target === event.wheelId;
    if (event.type === "start") {
        if (event.local || bound) post({ type: "spin", wheelId: event.wheelId, schedule: event.schedule, elapsedMs: event.elapsedMs });
    } else if (event.type === "cancel") {
        post({ type: "spinCancel", wheelId: event.wheelId });
    } else if (event.local || bound) {
        post({ type: "land", wheelId: event.wheelId });
    }
}

export async function onPanelMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) return;
    const message = raw as PanelMessage;
    switch (message.type) {
        case "ready":
            sentImages = new Set();
            onThemeChanged();
            if (typeof message.reducedMotion === "boolean") setReducedMotion(message.reducedMotion);
            if (muted === null && message.soundStored) await loadMuted().catch(() => undefined);
            post({ type: "sound", muted: muted ?? false });
            await onSelection();
            pushState();
            return;
        case "reducedMotion":
            setReducedMotion(message.value);
            return;
        case "setMuted":
            await saveMuted(message.muted).catch(() => undefined);
            return;
        case "add":
            applyListChange((items) => [...items, ...newItems(message.names, MAX_ITEMS - items.length)]);
            return;
        case "rename": {
            const name = message.name.trim().slice(0, MAX_NAME_LENGTH);
            if (!name) return;
            applyListChange((items) => items.map((it) => (it.id === message.id ? { ...it, name } : it)));
            return;
        }
        case "remove":
            applyListChange((items) => items.filter((it) => it.id !== message.id));
            return;
        case "setImage":
            // An image change is a list edit: same debounce, same disc swap.
            if (!isImageDataUrl(message.image)) return;
            applyListChange((items) => items.map((it) => (it.id === message.id ? { ...it, image: message.image } : it)));
            return;
        case "removeImage":
            applyListChange((items) =>
                items.map((it) => {
                    if (it.id !== message.id) return it;
                    const { image: _removed, ...rest } = it;
                    return rest;
                })
            );
            return;
        case "clear":
            applyListChange(() => []);
            return;
        case "setRemovePicked":
            if (mode !== "edit") return;
            lastRemovePicked = message.value;
            queueChange((meta) => ({ ...meta, removePicked: message.value }));
            return;
        case "resetPicked":
            if (mode !== "edit") return;
            queueChange((meta) => ({ ...meta, picked: [], winnerId: null, labelDeg: undefined }));
            return;
        case "addWheel": {
            if (mode !== "draft" || draft.length < MIN_ITEMS) return;
            addingWheel = true;
            try {
                await addWheel(draft.map((it) => ({ ...it })));
                // Bind even if the selection event was missed or arrived first.
                await onSelection();
            } catch (err) {
                if (err instanceof UnauthorizedError) showNotice("Draw Lots needs access to the board. Re-enable it in the extension permissions.");
                else error("adding a wheel failed", { err });
            } finally {
                addingWheel = false;
            }
            return;
        }
    }
}

export function initPanel(): void {
    onSelectionChanged(() => void onSelection());
    onBoardChanged(onBoard);
    onSpinEvent(onSpin);
}
