/**
 * The Token Plan model catalog, with NO imports at all — same discipline as
 * capabilities.ts: pi-specific wiring lives in ../extensions/qtools.ts, and the
 * decision logic here is unit-tested without pi, without the network, without a
 * config file.
 *
 * WHY THIS EXISTS
 * pi ships its model list from a remote catalog that lags the endpoint. Measured
 * 2026-10-10 against the live /models route: the plan serves 21 ids, pi's catalog
 * knew 10. The 11 missing included four usable chat models (qwen4-max-preview,
 * deepseek-v4.1-flash, deepseek-v4.1-flash-1017, auto) that simply could not be
 * selected in pi.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * The generation ids the endpoint also lists — wan2.7-image, wan2.7-image-pro,
 * qwen-image-3.0-pro, wan3.0-video, qwen-audio-3.0-* — are NOT chat models. Adding
 * them to pi's chat picker would create entries that 400 on every turn. This
 * package already drives them through their native endpoints (qwen_generate_image,
 * qwen_generate_video), which is the only surface they answer on.
 *
 * Every row below was probed, not copied from a sibling model: chat completion,
 * reasoning_content, image input, and all six reasoning_effort levels. That is the
 * same rule capabilities.ts follows after glm-5.3 shipped unmeasured and 400'd every
 * turn. contextWindow/maxTokens are the plan-wide family values, not per-model
 * measurements — the endpoint accepts max_tokens=999999 without complaint, so it
 * cannot be used to discover the real ceiling.
 */

/** Shape pi's registerProvider/refreshModels expects for a chat model. */
export interface CatalogModel {
	id: string;
	name: string;
	type: "chat";
	api: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat: Record<string, unknown>;
	thinkingLevelMap: Record<string, string | null>;
}

/** Subscription plan: tokens are prepaid, so per-token cost is zero. */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Verified on every plan model probed; matches pi's own qwen3.8-max entry. */
const QWEN_COMPAT = {
	supportsStrictMode: true,
	thinkingFormat: "qwen",
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsReasoningEffort: true,
};

/** All six levels returned 200 on every model below, so none are mapped to null. */
const ALL_LEVELS = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const model = (id: string, name: string, maxTokens: number): CatalogModel => ({
	id,
	name,
	type: "chat",
	api: "openai-completions",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1000000,
	maxTokens,
	cost: ZERO_COST,
	compat: QWEN_COMPAT,
	thinkingLevelMap: ALL_LEVELS,
});

/**
 * Chat models the plan serves that pi's catalog may lack.
 * Probed 2026-10-10: all four answer chat, emit reasoning_content, accept image
 * input (each correctly identified a test PNG as a pig), and accept every
 * reasoning_effort level.
 */
export const QTOOLS_MODELS: readonly CatalogModel[] = [
	model("qwen4-max-preview", "Qwen4 Max (preview)", 131072),
	model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 131072),
	model("deepseek-v4.1-flash-1017", "DeepSeek V4.1 Flash 1017", 131072),
	// Router id: the plan picks the backing model per request.
	model("auto", "Qwen Auto (plan router)", 131072),
];

/**
 * Provider ids this overlay applies to.
 *
 * Deliberately NOT all three plan providers: `qwen-token-plan-cn` serves
 * cn-beijing, a different regional deployment whose model list has never been
 * measured (the SG key returns 401 there). Pushing the SG-measured ids onto it
 * would be exactly the unmeasured assumption that made glm-5.3 400 every turn.
 * Both ids below share the ap-southeast-1 endpoint these rows were probed on.
 * Add CN only after probing its /models route with a CN credential.
 */
export const PLAN_PROVIDERS = [
	"qwen-token-plan",
	"qwen-token-plan-individual",
] as const;

export interface MergeResult {
	/** The full list to hand back to pi: baseline first, additions appended. */
	models: unknown[];
	/** Ids actually added, for logging and for the /qtools-config report. */
	added: string[];
	/**
	 * True when there was no baseline to merge into. Registering then would REPLACE
	 * pi's catalog with only our four rows, deleting every model pi knows about —
	 * so the caller must skip registration instead.
	 */
	unsafe: boolean;
}

/**
 * Merge our curated rows into pi's existing catalog, adding only ids pi lacks.
 *
 * pi's `models`/refreshModels return value REPLACES the provider's whole list, so
 * the baseline must be carried through verbatim. pi's own metadata always wins for
 * an id it already knows: its catalog is refreshed from the vendor and may carry
 * corrections (context windows, compat flags) that our static rows do not.
 */
export function mergeCatalog(
	baseline: readonly unknown[] | undefined,
	curated: readonly CatalogModel[] = QTOOLS_MODELS,
): MergeResult {
	if (!baseline || baseline.length === 0) {
		return { models: [], added: [], unsafe: true };
	}
	// Dedupe the baseline too, first occurrence wins: pi's catalog should not contain
	// repeats, but a duplicate id reaching registerProvider is worse than a dropped
	// copy, and keeping the first preserves pi's own metadata and ordering.
	const seen = new Set<string>();
	const models: unknown[] = [];
	for (const entry of baseline) {
		const id = (entry as { id?: unknown })?.id;
		if (typeof id === "string") {
			if (seen.has(id)) continue;
			seen.add(id);
		}
		models.push(entry);
	}
	const additions = curated.filter((m) => !seen.has(m.id));
	for (const m of additions) seen.add(m.id);
	return {
		models: [...models, ...additions],
		added: additions.map((m) => m.id),
		unsafe: false,
	};
}

/** Ids our catalog would add, without building the merged list. */
export function missingIds(
	baseline: readonly unknown[] | undefined,
	curated: readonly CatalogModel[] = QTOOLS_MODELS,
): string[] {
	return mergeCatalog(baseline, curated).added;
}
