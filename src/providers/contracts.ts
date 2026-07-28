import { sanitizeError } from "../sanitize.js";
import type { ProviderUsageView } from "../views/types.js";
import type {
	ProviderContext,
	ProviderVisibilityConfigKey,
	StandardUsageProvider,
	UsageProviderAdapter,
} from "./types.js";

export type ValidationIssue = Readonly<{
	path: string;
	message: string;
}>;

export type ValidationResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; issues: readonly ValidationIssue[] }>;

export type OfficialApiEndpoint = Readonly<{
	method: "GET" | "POST";
	path: string;
	documentationUrl?: string;
}>;

export type OfficialApiMetadata = Readonly<{
	baseUrls: readonly string[];
	documentationUrl: string;
	endpoints: readonly OfficialApiEndpoint[];
}>;

export type ProviderMetadata = Readonly<{
	id: string;
	displayName: string;
	catalogOrder: number;
	officialApi: OfficialApiMetadata;
}>;

export type CredentialSource = "env" | "opencode";

export type CredentialCandidate = Readonly<{
	source: CredentialSource;
	variant: string;
	name: string;
}>;

export type CredentialPolicy = Readonly<{
	allowedSources: readonly CredentialSource[];
	defaultCandidates: readonly CredentialCandidate[];
}>;

export type CredentialLease = Readonly<{
	secret: string;
	source: CredentialSource;
	variant: string;
	epoch: number;
	metadata?: Readonly<Record<string, string>>;
}>;

export type ProviderFetchExecutionContext = Readonly<{
	credential: CredentialLease;
	signal: AbortSignal;
	timeoutMs: number;
}>;

export type ProviderFetchContext<TOptions> = ProviderFetchExecutionContext &
	Readonly<{
		options: TOptions;
	}>;

export interface NonSecretAccountMetadataReader {
	readAccountIdentifier(key: string): string | undefined;
}

export type CacheDataShape = Readonly<
	Record<string, string | number | boolean>
>;

export type CacheScopeMetadata = Readonly<{
	accountId: string;
	credentialVariant: string;
	dataShape: CacheDataShape;
}>;

export type ProviderCacheMetadataContext<TOptions> = Readonly<{
	options: TOptions;
	metadata: NonSecretAccountMetadataReader;
}>;

export interface ProviderBinding {
	readonly metadata: ProviderMetadata;
	readonly credentialPolicy: CredentialPolicy;
	fetchUsage(
		context: ProviderFetchExecutionContext,
	): Promise<StandardUsageProvider>;
	present(provider: StandardUsageProvider): ProviderUsageView;
	resolveCacheScopeMetadata(
		metadata: NonSecretAccountMetadataReader,
	): CacheScopeMetadata | null;
}

export interface ProviderRegistration {
	readonly metadata: ProviderMetadata;
	readonly credentialPolicy: CredentialPolicy;
	parseOptions(input: unknown): ValidationResult<ProviderBinding>;
}

export interface ProviderDefinition<TOptions> {
	readonly metadata: ProviderMetadata;
	readonly credentialPolicy: CredentialPolicy;
	readonly registration: ProviderRegistration;
	parseOptions(input: unknown): ValidationResult<TOptions>;
	fetchUsage(
		context: ProviderFetchContext<TOptions>,
	): Promise<StandardUsageProvider>;
	present(provider: StandardUsageProvider): ProviderUsageView;
	resolveCacheScopeMetadata(
		context: ProviderCacheMetadataContext<TOptions>,
	): CacheScopeMetadata | null;
}

export type ProviderDefinitionInput<TOptions> = Omit<
	ProviderDefinition<TOptions>,
	"registration"
>;

export function defineProvider<TOptions>(
	input: ProviderDefinitionInput<TOptions>,
): ProviderDefinition<TOptions> {
	const metadata = freezeMetadata(input.metadata);
	const credentialPolicy = freezeCredentialPolicy(input.credentialPolicy);
	const registration = createRegistration(input, metadata, credentialPolicy);
	return Object.freeze({ ...input, metadata, credentialPolicy, registration });
}

function createRegistration<TOptions>(
	definition: ProviderDefinitionInput<TOptions>,
	metadata: ProviderMetadata,
	credentialPolicy: CredentialPolicy,
): ProviderRegistration {
	return Object.freeze({
		metadata,
		credentialPolicy,
		parseOptions: (input: unknown): ValidationResult<ProviderBinding> => {
			const parsed = definition.parseOptions(input);
			if (!parsed.ok) return parsed;
			return {
				ok: true,
				value: createBinding(
					definition,
					metadata,
					credentialPolicy,
					parsed.value,
				),
			};
		},
	});
}

function createBinding<TOptions>(
	definition: ProviderDefinitionInput<TOptions>,
	metadata: ProviderMetadata,
	credentialPolicy: CredentialPolicy,
	options: TOptions,
): ProviderBinding {
	return Object.freeze({
		metadata,
		credentialPolicy,
		fetchUsage: (context: ProviderFetchExecutionContext) =>
			definition.fetchUsage({ ...context, options }),
		present: (provider: StandardUsageProvider) => definition.present(provider),
		resolveCacheScopeMetadata: (reader: NonSecretAccountMetadataReader) =>
			definition.resolveCacheScopeMetadata({ options, metadata: reader }),
	});
}

function freezeMetadata(metadata: ProviderMetadata): ProviderMetadata {
	const baseUrls = Object.freeze([...metadata.officialApi.baseUrls]);
	const endpoints = Object.freeze(
		metadata.officialApi.endpoints.map((endpoint) =>
			Object.freeze({ ...endpoint }),
		),
	);
	const officialApi = Object.freeze({
		...metadata.officialApi,
		baseUrls,
		endpoints,
	});
	return Object.freeze({ ...metadata, officialApi });
}

function freezeCredentialPolicy(policy: CredentialPolicy): CredentialPolicy {
	const allowedSources = Object.freeze([...policy.allowedSources]);
	const defaultCandidates = Object.freeze(
		policy.defaultCandidates.map((candidate) =>
			Object.freeze({ ...candidate }),
		),
	);
	return Object.freeze({ allowedSources, defaultCandidates });
}

export type LegacyBridgeResult =
	| Readonly<{
			ok: true;
			options: unknown;
			fetchContext: ProviderFetchExecutionContext;
	  }>
	| Readonly<{
			ok: false;
			status: "missing-auth" | "error";
			message: string;
	  }>;

export interface LegacyProviderBridge {
	readonly configKey?: ProviderVisibilityConfigKey;
	isAvailable?(context: ProviderContext): boolean;
	resolve(context: ProviderContext, signal: AbortSignal): LegacyBridgeResult;
}

export class LegacyAdapterFacade implements UsageProviderAdapter {
	constructor(
		private readonly registration: ProviderRegistration,
		private readonly bridge: LegacyProviderBridge,
	) {}

	get id(): string {
		return this.registration.metadata.id;
	}

	get displayName(): string {
		return this.registration.metadata.displayName;
	}

	get configKey(): ProviderVisibilityConfigKey | undefined {
		return this.bridge.configKey;
	}

	isAvailable(context: ProviderContext): boolean {
		return this.bridge.isAvailable?.(context) ?? true;
	}

	async fetchUsage(
		context: ProviderContext,
		signal: AbortSignal,
	): Promise<StandardUsageProvider> {
		const bridged = this.resolveBridge(context, signal);
		if (!bridged.ok)
			return makeLegacyErrorSnapshot(
				this.registration,
				bridged.status,
				bridged.message,
			);
		const parsed = this.registration.parseOptions(bridged.options);
		if (!parsed.ok)
			return makeLegacyConfigErrorSnapshot(this.registration, parsed.issues);
		return parsed.value.fetchUsage(bridged.fetchContext);
	}

	private resolveBridge(
		context: ProviderContext,
		signal: AbortSignal,
	): LegacyBridgeResult {
		try {
			return this.bridge.resolve(context, signal);
		} catch (error: unknown) {
			return { ok: false, status: "error", message: sanitizeError(error) };
		}
	}
}

function makeLegacyConfigErrorSnapshot(
	registration: ProviderRegistration,
	issues: readonly ValidationIssue[],
): StandardUsageProvider {
	const details = issues
		.map((issue) => `${issue.path}: ${issue.message}`)
		.join("; ");
	return makeLegacyErrorSnapshot(
		registration,
		"error",
		`config error: ${details}`,
	);
}

function makeLegacyErrorSnapshot(
	registration: ProviderRegistration,
	status: "missing-auth" | "error",
	message: string,
): StandardUsageProvider {
	const sanitized = sanitizeError(message);
	return {
		id: registration.metadata.id,
		displayName: registration.metadata.displayName,
		status,
		statusText: sanitized,
		...(status === "error" ? { errorMessage: sanitized } : {}),
		windows: [],
	};
}
