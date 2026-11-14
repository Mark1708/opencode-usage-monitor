import type { Plugin } from "@opencode/plugin";

type Connection = Awaited<ReturnType<Plugin.Context["integration"]["connection"]["active"]>>;
type Connections = Pick<Plugin.Context["integration"]["connection"], "active" | "resolve">;
export type GrokAuthStatus = "ready" | "missing" | "failed" | "region-blocked";

/** Ask the host to renew OAuth if necessary. Never handle refresh tokens here. */
export function createGrokAuthPreparation(connections: Connections) {
	let inFlight: Promise<GrokAuthStatus> | undefined;
	let disposed = false;
	const prepare = (): Promise<GrokAuthStatus> => {
		if (disposed) return Promise.resolve("missing");
		if (inFlight) return inFlight;
		const request = (async (): Promise<GrokAuthStatus> => {
			try {
				const before = await connections.active("xai");
				if (disposed || before?.type !== "credential" || before.method !== "oauth") return "missing";
				// Host resolve() owns expiry checks, refresh-token rotation and persistence.
				const value = await connections.resolve(before);
				if (disposed) return "missing";
				const after = await connections.active("xai");
				if (disposed || !sameConnection(before, after)) return "missing";
				return value?.type === "oauth" && value.access.length > 0 && value.expires > Date.now()
					? "ready" : "missing";
			} catch (error: unknown) {
				// Classify locally, but never publish raw HTML or host error messages.
				return isRegionBlocked(error) ? "region-blocked" : "failed";
			}
		})();
		inFlight = request;
		void request.finally(() => { if (inFlight === request) inFlight = undefined; });
		return request;
	};
	return Object.freeze({ prepare, dispose() { disposed = true; } });
}

function isRegionBlocked(error: unknown): boolean {
	const pending: unknown[] = [error];
	const seen = new Set<unknown>();
	for (let index = 0; index < pending.length && index < 8; index++) {
		const value = pending[index];
		if (seen.has(value)) continue;
		seen.add(value);
		if (typeof value === "string") {
			if (/this service is not available in your region\./i.test(value.slice(0, 8192))) return true;
			continue;
		}
		if (!value || typeof value !== "object") continue;
		try {
			// OpenCode may wrap the upstream Error in an authorization cause.
			// Inspect data fields only; do not evaluate accessors or stringify objects.
			for (const key of ["message", "cause"]) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (descriptor && "value" in descriptor) pending.push(descriptor.value);
			}
		} catch {
			return false;
		}
	}
	return false;
}

function sameConnection(before: Connection, after: Connection): boolean {
	return before?.type === "credential" && after?.type === "credential"
		&& before.id === after.id && after.method === "oauth";
}
