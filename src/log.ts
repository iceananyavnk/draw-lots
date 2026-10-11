const PREFIX = "[draw-lots]";

function serialize(details: unknown): string {
    if (details === undefined) return "";
    return (
        " " +
        JSON.stringify(details, (_key, value: unknown) =>
            value instanceof Error ? { name: value.name, message: value.message } : value
        )
    );
}

/** Every log is one line: the prefix, a message, and the details as JSON. */
export const log = (message: string, details?: unknown) => console.info(`${PREFIX} ${message}${serialize(details)}`);
export const debug = (message: string, details?: unknown) => console.debug(`${PREFIX} ${message}${serialize(details)}`);
export const warn = (message: string, details?: unknown) => console.warn(`${PREFIX} ${message}${serialize(details)}`);
export const error = (message: string, details?: unknown) => console.error(`${PREFIX} ${message}${serialize(details)}`);
