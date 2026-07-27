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

export function sanitizeCredentialError(error: unknown, credential: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = credential.length > 0
    ? message.split(credential).join("[redacted]")
    : message;
  return sanitizeError(redacted);
}

export function sanitizeAdditionalProperties(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([key, value]) => {
      if (looksSecretKey(key)) return false;
      if (typeof value === "string" && hasSecretPattern(value)) return false;
      return true;
    }),
  );
}

export function hasSecretPattern(value: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    if (matched) return true;
  }
  return false;
}
