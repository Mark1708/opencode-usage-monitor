export const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{10,}/g,
  /key[=:]\s*[a-zA-Z0-9._-]{10,}/gi,
  /token[=:]\s*[a-zA-Z0-9._-]{10,}/gi,
  /api[_-]?key[=:]\s*[a-zA-Z0-9._-]{10,}/gi,
  /Authorization:\s*(?:Bearer\s+)?\S+/gi,
];

export function looksSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return /authorization|secret|password|credential|api[_-]?key|auth[_-]?token|access[_-]?token/.test(lower)
    || /(^|[_-])(key|token)($|[_-])/.test(lower);
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let sanitized = message;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  return sanitized.split("\n")[0] ?? "error";
}

export function sanitizeAdditionalProperties(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([key, value]) => {
      if (looksSecretKey(key)) return false;
      if (typeof value === "string" && SECRET_PATTERNS.some((pattern) => pattern.test(value))) return false;
      return true;
    }),
  );
}
