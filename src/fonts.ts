import { decodeBase64 } from "./base64";
import { FONT_FACES } from "./font-data";
import { warn } from "./log";

/** Sour Gummy for Latin, Mitr for Thai; canvas falls back per glyph through the stack. */
const EMBEDDED_STACK = `"Sour Gummy", "Mitr", sans-serif`;
const FALLBACK_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

let loaded: Promise<boolean> | null = null;
let available = false;

/**
 * Registers the embedded font faces with the worker's FontFaceSet so OffscreenCanvas
 * can use them. Resolves false when the environment has no worker font API.
 */
export function loadFonts(): Promise<boolean> {
    loaded ??= (async () => {
        // WorkerGlobalScope.fonts; the DOM lib typings omit FontFaceSet.add.
        const fontSet = (globalThis as unknown as { fonts?: { add(font: FontFace): void } }).fonts;
        if (typeof FontFace === "undefined" || !fontSet) {
            warn("FontFace API unavailable in this worker, using system fonts");
            return false;
        }
        try {
            for (const face of FONT_FACES) {
                const bytes = decodeBase64(face.base64);
                const font = new FontFace(face.family, bytes.buffer as ArrayBuffer, { weight: face.weight, style: "normal" });
                await font.load();
                fontSet.add(font);
            }
            available = true;
        } catch (err) {
            warn("could not load embedded fonts, using system fonts", { err });
        }
        return available;
    })();
    return loaded;
}

export function fontFamily(): string {
    return available ? EMBEDDED_STACK : FALLBACK_STACK;
}
