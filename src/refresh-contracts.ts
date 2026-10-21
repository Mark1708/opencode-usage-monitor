import type {
	CredentialReferenceV2,
	ResolvedRefreshConfigV2,
} from "./config-types.js";
import type { CredentialResolution } from "./credentials.js";
import type { ProviderRegistration } from "./providers/contracts.js";
import type {
	MonotonicClock,
	OneShotTimers,
	ProviderRuntimeState,
	RefreshCache,
	SelectedResolvedProvider,
} from "./refresh-schedule.js";

export interface RefreshCredentialResolver {
	resolve(
		registration: ProviderRegistration,
		reference?: CredentialReferenceV2,
	): Promise<CredentialResolution>;
	dispose(): void;
}

export type ProviderStateSubscriber = (
	states: readonly ProviderRuntimeState[],
) => void | Promise<void>;

export type RefreshCoordinatorInput = Readonly<{
	providers: readonly SelectedResolvedProvider[];
	policy: ResolvedRefreshConfigV2;
	credentialResolver: RefreshCredentialResolver;
	cache: RefreshCache;
	clock?: MonotonicClock;
	timers?: OneShotTimers;
}>;

export interface RefreshCoordinator {
	refreshAll(): Promise<void>;
	refreshProvider(id: string): Promise<void>;
	invalidateCredentials(): void;
	reconfigure(
		providers: readonly SelectedResolvedProvider[],
		policy: ResolvedRefreshConfigV2,
	): void;
	getStates(): readonly ProviderRuntimeState[];
	subscribe(subscriber: ProviderStateSubscriber): () => void;
	dispose(): void;
}

export type ActiveOperation = Readonly<{
	generation: number;
	requestSequence: number;
	credentialEpoch: number;
	scopeKey: string;
	controller: AbortController;
	promise: Promise<void>;
}>;

export type CommitGate = Readonly<{
	id: string;
	generation: number;
	requestSequence: number;
	credentialEpoch: number;
	scopeKey: string;
}>;

export function matchesOperation(
	operation: ActiveOperation | undefined,
	generation: number,
	credentialEpoch: number,
	scopeKey: string,
): boolean {
	return (
		operation?.generation === generation &&
		operation.credentialEpoch === credentialEpoch &&
		operation.scopeKey === scopeKey
	);
}
