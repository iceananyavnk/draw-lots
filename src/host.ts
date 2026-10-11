import type {
    DistributiveOmit,
    DriverCommandIssuer,
    DriverCommandRequest,
    DriverCommandResponseFor,
    ModuleStyling,
} from "@drawdy/driver-protocol";

type HostRequest = DistributiveOmit<DriverCommandRequest, "driverId" | "requestId">;

let issue: DriverCommandIssuer;
let driverId = "";
let requestSeq = 0;

export let generateId: () => string = () => "";
export let styling: ModuleStyling;

export function initHost(args: {
    issueCommand: DriverCommandIssuer;
    driverId: string;
    generateId: () => string;
    styling: ModuleStyling;
}): void {
    issue = args.issueCommand;
    driverId = args.driverId;
    generateId = args.generateId;
    styling = args.styling;
}

export function setStyling(next: ModuleStyling): void {
    styling = next;
}

/** Issues a command with driverId and a fresh requestId filled in. */
export function call<R extends HostRequest>(
    r: R
): Promise<DriverCommandResponseFor<Extract<DriverCommandRequest, { type: R["type"] }>>> {
    const full = { ...r, driverId, requestId: String(requestSeq++) } as unknown as DriverCommandRequest;
    return issue(full) as never;
}

export class UnauthorizedError extends Error {}

/** Unwraps a response value, throwing on error so callers can bail out of a sequence. */
export function unwrap<T>(res: { res: { value?: T; error?: { type: string; message?: string } } }): T {
    if (res.res.error) {
        if (res.res.error.type === "unauthorized") {
            throw new UnauthorizedError(res.res.error.message ?? "unauthorized");
        }
        throw new Error(`${res.res.error.type}: ${res.res.error.message ?? ""}`);
    }
    return res.res.value as T;
}

/** The --dd-* design tokens. Documented on ModuleStyling but missing from the published 1.3.0 types. */
export function tokens(): Record<string, string> {
    return (styling as ModuleStyling & { tokens?: Record<string, string> } | undefined)?.tokens ?? {};
}

export function token(name: string, fallback: string): string {
    return tokens()[name] || fallback;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
