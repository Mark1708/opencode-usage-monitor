import type { ResolvedRefreshConfigV2 } from "./config-types.js";
import type { ProviderStatus, StandardUsageProvider } from "./providers/types.js";
import type { CommitGate } from "./refresh-contracts.js";
import {
	automaticDue,
	freezeState,
	type ProviderRuntimeState,
} from "./refresh-schedule.js";
import {
	CREDENTIAL_DATA_MESSAGE,
	INVALID_PROVIDER_DATA_MESSAGE,
	prepareProviderSnapshot,
	sanitizeProviderFailure,
} from "./refresh-snapshot.js";

type SuccessfulUsageProvider = StandardUsageProvider &
	Readonly<{ status: "ready" | "partial" }>;

export type TerminalProviderStatus = Extract<
	ProviderStatus,
	"missing-auth" | "forbidden" | "unsupported"
>;

type ValidFetchResult =
	| Readonly<{ ok: true; result: SuccessfulUsageProvider }>
	| Readonly<{
			ok: false;
			status: TerminalProviderStatus | "error";
			message: string;
	  }>;

type CompletedFetch =
	| Readonly<{ ok: true; snapshot: StandardUsageProvider }>
	| Readonly<{ ok: false; message: string }>;

export function validateFetchResult(
	result: StandardUsageProvider,
	expectedProviderId: string,
	credential: string,
): ValidFetchResult {
	if (isSuccessfulProviderResult(result, expectedProviderId)) {
		return Object.freeze({ ok: true, result });
	}
	const message = sanitizeProviderFailure(
		result.errorMessage ?? result.statusText ?? "Provider refresh failed",
		credential,
	);
	if (
		result.id === expectedProviderId &&
		(result.status === "missing-auth" ||
			result.status === "forbidden" ||
			result.status === "unsupported")
	) {
		return Object.freeze({ ok: false, status: result.status, message });
	}
	return Object.freeze({ ok: false, status: "error", message });
}

function isSuccessfulProviderResult(
	result: StandardUsageProvider,
	expectedProviderId: string,
): result is SuccessfulUsageProvider {
	return (
		result.id === expectedProviderId &&
		(result.status === "ready" || result.status === "partial")
	);
}

export function prepareCompletedFetch(
	result: SuccessfulUsageProvider,
	credential: string,
	expectedProviderId: string,
	completedAt: number,
): CompletedFetch {
	const prepared = prepareProviderSnapshot(
		result,
		credential,
		expectedProviderId,
		completedAt,
	);
	if (prepared.ok)
		return Object.freeze({ ok: true, snapshot: prepared.snapshot });
	const message =
		prepared.reason === "credential"
			? CREDENTIAL_DATA_MESSAGE
			: INVALID_PROVIDER_DATA_MESSAGE;
	return Object.freeze({ ok: false, message });
}

export function createSuccessfulFetchState(
	previous: ProviderRuntimeState | undefined,
	gate: CommitGate,
	status: "ready" | "partial",
	snapshot: StandardUsageProvider,
	completedAt: number,
	policy: ResolvedRefreshConfigV2,
): ProviderRuntimeState {
	return freezeState({
		...previous,
		id: gate.id,
		generation: gate.generation,
		requestSequence: gate.requestSequence,
		credentialEpoch: gate.credentialEpoch,
		status,
		snapshot,
		lastAttemptAt: completedAt,
		lastSuccessAt: completedAt,
		nextDueAt: automaticDue(policy, completedAt),
		message: undefined,
	});
}
