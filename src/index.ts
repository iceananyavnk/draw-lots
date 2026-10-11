import type { DriverModule } from "@drawdy/driver-protocol";
import { loadFonts } from "./fonts";
import { UnauthorizedError, call, initHost, setStyling, token } from "./host";
import { discForHubElement } from "./hubs";
import { error, warn } from "./log";
import type { WheelItem } from "./model";
import {
    addWheel,
    discsAppeared,
    isWheelElement,
    onDiscRemoved,
    onDiscUpdated,
    onDragEnd,
    onDragStart,
    onDragging,
    onSelection,
    refreshNow,
    setNotifier,
    spinFromClick,
} from "./wheels";

const ACTION_BUTTON_ID = "draw-lots:action-button";
const NOTICE_ID = "draw-lots:notice";
const DENIED_MESSAGE = "Draw Lots needs access to the board. Re-enable it in the extension permissions.";

const ACTION_BUTTON_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8.5"/><path d="M12 13V4.5M12 13l7.4 4.25M12 13l-7.4 4.25"/><circle cx="12" cy="13" r="2" fill="currentColor"/><path d="M10.5 1.5h3L12 4z" fill="currentColor"/></svg>`;

const SPIKE_NAMES = ["Ada", "Grace", "Linus", "Margaret", "Alan"];

let sceneReady: Promise<boolean> | null = null;

function spikeItems(): WheelItem[] {
    return SPIKE_NAMES.map((name, i) => ({ id: `spike-${i}`, name }));
}

async function notice(text: string): Promise<void> {
    const size = await call({ type: "command:dom:window-size" });
    const width = size.res.value?.width ?? 800;
    await call({
        type: "command:dom:upsert-floating-element",
        req: {
            domId: NOTICE_ID,
            position: { x: width / 2 - 150, y: 72 },
            asPopover: false,
            schema: {
                type: "box",
                styles: {
                    width: [300, "px"],
                    padding: [10, "px"],
                    backgroundColor: token("--dd-surface-elevated", "#fff"),
                    borderColor: token("--dd-border-subtle", "#ddd"),
                    borderWidth: [1, "px"],
                    borderType: "solid",
                    borderRadius: [8, "px"],
                    pointerEvents: "none",
                },
                children: [
                    {
                        type: "text",
                        child: text,
                        styles: { color: token("--dd-text-primary", "#111"), fontSize: [12, "px"], textAlign: "center" },
                    },
                ],
            },
        },
    });
    setTimeout(() => void call({ type: "command:dom:remove-floating-element", req: { domId: NOTICE_ID } }), 4000);
}

async function reportError(err: unknown): Promise<void> {
    if (err instanceof UnauthorizedError) {
        await notice(DENIED_MESSAGE);
        return;
    }
    error("unexpected error", { err });
}

/** Subscribes to scene events and shows hubs on existing wheels. Runs once; the first scene command prompts for permission. */
function ensureScene(): Promise<boolean> {
    sceneReady ??= (async () => {
        const properties = ["meta", "x", "y", "width", "height"] as ("meta" | "x" | "y" | "width" | "height")[];
        const subs = await Promise.all([
            call({ type: "subscription:scene:click", req: {} }),
            call({ type: "subscription:scene:drawdy-elements-dragged" }),
            call({ type: "subscription:scene:drawdy-element-selection" }),
            call({ type: "subscription:scene:elements-updated", req: { properties } }),
            call({ type: "subscription:scene:elements-removed", req: { properties: ["meta"] } }),
            call({ type: "subscription:scene:elements-added", req: { properties: ["meta"] } }),
            call({ type: "subscription:scene:elements-replaced", req: { properties: ["meta"] } }),
        ]);
        const failed = subs.find((s) => s.res.error)?.res.error;
        if (failed) {
            if (failed.type === "unauthorized") await notice(DENIED_MESSAGE);
            else error("subscribe failed", failed);
            return false;
        }
        await refreshNow();
        return true;
    })().catch(async (err) => {
        await reportError(err);
        return false;
    });
    return sceneReady;
}

export const activate: DriverModule["activate"] = async (ctx) => {
    initHost({
        issueCommand: ctx.issueCommand,
        driverId: ctx.manifest.driverId,
        generateId: ctx.generateId,
        styling: ctx.styling,
    });
    setNotifier((text) => void notice(text));
    void loadFonts();

    const button = await call({
        type: "command:dom:create-action-button",
        req: { domElementId: ACTION_BUTTON_ID, svg: ACTION_BUTTON_SVG },
    });
    if (button.res.error) {
        warn("action button unavailable", button.res.error);
        return;
    }
    await call({ type: "subscription:dom:element-clicked", req: { domElementId: ACTION_BUTTON_ID } });
    await call({ type: "subscription:dom:theme-changed" });

    await ensureScene();
};

export const onEvent: DriverModule["onEvent"] = async (event) => {
    switch (event.type) {
        case "subscription:dom:element-clicked": {
            if (event.body.domElementId !== ACTION_BUTTON_ID) return;
            if (!(await ensureScene())) return;
            await addWheel(spikeItems()).catch(reportError);
            return;
        }
        case "subscription:dom:theme-changed": {
            setStyling(event.body.styling);
            return;
        }
        case "subscription:scene:click": {
            // A click on the hub also reports the disc under it; the preview hub id decides.
            const hubElementId = event.body.drawdyElementIds.find((id) => discForHubElement(id));
            if (hubElementId) {
                await spinFromClick({ hubElementId, cursor: event.body.cursor.canvasSpace }).catch(reportError);
            }
            return;
        }
        case "subscription:scene:drawdy-elements-dragged": {
            const body = event.body;
            if (body.type === "dragStart") await onDragStart(body.drawdyElementIds).catch(reportError);
            else if (body.type === "dragging") onDragging();
            else await onDragEnd().catch(reportError);
            return;
        }
        case "subscription:scene:drawdy-element-selection": {
            onSelection(event.body.drawdyElementIds);
            return;
        }
        case "subscription:scene:elements-added":
        case "subscription:scene:elements-replaced": {
            // Every disc that appears is classified (own, restore, swap, new, copy) on the next refresh.
            const added = event.body.drawdyElements.filter((el) => isWheelElement(el));
            if (added.length > 0) discsAppeared(added.map((el) => el.id));
            return;
        }
        case "subscription:scene:elements-removed": {
            for (const el of event.body.drawdyElements) {
                if (isWheelElement(el)) await onDiscRemoved(el.id).catch(reportError);
            }
            return;
        }
        case "subscription:scene:elements-updated": {
            for (const el of event.body.drawdyElements) {
                if (isWheelElement(el)) await onDiscUpdated(el).catch(reportError);
            }
            return;
        }
        default:
            return;
    }
};
