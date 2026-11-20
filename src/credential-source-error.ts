// Only these fixed messages may cross from credential handling into render state.
// Never attach an upstream error, response body, URL, or credential to this error.
export const CREDENTIAL_SOURCE_MESSAGES = Object.freeze({
	"region-blocked": "xAI unavailable in your region",
	"refresh-failed": "xAI OAuth refresh failed",
});

export type CredentialSourceReason = keyof typeof CREDENTIAL_SOURCE_MESSAGES;

export class SafeCredentialSourceError extends Error {
	constructor(readonly reason: CredentialSourceReason) {
		super(CREDENTIAL_SOURCE_MESSAGES[reason]);
		this.name = "SafeCredentialSourceError";
		Object.freeze(this);
	}
}
