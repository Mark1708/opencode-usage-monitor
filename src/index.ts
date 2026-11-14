import { Plugin } from "@opencode/plugin";
import { createGrokAuthPreparation } from "./grok-auth.js";
import { GrokAuthRpc } from "./grok-auth-rpc.js";

export default Plugin.define({
	id: "usage-monitor",
	async setup(context) {
		const auth = createGrokAuthPreparation(context.integration.connection);
		const registration = await context.rpc.register(GrokAuthRpc, {
			prepare: () => auth.prepare(),
		});
		return async () => {
			auth.dispose();
			await registration.dispose();
		};
	},
});
