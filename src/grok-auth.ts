import type { Plugin } from "@opencode/plugin";

type Connection = Awaited<ReturnType<Plugin.Context["integration"]["connection"]["active"]>>;
type Connections = Pick<Plugin.Context["integration"]["connection"], "active" | "resolve">;
export type GrokAuthStatus = "ready" | "missing" | "failed";

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
			} catch {
				// Host errors may contain credential material. Publish only a fixed status.
				return "failed";
			}
		})();
		inFlight = request;
		void request.finally(() => { if (inFlight === request) inFlight = undefined; });
		return request;
	};
	return Object.freeze({ prepare, dispose() { disposed = true; } });
}

function sameConnection(before: Connection, after: Connection): boolean {
	return before?.type === "credential" && after?.type === "credential"
		&& before.id === after.id && after.method === "oauth";
}
