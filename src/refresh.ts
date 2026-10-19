import type { ResolvedRefreshConfigV2 } from "./config-types.js";
import type { CredentialResolution } from "./credentials.js";
import type { CredentialLease } from "./providers/contracts.js";
import type { StandardUsageProvider } from "./providers/types.js";
import {
	createSuccessfulFetchState,
	prepareCompletedFetch,
	type TerminalProviderStatus,
	validateFetchResult,
} from "./refresh-commit.js";
import type {
	ActiveOperation,
	CommitGate,
	ProviderStateSubscriber,
	RefreshCoordinator,
	RefreshCoordinatorInput,
} from "./refresh-contracts.js";
import { matchesOperation } from "./refresh-contracts.js";
import {
	automaticDue,
	becomesStale,
	CONFIG_ERROR_MESSAGE,
	CREDENTIAL_MESSAGES,
	createInitialContexts,
	createInitialStates,
	credentialErrorStatus,
	DEFAULT_CLOCK,
	DEFAULT_TIMERS,
	deriveScope,
	freezeState,
	isDue,
	makeTarget,
	nearestDeadline,
	type OneShotTimers,
	type ProviderContextState,
	type ProviderRuntimeState,
	type ResolvedCacheScope,
	reconfigureContexts,
	reconfigureStates,
	type SelectedResolvedProvider,
	safeCacheRead,
	safeCacheWrite,
	scopeIdentity,
	shouldRefreshImmediately,
	withoutKey,
} from "./refresh-schedule.js";
import {
	prepareProviderSnapshot,
	sanitizeProviderFailure,
	successfulRuntimeStatus,
} from "./refresh-snapshot.js";

export type {
	ProviderStateSubscriber,
	RefreshCoordinator,
	RefreshCoordinatorInput,
	RefreshCredentialResolver,
} from "./refresh-contracts.js";

export type {
	MonotonicClock,
	OneShotTimers,
	ProviderRuntimeState,
	ProviderRuntimeStatus,
	RefreshCache,
	SelectedResolvedProvider,
} from "./refresh-schedule.js";

class DeterministicRefreshCoordinator implements RefreshCoordinator {
	private providers: readonly SelectedResolvedProvider[];
	private policy: ResolvedRefreshConfigV2;
	private generation = 1;
	private states: ReadonlyMap<string, ProviderRuntimeState>;
	private contexts: ReadonlyMap<string, ProviderContextState>;
	private operations: ReadonlyMap<string, ActiveOperation> = new Map();
	private resolutionSequences: ReadonlyMap<string, number> = new Map();
	private pendingResolutions: ReadonlyMap<string, number> = new Map();
	private subscribers: readonly ProviderStateSubscriber[] = Object.freeze([]);
	private timerHandle: unknown;
	private timerSequence = 0;
	private disposed = false;

	constructor(private readonly input: RefreshCoordinatorInput) {
		this.providers = Object.freeze([...input.providers]);
		this.policy = Object.freeze({ ...input.policy });
		this.states = createInitialStates(this.providers, this.generation);
		this.contexts = createInitialContexts(this.providers);
		this.bootstrapResetProviders(this.providers, this.generation);
		this.reschedule();
	}
	async refreshAll(): Promise<void> {
		if (this.disposed) return;
		const requests = this.providers
			.filter((provider) => provider.ok)
			.map((provider) => this.requestProvider(provider, this.generation));
		await Promise.allSettled(requests);
	}
	async refreshProvider(id: string): Promise<void> {
		if (this.disposed) return;
		const selected = this.providers.find((provider) => provider.id === id);
		if (!selected?.ok) return;
		await this.requestProvider(selected, this.generation);
	}
	invalidateCredentials(): void {
		if (this.disposed) return;
		this.abortAllOperations();
		this.cancelTimer();
		this.generation += 1;
		this.operations = new Map();
		this.invalidateResolutions();
		this.contexts = createInitialContexts(this.providers);
		this.states = createInitialStates(this.providers, this.generation);
		this.emit();
	}
	reconfigure(
		providers: readonly SelectedResolvedProvider[],
		policy: ResolvedRefreshConfigV2,
	): void {
		if (this.disposed) return;
		const previousProviders = this.providers;
		const previousContexts = this.contexts;
		const interruptedBootstraps = new Set(this.pendingResolutions.keys());
		this.abortAllOperations();
		this.cancelTimer();
		this.generation += 1;
		this.providers = Object.freeze([...providers]);
		this.policy = Object.freeze({ ...policy });
		this.states = reconfigureStates(
			this.providers,
			previousProviders,
			this.states,
			this.generation,
			this.policy,
			this.now(),
		);
		this.contexts = reconfigureContexts(
			this.providers,
			previousProviders,
			previousContexts,
		);
		this.operations = new Map();
		this.invalidateResolutions();
		this.emit();
		this.bootstrapChangedProviders(previousProviders, interruptedBootstraps);
		this.reschedule();
	}
	getStates(): readonly ProviderRuntimeState[] {
		return Object.freeze(
			this.providers.flatMap((provider) => {
				const current = this.states.get(provider.id);
				return current ? [current] : [];
			}),
		);
	}
	subscribe(subscriber: ProviderStateSubscriber): () => void {
		if (this.disposed) return () => undefined;
		this.subscribers = Object.freeze([...this.subscribers, subscriber]);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			this.subscribers = Object.freeze(
				this.subscribers.filter((candidate) => candidate !== subscriber),
			);
		};
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelTimer();
		this.abortAllOperations();
		this.operations = new Map();
		this.pendingResolutions = new Map();
		this.subscribers = Object.freeze([]);
		attemptCleanup(() => this.input.credentialResolver.dispose());
		attemptCleanup(() => this.input.cache.dispose());
	}
	private bootstrapResetProviders(
		providers: readonly SelectedResolvedProvider[],
		generation: number,
	): void {
		for (const provider of providers) {
			if (provider.ok) void this.bootstrapProvider(provider, generation);
		}
	}
	private bootstrapChangedProviders(
		previous: readonly SelectedResolvedProvider[],
		interruptedBootstraps: ReadonlySet<string>,
	): void {
		for (const provider of this.providers) {
			const prior = previous.find((candidate) => candidate.id === provider.id);
			if (
				provider.ok &&
				(prior !== provider || interruptedBootstraps.has(provider.id))
			) {
				void this.bootstrapProvider(provider, this.generation);
			}
		}
	}
	private async bootstrapProvider(
		provider: SelectedResolvedProvider & { readonly ok: true },
		generation: number,
	): Promise<void> {
		const resolutionSequence = this.beginResolution(provider.id, false);
		try {
			const resolution = await this.resolveCredential(
				provider,
				generation,
				resolutionSequence,
			);
			if (!resolution) return;
			if (
				!this.resolutionIsCurrent(provider.id, generation, resolutionSequence)
			)
				return;
			if (!resolution.ok) {
				this.commitCredentialError(provider.id, generation, resolution);
				return;
			}
			const scope = deriveScope(provider, resolution.lease);
			if (!scope.ok) {
				this.commitScopeError(provider.id, generation, resolution.lease.epoch);
				return;
			}
			this.setContext(
				provider,
				resolution.lease.epoch,
				resolution.accountScope,
				scope.value,
			);
			this.bootstrapFromCache(
				provider,
				generation,
				resolution.lease,
				resolution.accountScope,
				scope.value,
			);
		} finally {
			this.endResolution(provider.id, generation);
		}
	}
	private bootstrapFromCache(
		provider: SelectedResolvedProvider & { readonly ok: true },
		generation: number,
		lease: CredentialLease,
		accountScope: string,
		scope: ResolvedCacheScope,
	): void {
		const scopeKey = scopeIdentity(scope, accountScope);
		if (!this.contextIsCurrent(provider.id, generation, lease.epoch, scopeKey))
			return;
		const target = makeTarget(
			provider.id,
			generation,
			lease.epoch,
			accountScope,
			scope.scope,
		);
		const cached = safeCacheRead(this.input.cache, target);
		if (!this.contextIsCurrent(provider.id, generation, lease.epoch, scopeKey))
			return;
		if (cached.status === "hit")
			this.commitCached(provider.id, cached.snapshot, lease.secret);
		if (this.policy.mode !== "automatic") return;
		const current = this.states.get(provider.id);
		if (
			cached.status !== "hit" ||
			shouldRefreshImmediately(current, this.now())
		) {
			void this.startWithLease(
				provider,
				generation,
				lease,
				accountScope,
				scope,
			);
		}
	}
	private async requestProvider(
		provider: SelectedResolvedProvider & { readonly ok: true },
		generation: number,
	): Promise<void> {
		const resolutionSequence = this.beginResolution(provider.id, true);
		try {
			if (
				!this.resolutionIsCurrent(provider.id, generation, resolutionSequence)
			)
				return;
			const resolution = await this.resolveCredential(
				provider,
				generation,
				resolutionSequence,
			);
			if (!resolution) return;
			if (
				!this.resolutionIsCurrent(provider.id, generation, resolutionSequence)
			)
				return;
			if (!resolution.ok) {
				this.commitCredentialError(provider.id, generation, resolution);
				return;
			}
			const scope = deriveScope(provider, resolution.lease);
			if (!scope.ok) {
				this.commitScopeError(provider.id, generation, resolution.lease.epoch);
				return;
			}
			await this.startWithLease(
				provider,
				generation,
				resolution.lease,
				resolution.accountScope,
				scope.value,
			);
		} finally {
			this.endResolution(provider.id, generation);
		}
	}
	private async resolveCredential(
		provider: SelectedResolvedProvider & { readonly ok: true },
		generation: number,
		resolutionSequence: number,
	): Promise<CredentialResolution | null> {
		try {
			return await this.input.credentialResolver.resolve(
				provider.registration,
				provider.credential,
			);
		} catch (_error: unknown) {
			if (
				this.resolutionIsCurrent(provider.id, generation, resolutionSequence)
			) {
				const epoch = this.contexts.get(provider.id)?.credentialEpoch ?? 0;
				this.commitCredentialError(provider.id, generation, {
					ok: false,
					kind: "source",
					message: CREDENTIAL_MESSAGES.source,
					epoch,
				});
			}
			return null;
		}
	}
	private startWithLease(
		provider: SelectedResolvedProvider & { readonly ok: true },
		generation: number,
		lease: CredentialLease,
		accountScope: string,
		scope: ResolvedCacheScope,
	): Promise<void> {
		if (!this.providerIsCurrent(provider.id, generation))
			return Promise.resolve();
		const scopeKey = scopeIdentity(scope, accountScope);
		const existing = this.operations.get(provider.id);
		if (
			existing &&
			matchesOperation(existing, generation, lease.epoch, scopeKey)
		)
			return existing.promise;
		existing?.controller.abort();
		this.setContext(provider, lease.epoch, accountScope, scope);
		const requestSequence =
			(this.states.get(provider.id)?.requestSequence ?? 0) + 1;
		const gate = Object.freeze({
			id: provider.id,
			generation,
			requestSequence,
			credentialEpoch: lease.epoch,
			scopeKey,
		});
		this.commitRefreshing(gate);
		if (!this.canCommit(gate)) return Promise.resolve();
		const controller = new AbortController();
		const promise = Promise.resolve().then(() =>
			this.executeFetch(provider, lease, accountScope, scope, controller, gate),
		);
		const operation = Object.freeze({ ...gate, controller, promise });
		this.operations = new Map(this.operations).set(provider.id, operation);
		return promise;
	}
	private async executeFetch(
		provider: SelectedResolvedProvider & { readonly ok: true },
		lease: CredentialLease,
		accountScope: string,
		scope: ResolvedCacheScope,
		controller: AbortController,
		gate: CommitGate,
	): Promise<void> {
		try {
			const result = await provider.binding.fetchUsage({
				credential: lease,
				signal: controller.signal,
				timeoutMs: this.policy.timeout_ms,
			});
			this.commitFetchResult(result, accountScope, scope, gate, lease.secret);
		} catch (error: unknown) {
			this.commitFetchFailure(
				sanitizeProviderFailure(error, lease.secret),
				gate,
			);
		} finally {
			this.finishOperation(gate);
		}
	}
	private commitFetchResult(
		result: StandardUsageProvider,
		accountScope: string,
		scope: ResolvedCacheScope,
		gate: CommitGate,
		credential: string,
	): void {
		const valid = validateFetchResult(result, gate.id, credential);
		if (!valid.ok) {
			if (valid.status === "error") {
				this.commitFetchFailure(valid.message, gate);
			} else {
				this.commitTerminalStatus(valid.status, valid.message, gate);
			}
			return;
		}
		const completedAt = this.now();
		const prepared = prepareCompletedFetch(
			valid.result,
			credential,
			gate.id,
			completedAt,
		);
		if (!prepared.ok) {
			this.commitFetchFailure(prepared.message, gate);
			return;
		}
		if (!this.canCommit(gate)) return;
		const snapshot = prepared.snapshot;
		this.replaceState(
			gate.id,
			createSuccessfulFetchState(
				this.states.get(gate.id),
				gate,
				valid.result.status,
				snapshot,
				completedAt,
				this.policy,
			),
		);
		if (!this.canCommit(gate)) return;
		safeCacheWrite(
			this.input.cache,
			makeTarget(
				gate.id,
				gate.generation,
				gate.credentialEpoch,
				accountScope,
				scope.scope,
			),
			snapshot,
		);
	}
	private commitFetchFailure(message: string, gate: CommitGate): void {
		if (!this.canCommit(gate)) return;
		const completedAt = this.now();
		const previous = this.states.get(gate.id);
		const next = freezeState({
			...previous,
			id: gate.id,
			generation: gate.generation,
			requestSequence: gate.requestSequence,
			credentialEpoch: gate.credentialEpoch,
			status: "error",
			lastAttemptAt: completedAt,
			nextDueAt: automaticDue(this.policy, completedAt),
			message: message || "Provider refresh failed",
		});
		this.replaceState(gate.id, next);
	}
	private commitTerminalStatus(
		status: TerminalProviderStatus,
		message: string,
		gate: CommitGate,
	): void {
		if (!this.canCommit(gate)) return;
		const completedAt = this.now();
		const previous = this.states.get(gate.id);
		this.replaceState(
			gate.id,
			freezeState({
				...previous,
				id: gate.id,
				generation: gate.generation,
				requestSequence: gate.requestSequence,
				credentialEpoch: gate.credentialEpoch,
				status: status === "missing-auth" ? "needs_auth" : status,
				snapshot: undefined,
				lastAttemptAt: completedAt,
				lastSuccessAt: undefined,
				nextDueAt: undefined,
				message: message || "Provider authorization failed",
			}),
		);
	}
	private commitCredentialError(
		id: string,
		generation: number,
		resolution: Exclude<CredentialResolution, { ok: true }>,
	): void {
		if (!this.providerIsCurrent(id, generation)) return;
		this.operations.get(id)?.controller.abort();
		this.operations = withoutKey(this.operations, id);
		const completedAt = this.now();
		const previous = this.states.get(id);
		const requestSequence = (previous?.requestSequence ?? 0) + 1;
		const status = credentialErrorStatus(resolution.kind);
		const context = this.contexts.get(id);
		if (context)
			this.contexts = new Map(this.contexts).set(
				id,
				Object.freeze({ ...context, credentialEpoch: resolution.epoch }),
			);
		this.replaceState(
			id,
			freezeState({
				...previous,
				id,
				generation,
				requestSequence,
				credentialEpoch: resolution.epoch,
				status,
				lastAttemptAt: completedAt,
				nextDueAt: automaticDue(this.policy, completedAt),
				message: CREDENTIAL_MESSAGES[resolution.kind],
			}),
		);
	}
	private commitScopeError(
		id: string,
		generation: number,
		credentialEpoch: number,
	): void {
		if (!this.providerIsCurrent(id, generation)) return;
		this.operations.get(id)?.controller.abort();
		this.operations = withoutKey(this.operations, id);
		const completedAt = this.now();
		const previous = this.states.get(id);
		this.replaceState(
			id,
			freezeState({
				...previous,
				id,
				generation,
				requestSequence: (previous?.requestSequence ?? 0) + 1,
				credentialEpoch,
				status: "config_error",
				lastAttemptAt: completedAt,
				nextDueAt: automaticDue(this.policy, completedAt),
				message: CONFIG_ERROR_MESSAGE,
			}),
		);
	}
	private commitCached(
		id: string,
		cached: StandardUsageProvider,
		credential: string,
	): void {
		const context = this.contexts.get(id);
		const previous = this.states.get(id);
		const prepared = prepareProviderSnapshot(cached, credential, id);
		const fetchedAt = prepared.ok ? prepared.snapshot.fetchedAt : undefined;
		if (!context || !previous || !prepared.ok || fetchedAt === undefined)
			return;
		const cloned = prepared.snapshot;
		const status =
			this.now() - fetchedAt >= this.policy.stale_after_ms
				? "stale"
				: successfulRuntimeStatus(cloned);
		this.replaceState(
			id,
			freezeState({
				...previous,
				status,
				snapshot: cloned,
				lastSuccessAt: fetchedAt,
				nextDueAt:
					this.policy.mode === "automatic"
						? fetchedAt + this.policy.interval_ms
						: undefined,
				credentialEpoch: context.credentialEpoch,
				message: undefined,
			}),
		);
	}
	private commitRefreshing(gate: CommitGate): void {
		if (!this.providerIsCurrent(gate.id, gate.generation)) return;
		const previous = this.states.get(gate.id);
		const next = freezeState({
			...previous,
			id: gate.id,
			generation: gate.generation,
			requestSequence: gate.requestSequence,
			credentialEpoch: gate.credentialEpoch,
			status: "refreshing",
			nextDueAt: undefined,
			message: undefined,
		});
		if (previous?.status === "refreshing") {
			this.states = new Map(this.states).set(gate.id, next);
			return;
		}
		this.replaceState(gate.id, next);
	}
	private beginResolution(id: string, markRefreshing: boolean): number {
		const sequence = (this.resolutionSequences.get(id) ?? 0) + 1;
		this.resolutionSequences = new Map(this.resolutionSequences).set(
			id,
			sequence,
		);
		const pending = (this.pendingResolutions.get(id) ?? 0) + 1;
		this.pendingResolutions = new Map(this.pendingResolutions).set(id, pending);
		if (markRefreshing) this.markResolving(id);
		return sequence;
	}
	private markResolving(id: string): void {
		const previous = this.states.get(id);
		if (!previous || previous.status === "refreshing") return;
		this.replaceState(
			id,
			freezeState({
				...previous,
				status: "refreshing",
				nextDueAt: undefined,
				message: undefined,
			}),
		);
	}
	private endResolution(id: string, generation: number): void {
		if (generation !== this.generation) return;
		const pending = this.pendingResolutions.get(id) ?? 0;
		this.pendingResolutions =
			pending <= 1
				? withoutKey(this.pendingResolutions, id)
				: new Map(this.pendingResolutions).set(id, pending - 1);
		this.reschedule();
	}
	private resolutionIsCurrent(
		id: string,
		generation: number,
		sequence: number,
	): boolean {
		return (
			this.providerIsCurrent(id, generation) &&
			this.resolutionSequences.get(id) === sequence
		);
	}
	private setContext(
		provider: SelectedResolvedProvider,
		credentialEpoch: number,
		accountScope: string,
		scope: ResolvedCacheScope,
	): void {
		this.contexts = new Map(this.contexts).set(
			provider.id,
			Object.freeze({
				selection: provider,
				credentialEpoch,
				accountScope,
				scope: scope.scope,
				scopeKey: scopeIdentity(scope, accountScope),
			}),
		);
	}
	private canCommit(gate: CommitGate): boolean {
		const state = this.states.get(gate.id);
		return (
			this.contextIsCurrent(
				gate.id,
				gate.generation,
				gate.credentialEpoch,
				gate.scopeKey,
			) && state?.requestSequence === gate.requestSequence
		);
	}
	private contextIsCurrent(
		id: string,
		generation: number,
		epoch: number,
		scopeKey: string,
	): boolean {
		const context = this.contexts.get(id);
		return (
			this.providerIsCurrent(id, generation) &&
			context?.credentialEpoch === epoch &&
			context.scopeKey === scopeKey
		);
	}
	private providerIsCurrent(id: string, generation: number): boolean {
		return (
			!this.disposed &&
			generation === this.generation &&
			this.providers.some((provider) => provider.id === id)
		);
	}
	private replaceState(id: string, next: ProviderRuntimeState): void {
		if (this.disposed || !this.states.has(id)) return;
		this.states = new Map(this.states).set(id, next);
		this.emit();
		this.reschedule();
	}
	private finishOperation(gate: CommitGate): void {
		const current = this.operations.get(gate.id);
		if (
			current?.generation === gate.generation &&
			current.requestSequence === gate.requestSequence
		) {
			this.operations = withoutKey(this.operations, gate.id);
		}
		this.reschedule();
	}
	private emit(): void {
		if (this.disposed) return;
		const states = this.getStates();
		for (const subscriber of this.subscribers) {
			try {
				consumeSubscriberResult(subscriber(states));
			} catch (_error: unknown) {
				void _error;
			}
		}
	}
	private reschedule(): void {
		if (this.disposed) return;
		this.cancelTimer();
		const deadline = nearestDeadline(
			this.getStates(),
			this.policy,
			this.busyIds(),
		);
		if (deadline === undefined) return;
		const sequence = this.timerSequence;
		this.timerHandle = this.timers().setTimeout(
			() => {
				if (this.disposed || sequence !== this.timerSequence) return;
				this.processDeadlines();
			},
			Math.max(0, deadline - this.now()),
		);
	}
	private processDeadlines(): void {
		if (this.disposed) return;
		this.timerHandle = undefined;
		this.commitStaleTransitions();
		if (this.policy.mode === "automatic") {
			const now = this.now();
			for (const provider of this.providers) {
				const current = this.states.get(provider.id);
				if (provider.ok && !this.isBusy(provider.id) && isDue(current, now)) {
					void this.requestProvider(provider, this.generation);
				}
			}
		}
		this.reschedule();
	}
	private commitStaleTransitions(): void {
		const now = this.now();
		let nextStates = this.states;
		let changed = false;
		for (const [id, current] of this.states) {
			if (!becomesStale(current, this.policy, now)) continue;
			nextStates = new Map(nextStates).set(
				id,
				freezeState({ ...current, status: "stale" }),
			);
			changed = true;
		}
		if (!changed || this.disposed) return;
		this.states = nextStates;
		this.emit();
	}
	private busyIds(): ReadonlySet<string> {
		return new Set([
			...this.operations.keys(),
			...this.pendingResolutions.keys(),
		]);
	}
	private isBusy(id: string): boolean {
		return this.operations.has(id) || this.pendingResolutions.has(id);
	}
	private abortAllOperations(): void {
		for (const operation of this.operations.values())
			operation.controller.abort();
	}
	private invalidateResolutions(): void {
		this.resolutionSequences = new Map(
			this.providers.map((provider) => [
				provider.id,
				(this.resolutionSequences.get(provider.id) ?? 0) + 1,
			]),
		);
		this.pendingResolutions = new Map();
	}
	private cancelTimer(): void {
		this.timerSequence += 1;
		if (this.timerHandle === undefined) return;
		const handle = this.timerHandle;
		this.timerHandle = undefined;
		attemptCleanup(() => this.timers().clearTimeout(handle));
	}
	private now(): number {
		return (this.input.clock ?? DEFAULT_CLOCK).now();
	}
	private timers(): OneShotTimers {
		return this.input.timers ?? DEFAULT_TIMERS;
	}
}

export function createRefreshCoordinator(
	input: RefreshCoordinatorInput,
): RefreshCoordinator {
	return new DeterministicRefreshCoordinator(input);
}

function attemptCleanup(cleanup: () => void): void {
	try {
		cleanup();
	} catch (_error: unknown) {
		return;
	}
}

function consumeSubscriberResult(result: void | Promise<void>): void {
	void Promise.resolve(result).catch(() => undefined);
}
