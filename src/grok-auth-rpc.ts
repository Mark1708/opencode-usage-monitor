import { Rpc } from "@opencode/plugin/rpc";

// This bridge returns only a status. Credentials never cross the RPC boundary.
export const GrokAuthRpc = Rpc.define({
	id: "usage-monitor.grok-auth",
	methods: {
		prepare: {
			input: { type: "object", additionalProperties: false },
			output: { type: "string", enum: ["ready", "missing", "failed"] },
		},
	},
	events: {},
});
