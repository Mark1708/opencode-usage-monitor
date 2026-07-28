import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { AuthEntry, AuthJson, AuthState } from "./providers/types.js";

const HOME = homedir() ?? "";
const AUTH_STRING_FIELDS = [
	"type",
	"key",
	"apiKey",
	"api_key",
	"token",
	"accessToken",
	"auth_token",
	"access",
	"refresh",
	"accountId",
] as const;

export type OpenCodeCredential = Readonly<{
	secret: string;
	metadata: Readonly<Record<string, string>>;
}>;

export type AuthTextResult =
	| Readonly<{ exists: false }>
	| Readonly<{ exists: true; text: string }>;

export type AuthFileReadOptions = Readonly<{
	candidates?: readonly string[];
	readText?: (path: string) => Promise<AuthTextResult>;
}>;

export type AuthPathOptions = Readonly<{
	home?: string;
	platform?: NodeJS.Platform;
	env?: Readonly<Record<string, string | undefined>>;
}>;

export function extractToken(entry: AuthEntry | undefined): string | undefined {
	if (!entry) return undefined;
	return (
		entry.key ||
		entry.apiKey ||
		entry.api_key ||
		entry.token ||
		entry.accessToken ||
		entry.auth_token ||
		entry.access ||
		undefined
	);
}

export function findOpenCodeAuthPaths(
	options: AuthPathOptions = {},
): readonly string[] {
	const home = options.home ?? HOME;
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const candidates =
		platform === "win32"
			? [
					absoluteBase(env.LOCALAPPDATA, platform)
						? `${env.LOCALAPPDATA}/opencode/auth.json`
						: undefined,
					absoluteBase(env.APPDATA, platform) ? `${env.APPDATA}/opencode/auth.json` : undefined,
					absoluteBase(home, platform) ? `${home}/.opencode/auth.json` : undefined,
				]
			: [
					absoluteBase(env.XDG_DATA_HOME, platform)
						? `${env.XDG_DATA_HOME}/opencode/auth.json`
						: undefined,
					absoluteBase(home, platform) ? `${home}/.local/share/opencode/auth.json` : undefined,
					absoluteBase(env.XDG_CONFIG_HOME, platform)
						? `${env.XDG_CONFIG_HOME}/opencode/auth.json`
						: undefined,
					absoluteBase(home, platform) ? `${home}/.config/opencode/auth.json` : undefined,
					absoluteBase(home, platform) ? `${home}/.opencode/auth.json` : undefined,
				];
	return Object.freeze([
		...new Set(
			candidates.filter(
				(path): path is string => typeof path === "string" && path.length > 0,
			),
		),
	]);
}

function absoluteBase(path: string | undefined, platform: NodeJS.Platform): path is string {
	if (!path) return false;
	if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
	return isAbsolute(path);
}

export async function readAuthFile(
	options: AuthFileReadOptions = {},
): Promise<AuthState> {
	const candidates = options.candidates ?? findOpenCodeAuthPaths();
	const readText = options.readText ?? readBunText;
	const fallbackPath =
		candidates[0] ?? `${HOME}/.local/share/opencode/auth.json`;
	for (const path of candidates) {
		try {
			const result = await readText(path);
			if (!result.exists) continue;
			return parseAuthJson(result.text, path);
		} catch (_error: unknown) {
			return invalidAuthState(path);
		}
	}
	return { kind: "missing", path: fallbackPath };
}

export function parseAuthJson(text: string, path: string): AuthState {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isPlainObject(parsed)) return invalidAuthState(path);
		return { kind: "loaded", path, auth: sanitizeAuthJson(parsed) };
	} catch (_error: unknown) {
		return invalidAuthState(path);
	}
}

export async function readOpenCodeEntry(
	entry: string,
	options: AuthFileReadOptions = {},
): Promise<OpenCodeCredential | undefined> {
	const state = await readAuthFile(options);
	if (state.kind === "missing") return undefined;
	if (state.kind === "invalid")
		throw new Error("OpenCode auth file is invalid");
	return toOpenCodeCredential(entry, asAuthEntry(state.auth[entry]));
}

async function readBunText(path: string): Promise<AuthTextResult> {
	const file = Bun.file(path);
	if (!(await file.exists())) return { exists: false };
	return { exists: true, text: await file.text() };
}

function toOpenCodeCredential(
	entryName: string,
	entry: AuthEntry | undefined,
): OpenCodeCredential | undefined {
	if (entryName === "openai")
		return entry ? toOpenAIOpenCodeCredential(entry) : undefined;
	const secret = extractToken(entry);
	if (!secret || !entry) return undefined;
	return Object.freeze({ secret, metadata: authEntryMetadata(entry) });
}

function toOpenAIOpenCodeCredential(
	entry: AuthEntry,
): OpenCodeCredential | undefined {
	const credential = discoverOpenAICredential({ openai: entry });
	if (!("token" in credential)) return undefined;
	return Object.freeze({
		secret: credential.token,
		metadata: Object.freeze({
			type: "oauth",
			accountId: credential.accountId,
			expires: String(credential.expires),
		}),
	});
}

function authEntryMetadata(entry: AuthEntry): Readonly<Record<string, string>> {
	return Object.freeze({
		...(entry.metadata ?? {}),
		...(entry.type ? { type: entry.type } : {}),
		...(entry.accountId ? { accountId: entry.accountId } : {}),
		...(typeof entry.expires === "number"
			? { expires: String(entry.expires) }
			: {}),
	});
}

export function discoverOpenAICredential(
	auth: Record<string, unknown>,
	_env: Record<string, string | undefined> = process.env,
): { token: string; accountId: string; expires: number } | { message: string } {
	const openai = asAuthEntry(auth.openai);
	const accessToken = openai?.access;
	const accountId = openai?.accountId;
	const expires = openai?.expires;
	if (openai?.type !== "oauth") return { message: "auth missing" };
	if (
		typeof accessToken === "string" &&
		accessToken.length > 0 &&
		typeof accountId === "string" &&
		accountId.length > 0 &&
		typeof expires === "number" &&
		expires > Date.now()
	) {
		return { token: accessToken, accountId, expires };
	}

	return { message: "auth missing" };
}

export function discoverDeepseekCredential(
	auth: Record<string, unknown>,
	env: Record<string, string | undefined> = process.env,
): { token: string } | { message: string } {
	const deepseek = extractToken(asAuthEntry(auth.deepseek));
	if (deepseek) return { token: deepseek };

	const apiKey = env.DEEPSEEK_API_KEY;
	if (apiKey) return { token: apiKey };

	return { message: "auth missing" };
}

type ZaiBaseUrl = "https://api.z.ai" | "https://open.bigmodel.cn";

interface ZaiCredentialSuccess {
	token: string;
	baseUrl: ZaiBaseUrl;
}

type ZaiCredential = ZaiCredentialSuccess | { message: string };

export function discoverZaiCredential(
	auth: Record<string, unknown>,
	env: Record<string, string | undefined> = process.env,
): ZaiCredential {
	const zaiCodingPlan = extractToken(asAuthEntry(auth["zai-coding-plan"]));
	if (zaiCodingPlan)
		return { token: zaiCodingPlan, baseUrl: "https://api.z.ai" };

	const zai = extractToken(asAuthEntry(auth.zai));
	if (zai) return { token: zai, baseUrl: "https://api.z.ai" };

	const zhipu = extractToken(asAuthEntry(auth.zhipu));
	if (zhipu) return { token: zhipu, baseUrl: "https://open.bigmodel.cn" };

	const zaiEnv = env.ZAI_API_KEY;
	if (zaiEnv) return { token: zaiEnv, baseUrl: "https://api.z.ai" };

	const zaiCodingPlanEnv = env.ZAI_CODING_PLAN_API_KEY;
	if (zaiCodingPlanEnv)
		return { token: zaiCodingPlanEnv, baseUrl: "https://api.z.ai" };

	const zhipuEnv = env.ZHIPU_API_KEY;
	if (zhipuEnv) return { token: zhipuEnv, baseUrl: "https://open.bigmodel.cn" };

	const zhipuaiEnv = env.ZHIPUAI_API_KEY;
	if (zhipuaiEnv)
		return { token: zhipuaiEnv, baseUrl: "https://open.bigmodel.cn" };

	return { message: "auth missing" };
}

function sanitizeAuthJson(value: Record<string, unknown>): AuthJson {
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, entry]) => {
			const sanitized = sanitizeAuthEntry(entry);
			return sanitized ? [[key, sanitized]] : [];
		}),
	);
}

function sanitizeAuthEntry(value: unknown): AuthEntry | undefined {
	if (!isPlainObject(value)) return undefined;
	const strings = AUTH_STRING_FIELDS.flatMap((field) =>
		typeof value[field] === "string" ? [[field, value[field]]] : [],
	);
	const metadata = sanitizeStringRecord(value.metadata);
	const expires =
		typeof value.expires === "number" && Number.isFinite(value.expires)
			? [["expires", value.expires]]
			: [];
	return Object.fromEntries([
		...strings,
		...expires,
		...(metadata ? [["metadata", metadata]] : []),
	]);
}

function sanitizeStringRecord(
	value: unknown,
): Record<string, string> | undefined {
	if (!isPlainObject(value)) return undefined;
	const entries = Object.entries(value).flatMap(([key, item]) =>
		typeof item === "string" ? [[key, item]] : [],
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function asAuthEntry(value: unknown): AuthEntry | undefined {
	return sanitizeAuthEntry(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function invalidAuthState(path: string): AuthState {
	return { kind: "invalid", path, error: "OpenCode auth file is invalid" };
}
