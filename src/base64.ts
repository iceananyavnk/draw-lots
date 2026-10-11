const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function decodeBase64(input: string): Uint8Array {
    const lookup = new Uint8Array(128);
    for (let i = 0; i < ALPHABET.length; i++) lookup[ALPHABET.charCodeAt(i)] = i;
    const clean = input.replace(/=+$/, "");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const a = lookup[clean.charCodeAt(i)];
        const b = lookup[clean.charCodeAt(i + 1)];
        const c = i + 2 < clean.length ? lookup[clean.charCodeAt(i + 2)] : 0;
        const d = i + 3 < clean.length ? lookup[clean.charCodeAt(i + 3)] : 0;
        const n = (a << 18) | (b << 12) | (c << 6) | d;
        if (o < out.length) out[o++] = (n >> 16) & 0xff;
        if (o < out.length) out[o++] = (n >> 8) & 0xff;
        if (o < out.length) out[o++] = n & 0xff;
    }
    return out;
}

export function encodeBase64(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        const n = (a << 16) | (b << 8) | c;
        out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
        out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=";
        out += i + 2 < bytes.length ? ALPHABET[n & 63] : "=";
    }
    return out;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return `data:${blob.type || "image/png"};base64,${encodeBase64(bytes)}`;
}
