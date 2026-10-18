/**
 * The capability layer, with NO imports at all — deliberately.
 *
 * Everything pi-specific (context, config file, TUI, HTTP) lives in ../extensions/qtools.ts.
 * This file is the part that decides whether a model can take `enable_search` and which
 * model runs a tool, and it is unit-tested without pi installed, without the network, and
 * without a config file. That matters: when this table lived inside the extension, the test
 * had to import the extension, which had to import `@earendil-works/pi-coding-agent`, so CI
 * needed a full pi install just to assert a boolean.
 *
 * Measured against the live endpoint:
 *   https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
 *
 * TWO API surfaces, different capabilities:
 *   chat      = /chat/completions params (enable_search, agent strategy, code interpreter)
 *   responses = /responses built-in tools (web_search, code_interpreter, web_extractor,
 *               web_search_image, image_search)
 */

export interface Caps {
	chat: { search: boolean; agent: boolean; ci: boolean };
	responses: {
		web_search: boolean;
		code_interpreter: boolean;
		web_extractor: boolean;
		web_search_image: boolean;
		image_search: boolean;
	};
}

const chat = (search: boolean, agent: boolean, ci: boolean) => ({ search, agent, ci });
const c = (v: boolean) => v;
const res = (ws: boolean, ci: boolean, we: boolean, wsi: boolean, is: boolean) => ({
	web_search: ws,
	code_interpreter: ci,
	web_extractor: we,
	web_search_image: wsi,
	image_search: is,
});
export const ALL_RES = res(c(true), c(true), c(true), c(true), c(true));
/** Every text model does search/code/extract; only some do the image tools. */
export const IMG = (wsi: boolean, is: boolean) => res(true, true, true, wsi, is);
export const NO_RES = res(false, false, false, false, false);

/**
 * Measured per model. The two image tools are gated separately from each other.
 * Re-measured 2026-10-10: `web_search_image` is NOT qwen3.8-max-only as this table first
 * claimed — it also runs on qwen3.8-flash / 3.7-plus / 3.6-flash, and qwen3.7-max cannot
 * run either image tool. Both mistakes pushed tool calls onto the plan's priciest tier.
 * Untested cells are left false.
 */
export const CAPS: Record<string, Caps> = {
	"qwen3.8-max": { chat: chat(true, false, false), responses: ALL_RES },
	"qwen3.8-flash": { chat: chat(true, false, false), responses: IMG(true, true) },
	"qwen3.7-max": { chat: chat(true, true, true), responses: IMG(false, false) },
	"qwen3.7-plus": { chat: chat(true, true, true), responses: IMG(true, true) },
	"qwen3.6-flash": { chat: chat(true, true, true), responses: IMG(true, true) },
	"deepseek-v4-pro": { chat: chat(true, true, true), responses: IMG(false, false) },
	"deepseek-v4-pro-0813": { chat: chat(true, true, true), responses: IMG(false, false) },
	"deepseek-v4-flash": { chat: chat(true, true, true), responses: IMG(false, false) },
	"deepseek-v4-flash-0731": { chat: chat(true, true, true), responses: IMG(false, false) },
	"glm-5.2": { chat: chat(false, false, false), responses: IMG(false, false) },
	// Measured 2026-10-10: chat enable_search -> 400 "This model does not support enable_search"
	// in both streaming and non-streaming mode; /responses runs web_search + code_interpreter;
	// both image tools rejected; reasoning_effort only accepts low|high|max (xhigh/medium 400).
	"glm-5.3": { chat: chat(false, false, false), responses: IMG(false, false) },
	// Measured 2026-10-10: chat enable_search accepted, all five /responses built-ins accepted
	// (both image tools fired), and chat enable_code_interpreter needs STREAMING mode: a
	// non-streaming probe 400s with "Non-streaming mode does not support Code interpreter",
	// which reads like a capability rejection and is not one. pi always streams.
	"deepseek-v4.1-flash": { chat: chat(true, true, true), responses: IMG(false, false) },
	// "auto" is the plan's router alias. Measured 2026-10-10: chat enable_search accepted,
	// /responses web_search accepted, all reasoning_effort levels accepted. It routes to some
	// model I cannot see, so only the cells I actually exercised are set; assume nothing else.
	"auto": { chat: chat(true, false, false), responses: IMG(false, false) },
	"wan2.7-image": { chat: chat(false, false, false), responses: NO_RES },
	"wan2.7-image-pro": { chat: chat(false, false, false), responses: NO_RES },
	"qwen-audio-3.0-tts-plus": { chat: chat(false, false, false), responses: NO_RES },
	"qwen-audio-3.0-realtime-plus": { chat: chat(false, false, false), responses: NO_RES },
};

/**
 * Family defaults for ids missing from CAPS, so a dated release (glm-5.4,
 * deepseek-v4.2-flash-1101, qwen3.9-max-...) inherits the family's measured shape instead
 * of falling through to UNKNOWN_CAPS. First match wins, so the generation-only rule must
 * stay ahead of the qwen chat rule.
 */
export const FAMILY_CAPS: Array<{ match: RegExp; caps: Caps; why: string }> = [
	{
		match: /^(qwen-(audio|image)|wan|happyhorse)/i,
		caps: { chat: chat(false, false, false), responses: NO_RES },
		why: "native generation endpoint, not a chat model",
	},
	{
		// Every GLM on this plan so far rejects chat enable_search (glm-5.2, glm-5.3).
		match: /^glm/i,
		caps: { chat: chat(false, false, false), responses: IMG(false, false) },
		why: "GLM runs /responses built-ins but rejects enable_search on chat",
	},
	{
		match: /^deepseek/i,
		caps: { chat: chat(true, true, true), responses: IMG(false, false) },
		why: "DeepSeek on this plan takes chat search, agent mode and code interpreter",
	},
	{
		match: /^qwen[-.\d]/i,
		caps: { chat: chat(true, false, false), responses: IMG(false, false) },
		why: "Qwen chat models take turbo/max search injection",
	},
];

/**
 * Unknown models: assume the /responses tools work, assume NOTHING about chat
 * enable_search. The asymmetry is deliberate. A wrong `true` here was a poison pill:
 * glm-5.3 shipped on the plan, matched no CAPS row, took the injected enable_search, and
 * every single turn 400'd until the table was edited. A wrong `false` only costs the
 * passive search bonus, and `qwen_web_search` still works.
 */
export const UNKNOWN_CAPS: Caps = { chat: chat(false, false, false), responses: IMG(false, false) };

/**
 * Cheap-first candidate order for the fallback chain. The plan bills a max tier at a
 * several-times-higher ratio than a flash tier, so the chain is ordered by price, not by
 * recency, and `qwen3.6-flash` leads because it is the cheapest id measured running every
 * tool surface: chat search/agent/code plus all five /responses tools. Never hardcode an
 * endpoint here; add an id and let capsFor() decide who is eligible.
 */
export const FALLBACK_CHAIN = [
	"qwen3.6-flash",
	"qwen3.8-flash",
	"qwen3.7-plus",
	"deepseek-v4-flash",
	"deepseek-v4.1-flash",
	"qwen3.7-max",
	"qwen3.8-max",
];

/** Which models actually run each /responses tool, for error messages. */
export function modelsSupporting(tool: keyof Caps["responses"]): string[] {
	return Object.entries(CAPS)
		.filter(([, k]) => k.responses[tool])
		.map(([id]) => id);
}

function familyCaps(modelId: string): { caps: Caps; why: string } | undefined {
	return FAMILY_CAPS.find((rule) => rule.match.test(modelId));
}

function baseCaps(modelId: string): Caps {
	return CAPS[modelId] ?? familyCaps(modelId)?.caps ?? UNKNOWN_CAPS;
}

export interface CapsReader {
	capsFor(modelId: string): Caps;
	capsSource(modelId: string): string;
	searchCapable(modelId: string): boolean;
	fallbackChain(): string[];
	candidateOrder(active?: string, requested?: string): string[];
	chooseModel(eligible: (id: string) => boolean, active?: string, requested?: string): string | undefined;
}

/**
 * Read capability state through getters instead of importing state, because the caller owns
 * persistence: `config.searchBlocklist` and `config.fallbackModel` come from <agentDir>/qtools.json
 * and change at runtime. Tests pass a fixed list, or none at all.
 */
export function createCaps(
	options: { blocklist?: () => readonly string[]; fallbackModel?: () => string } = {},
): CapsReader {
	const blocked = () => options.blocklist?.() ?? [];
	const head = () => options.fallbackModel?.() ?? FALLBACK_CHAIN[0]!;

	function capsFor(modelId: string): Caps {
		const caps = baseCaps(modelId);
		// The runtime blocklist only ever removes a capability, never grants one.
		if (!blocked().includes(modelId)) return caps;
		return { ...caps, chat: { ...caps.chat, search: false } };
	}

	function candidateOrder(active?: string, requested?: string): string[] {
		const chain = [head(), ...FALLBACK_CHAIN.filter((id) => id !== head())];
		return [requested, active, ...chain].filter((id): id is string => typeof id === "string" && id.length > 0);
	}

	return {
		capsFor,
		/** Where a model's caps came from, for the /qtools-config capability readout. */
		capsSource(modelId: string): string {
			if (blocked().includes(modelId)) return "learned: rejects enable_search";
			if (CAPS[modelId]) return "measured";
			return familyCaps(modelId)?.why ?? "unknown model, no capabilities assumed";
		},
		/**
		 * glm-5.2 and glm-5.3 return "This model does not support enable_search", which breaks
		 * EVERY turn rather than just searches, so the main-loop injection is gated on this.
		 */
		searchCapable(modelId: string): boolean {
			return capsFor(modelId).chat.search;
		},
		/** Exported so the TUI and the tests show the same chain the pickers walk. */
		fallbackChain(): string[] {
			return [head(), ...FALLBACK_CHAIN.filter((id) => id !== head())];
		},
		candidateOrder,
		/**
		 * The pure half of the pickers: walk requested -> active -> fallback chain, first
		 * capable id wins. undefined means nothing on the plan can run the capability, and the
		 * caller must say so rather than call a model that will 400.
		 */
		chooseModel(eligible: (id: string) => boolean, active?: string, requested?: string): string | undefined {
			return candidateOrder(active, requested).find((id) => eligible(id));
		},
	};
}
