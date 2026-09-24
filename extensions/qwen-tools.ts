/**
 * qwen-tools — expose the Qwen Token Plan built-in server-side tools inside pi.
 *
 * Mapped empirically against the live endpoint:
 *   https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
 *
 * TWO API surfaces, different capabilities:
 *
 *  A) /chat/completions  (what pi itself uses)
 *     enable_search + search_options.search_strategy: "turbo"|"max" coexist with
 *     pi's function tools -> injected into the main loop.
 *     search_strategy "agent" and enable_code_interpreter flip Alibaba "Agent
 *     mode", which REJECTS any `tools` array -> cannot run in pi's loop.
 *
 *  B) /responses — built-in tools DO coexist with function tools here, and it
 *     returns structured traces: web_search_call (query+sources),
 *     code_interpreter_call (code+container_id+logs), web_extractor_call
 *     (urls+goal+output; requires web_search alongside).
 *
 * Config persists to <agentDir>/qwen-tools.json. UI: /qtools-config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ------------------------------------------------------------------ capability

const PROVIDER_PREFIX = "qwen-token-plan";

const BASE_URLS: Record<string, string> = {
	"qwen-token-plan": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
	"qwen-token-plan-individual": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
	"qwen-token-plan-cn": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
};

/**
 * The two surfaces have DIFFERENT support. Measured per model:
 *   chat      = /chat/completions params (enable_search, agent strategy, ci)
 *   responses = /responses built-in tools (web_search, code_interpreter, web_extractor)
 * Notably glm-5.2 rejects chat enable_search outright yet works on /responses,
 * and qwen3.8-* lack chat agent/code_interpreter but work on /responses.
 */
interface Caps {
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
const ALL_RES = res(c(true), c(true), c(true), c(true), c(true));
/** Every text model does search/code/extract; only some do the image tools. */
const IMG = (wsi: boolean, is: boolean) => res(true, true, true, wsi, is);
const NO_RES = res(false, false, false, false, false);

/**
 * Measured per model. The two image tools are gated separately from each other:
 * `web_search_image` is qwen3.8-max only, while `image_search` also works on
 * qwen3.8-flash / 3.7-plus / 3.6-flash. Untested cells are left false.
 */
const CAPS: Record<string, Caps> = {
	"qwen3.8-max": { chat: chat(true, false, false), responses: ALL_RES },
	"qwen3.8-flash": { chat: chat(true, false, false), responses: IMG(false, true) },
	"qwen3.7-max": { chat: chat(true, true, true), responses: IMG(false, false) },
	"qwen3.7-plus": { chat: chat(true, true, true), responses: IMG(false, true) },
	"qwen3.6-flash": { chat: chat(true, true, true), responses: IMG(false, true) },
	"deepseek-v4-pro": { chat: chat(true, true, true), responses: IMG(false, false) },
	"deepseek-v4-pro-0813": { chat: chat(true, true, true), responses: IMG(false, false) },
	"deepseek-v4-flash": { chat: chat(true, true, true), responses: IMG(false, false) },
	"deepseek-v4-flash-0731": { chat: chat(true, true, true), responses: IMG(false, false) },
	"glm-5.2": { chat: chat(false, false, false), responses: IMG(false, false) },
	"wan2.7-image": { chat: chat(false, false, false), responses: NO_RES },
	"wan2.7-image-pro": { chat: chat(false, false, false), responses: NO_RES },
	"qwen-audio-3.0-tts-plus": { chat: chat(false, false, false), responses: NO_RES },
	"qwen-audio-3.0-realtime-plus": { chat: chat(false, false, false), responses: NO_RES },
};

/** Which models actually run each /responses tool, for error messages. */
export function modelsSupporting(tool: keyof Caps["responses"]): string[] {
	return Object.entries(CAPS)
		.filter(([, k]) => k.responses[tool])
		.map(([id]) => id);
}

/** Unknown models: assume the common three, assume not the image tools. */
const UNKNOWN_CAPS: Caps = { chat: chat(true, false, false), responses: IMG(false, false) };

function capsFor(modelId: string): Caps {
	return CAPS[modelId] ?? UNKNOWN_CAPS;
}

/**
 * glm-5.2 returns "This model does not support enable_search", which would break
 * EVERY turn rather than just searches, so the main-loop injection is gated.
 */
function searchCapable(modelId: string): boolean {
	return capsFor(modelId).chat.search;
}

// --------------------------------------------------------------------- config

type SearchMode = "off" | "turbo" | "max";

interface QwenToolsConfig {
	searchMode: SearchMode;
	/** Model the /responses tools fall back to when the active one cannot. */
	fallbackModel: string;
	showReasoning: boolean;
	/** Output cap for qwen_deep_search, which can otherwise burn ~340k tokens. */
	deepSearchMaxTokens: number;
	/** Defaults for the generation models (native endpoints, not chat models). */
	imageModel: string;
	videoModel: string;
}

/** Verified working on this plan via the native multimodal-generation endpoint. */
const IMAGE_MODELS = ["wan2.7-image", "wan2.7-image-pro", "qwen-image-3.0-pro"];
/** Verified working via async submit + task polling. i2v/r2v need extra input. */
const VIDEO_MODELS = ["happyhorse-1.1-t2v", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v"];
const VIDEO_SIZES = ["1280*720", "1920*1080", "832*480"];

const DEFAULTS: QwenToolsConfig = {
	searchMode: "turbo",
	fallbackModel: "qwen3.7-max",
	showReasoning: false,
	deepSearchMaxTokens: 16384,
	imageModel: "wan2.7-image",
	videoModel: "happyhorse-1.1-t2v",
};

const MODE_NOTES: Record<SearchMode, string> = {
	off: "Model answers from memory. Cheapest; no fresh facts.",
	turbo: "~330 extra prompt tokens per turn. Searches, returns a fresh answer.",
	max: "~420 extra prompt tokens per turn. Wider search plus inline [n] citations.",
};

const SEARCH_MODES: SearchMode[] = ["off", "turbo", "max"];
const TOKEN_CAPS = [4096, 8192, 16384, 32768, 65536];

let config: QwenToolsConfig = { ...DEFAULTS };

function configPath(): string {
	return join(getAgentDir(), "qwen-tools.json");
}

function loadConfig(): void {
	try {
		const p = configPath();
		if (!existsSync(p)) return;
		const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<QwenToolsConfig>;
		config = {
			...DEFAULTS,
			...raw,
			searchMode: SEARCH_MODES.includes(raw.searchMode as SearchMode)
				? (raw.searchMode as SearchMode)
				: DEFAULTS.searchMode,
			deepSearchMaxTokens:
				typeof raw.deepSearchMaxTokens === "number" && raw.deepSearchMaxTokens > 0
					? raw.deepSearchMaxTokens
					: DEFAULTS.deepSearchMaxTokens,
			showReasoning: typeof raw.showReasoning === "boolean" ? raw.showReasoning : DEFAULTS.showReasoning,
			fallbackModel: typeof raw.fallbackModel === "string" && raw.fallbackModel ? raw.fallbackModel : DEFAULTS.fallbackModel,
		};
	} catch {
		config = { ...DEFAULTS };
	}
}

function saveConfig(): void {
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch (err) {
		lastSaveError = err instanceof Error ? err.message : String(err);
	}
}

let lastSaveError: string | undefined;

// -------------------------------------------------------------------- helpers

function isQwen(ctx: ExtensionContext): boolean {
	return (ctx.model?.provider ?? "").startsWith(PROVIDER_PREFIX);
}

function resolveProvider(ctx: ExtensionContext): string {
	const current = ctx.model?.provider ?? "";
	if (current.startsWith(PROVIDER_PREFIX)) return current;
	const ids = ctx.modelRegistry.getRegisteredProviderIds();
	return ids.find((id) => id.startsWith(PROVIDER_PREFIX)) ?? "qwen-token-plan-individual";
}

async function resolveEndpoint(ctx: ExtensionContext): Promise<{ baseUrl: string; apiKey: string }> {
	const provider = resolveProvider(ctx);
	const registered = ctx.modelRegistry.getProvider(provider);
	const baseUrl =
		(registered as { baseUrl?: string } | undefined)?.baseUrl ?? BASE_URLS[provider] ?? BASE_URLS["qwen-token-plan"];
	const apiKey = (await ctx.modelRegistry.getApiKeyForProvider(provider)) ?? "";
	if (!apiKey) throw new Error(`No API key resolved for ${provider}. Run /login.`);
	return { baseUrl, apiKey };
}

/** Chat-completions agent-mode side call (deep search): needs chat.agent support. */
function pickChatCapable(ctx: ExtensionContext, requested?: string): string {
	const active = ctx.model?.id ?? "";
	for (const c of [requested, active, config.fallbackModel]) {
		if (c && capsFor(c).chat.agent) return c;
	}
	return "qwen3.7-max";
}

/**
 * /responses tools: keep the ACTIVE model. Every chat model on this plan runs all
 * three built-in tools there, so downgrading to the fallback would silently bill a
 * different model than the one the user selected.
 */
function pickResponsesModel(ctx: ExtensionContext, tool: keyof Caps["responses"], requested?: string): string {
	const active = ctx.model?.id ?? "";
	for (const c of [requested, active, config.fallbackModel]) {
		if (c && capsFor(c).responses[tool]) return c;
	}
	return "qwen3.7-max";
}

// --------------------------------------------------------------- /responses

type ResponsesContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
/**
 * Bare content arrays are rejected for image input ("the role in last message must
 * be in [user, function, tool]") — images must arrive wrapped in a user message.
 */
type ResponsesInput = string | ResponsesContent[] | Array<{ role: string; content: ResponsesContent[] }>;

interface ResponsesResult {
	text: string;
	reasoning: string;
	traces: string[];
	/** Image URLs returned by web_search_image / image_search. */
	imageUrls: string[];
	/** Which built-in tools actually fired; the model may decline to use them. */
	callTypes: string[];
	status: string;
	usage?: { input_tokens?: number; output_tokens?: number };
}

/** `arguments` and `output` arrive as JSON-encoded strings; be defensive. */
function parseImageCall(o: any): { text: string; urls: string[] } {
	let args: unknown = o?.arguments ?? null;
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			/* keep raw */
		}
	}
	let out: unknown = o?.output ?? [];
	if (typeof out === "string") {
		try {
			out = JSON.parse(out);
		} catch {
			out = [];
		}
	}
	const rows = Array.isArray(out) ? out : [];
	const urls = rows
		.map((x: any) => (typeof x === "string" ? x : x?.url))
		.filter((u: unknown): u is string => typeof u === "string" && u.startsWith("http"));
	const listed = rows
		.slice(0, 12)
		.map((x: any, i: number) => `  ${i + 1}. ${x?.title ? String(x.title).slice(0, 100) + "\n     " : ""}${x?.url ?? x}`)
		.join("\n");
	return {
		text: `[${o?.type ?? "image_call"}] args: ${JSON.stringify(args)}\n${listed || "  (no results parsed)"}`,
		urls,
	};
}

/** Accept an http(s)/data URL directly, or inline a local file as a data URL. */
function toImagePart(image: string): { type: "input_image"; image_url: string } {
	if (/^(https?:|data:)/i.test(image)) return { type: "input_image", image_url: image };
	const path = image.replace(/^file:\/\//, "");
	if (!existsSync(path)) {
		throw new Error(`Image not found: ${image}. Pass an http(s) URL, a data: URL, or a local file path.`);
	}
	const buf = readFileSync(path);
	const MB = 1024 * 1024;
	if (buf.length > 4 * MB) {
		throw new Error(`Local image is ${(buf.length / MB).toFixed(1)} MB; the inline data-URL limit here is 4 MB. Use a URL instead.`);
	}
	const ext = (path.split(".").pop() ?? "png").toLowerCase();
	const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
	return { type: "input_image", image_url: `data:${mime};base64,${buf.toString("base64")}` };
}

async function responsesCall(
	ctx: ExtensionContext,
	options: { model: string; input: ResponsesInput; tools: string[]; maxTokens?: number; signal?: AbortSignal },
): Promise<ResponsesResult> {
	const { baseUrl, apiKey } = await resolveEndpoint(ctx);

	const res = await fetch(`${baseUrl}/responses`, {
		method: "POST",
		signal: options.signal,
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: options.model,
			input: options.input,
			max_output_tokens: options.maxTokens ?? 4096,
			tools: options.tools.map((type) => ({ type })),
		}),
	});

	const raw = await res.text();
	let r: any;
	try {
		r = JSON.parse(raw);
	} catch {
		throw new Error(`Qwen /responses returned non-JSON (${res.status}): ${raw.slice(0, 400)}`);
	}
	if (!res.ok || r?.error) {
		throw new Error(`Qwen /responses failed (${res.status}): ${r?.error?.message ?? String(raw).slice(0, 400)}`);
	}

	const traces: string[] = [];
	const callTypes: string[] = [];
	const imageUrls: string[] = [];
	let text = "";
	let reasoning = "";

	for (const o of r?.output ?? []) {
		switch (o?.type) {
			case "message":
				text += (o.content ?? []).map((c: any) => c?.text ?? "").join("");
				break;
			case "reasoning":
				reasoning += (o.summary ?? []).map((s: any) => s?.text ?? "").join("");
				break;
			case "web_search_call": {
				callTypes.push("web_search_call");
				const a = o.action ?? {};
				const sources = (a.sources ?? []).map((s: any) => s?.url).filter(Boolean);
				traces.push(
					`[web_search] query: ${a.query ?? "?"}` +
						(sources.length ? `\n  sources:\n${sources.map((s: string) => `    - ${s}`).join("\n")}` : ""),
				);
				break;
			}
			case "code_interpreter_call": {
				callTypes.push("code_interpreter_call");
				const logs = (o.outputs ?? []).map((x: any) => x?.logs ?? "").filter(Boolean).join("\n");
				traces.push(`[code_interpreter] code:\n${o.code ?? "?"}\n  container: ${o.container_id ?? "?"}\n  output:\n${logs || "(none)"}`);
				break;
			}
			case "web_extractor_call":
				callTypes.push("web_extractor_call");
				traces.push(`[web_extractor] urls: ${(o.urls ?? []).join(", ")}\n  goal: ${o.goal ?? "?"}\n  output:\n${o.output ?? "(none)"}`);
				break;
			case "web_search_image_call":
			case "image_search_call": {
				callTypes.push(String(o.type));
				const img = parseImageCall(o);
				traces.push(img.text);
				imageUrls.push(...img.urls);
				break;
			}
			default:
				if (o?.type) {
					if (String(o.type).endsWith("_call")) callTypes.push(String(o.type));
					traces.push(`[${o.type}] ${JSON.stringify(o).slice(0, 400)}`);
				}
		}
	}

	return {
		text: text.trim() || "(no message content)",
		reasoning: reasoning.trim(),
		traces,
		imageUrls: [...new Set(imageUrls)],
		callTypes,
		status: r?.status ?? "?",
		usage: r?.usage,
	};
}

function formatResponses(t: ResponsesResult, expectCall?: string): string {
	const parts: string[] = [];
	if (t.traces.length) parts.push(`=== tool trace ===\n${t.traces.join("\n\n")}`);
	if (config.showReasoning && t.reasoning) parts.push(`=== reasoning ===\n${t.reasoning}`);
	parts.push(`=== result ===\n${t.text}`);
	// Tool use is discretionary: the model can answer from memory and look confident.
	// Say so loudly instead of returning an unlabelled guess.
	if (expectCall && !t.callTypes.includes(expectCall)) {
		parts.push(
			`[WARNING: ${expectCall} never fired — this answer may be from model memory, NOT from a real search/execution. Retry with a more explicit ask or another model.]`,
		);
	}
	if (t.imageUrls.length) {
		parts.push(`=== image urls (${t.imageUrls.length}) ===\n${t.imageUrls.map((u, i) => `  ${i + 1}. ${u}`).join("\n")}`);
	}
	if (t.status === "incomplete") parts.push("[status: incomplete — raised max_output_tokens; narrow the ask or retry]");
	if (t.usage) parts.push(`[tokens: in=${t.usage.input_tokens ?? "?"} out=${t.usage.output_tokens ?? "?"}]`);
	return parts.join("\n\n");
}

// ------------------------------------------------ /chat/completions agent mode

interface AgentResult {
	text: string;
	reasoning: string;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * Agent mode rejects any `tools` array, so this is a side call: streaming, with
 * `enable_code_interpreter` or `search_strategy:"agent"` rather than pi's tools.
 */
async function agentModeCall(
	ctx: ExtensionContext,
	options: {
		model: string;
		prompt: string;
		extra: Record<string, unknown>;
		signal?: AbortSignal;
		maxTokens?: number;
		onUpdate?: (text: string) => void;
	},
): Promise<AgentResult> {
	const { baseUrl, apiKey } = await resolveEndpoint(ctx);

	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		signal: options.signal,
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: options.model,
			stream: true,
			stream_options: { include_usage: true },
			enable_thinking: true,
			max_tokens: options.maxTokens ?? 8192,
			messages: [{ role: "user", content: options.prompt }],
			...options.extra,
		}),
	});

	if (!res.ok || !res.body) {
		const detail = (await res.text().catch(() => "")).slice(0, 500);
		throw new Error(`Qwen agent-mode call failed (${res.status}): ${detail}`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let content = "";
	let reasoning = "";
	let usage: AgentResult["usage"];

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let nl: number;
		while ((nl = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith("data:")) continue;
			const chunk = line.slice(5).trim();
			if (!chunk || chunk === "[DONE]") continue;

			let parsed: any;
			try {
				parsed = JSON.parse(chunk);
			} catch {
				continue;
			}
			if (parsed?.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
			if (parsed?.usage) usage = parsed.usage;
			for (const choice of parsed?.choices ?? []) {
				const delta = choice?.delta ?? {};
				if (typeof delta.content === "string") {
					content += delta.content;
					options.onUpdate?.(content);
				}
				if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
			}
		}
	}

	return { text: content.trim() || "(empty response)", reasoning: reasoning.trim(), usage };
}

// ------------------------------------------------------- native generation API

const MG_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
const VIDEO_PATH = "/api/v1/services/aigc/video-generation/video-synthesis";

interface NativeResponse {
	status: number;
	body: any;
}

async function nativeCall(
	ctx: ExtensionContext,
	path: string,
	body: unknown,
	options?: { async?: boolean; signal?: AbortSignal; timeoutMs?: number },
): Promise<NativeResponse> {
	const { baseUrl, apiKey } = await resolveEndpoint(ctx);
	// baseUrl ends in /compatible-mode/v1; the native API hangs off the host root.
	const origin = new URL(baseUrl).origin;
	const res = await fetch(`${origin}${path}`, {
		method: "POST",
		signal: options?.signal,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			...(options?.async ? { "X-DashScope-Async": "enable" } : {}),
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: any = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		/* keep text */
	}
	if (!res.ok) {
		const msg = parsed?.message ?? parsed?.code ?? String(text).slice(0, 200);
		throw new Error(`Qwen native ${path.split("/").pop()} failed (${res.status}): ${msg}`);
	}
	return { status: res.status, body: parsed };
}

async function pollTask(
	ctx: ExtensionContext,
	taskId: string,
	options?: { signal?: AbortSignal; onTick?: (status: string, elapsedS: number) => void; timeoutMs?: number },
): Promise<any> {
	const { baseUrl, apiKey } = await resolveEndpoint(ctx);
	const origin = new URL(baseUrl).origin;
	const deadline = Date.now() + (options?.timeoutMs ?? 10 * 60 * 1000);
	let attempt = 0;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, Math.min(3000 + attempt * 1500, 15000)));
		attempt++;
		const res = await fetch(`${origin}/api/v1/tasks/${taskId}`, {
			signal: options?.signal,
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		const body = await res.json().catch(() => ({}));
		const status = body?.output?.task_status ?? "UNKNOWN";
		options?.onTick?.(status, Math.round((Date.now() - (deadline - (options?.timeoutMs ?? 600000))) / 1000));
		if (status === "SUCCEEDED" || status === "FAILED" || status === "UNKNOWN") return body?.output ?? {};
	}
	throw new Error(`Task ${taskId} did not finish within the timeout; poll /api/v1/tasks/${taskId} later.`);
}

/** Extract every image URL from a multimodal-generation response. */
function extractImageUrls(body: any): string[] {
	const urls: string[] = [];
	for (const choice of body?.output?.choices ?? []) {
		for (const part of choice?.message?.content ?? []) {
			if (typeof part?.image === "string") urls.push(part.image);
			if (typeof part?.image_url?.url === "string") urls.push(part.image_url.url);
		}
	}
	if (typeof body?.output?.image_url === "string") urls.push(body.output.image_url);
	return [...new Set(urls)];
}

/** Shared core so the tool and the /qimage command behave identically. */
async function generateImage(
	ctx: ExtensionContext,
	opts: { prompt: string; model?: string; negativePrompt?: string; size?: string; signal?: AbortSignal },
): Promise<{ model: string; urls: string[]; raw: unknown }> {
	const model = opts.model && IMAGE_MODELS.includes(opts.model) ? opts.model : config.imageModel;
	const parameters: Record<string, unknown> = { result_format: "message" };
	if (opts.size) parameters.size = opts.size;
	if (opts.negativePrompt) parameters.negative_prompt = opts.negativePrompt;
	const r = await nativeCall(ctx, MG_PATH, {
		model,
		input: { messages: [{ role: "user", content: [{ text: opts.prompt }] }] },
		parameters,
	}, { signal: opts.signal });
	return { model, urls: extractImageUrls(r.body), raw: r.body };
}

/** Shared core for /qvideo and qwen_generate_video. Blocks on task polling. */
async function generateVideo(
	ctx: ExtensionContext,
	opts: { prompt: string; model?: string; size?: string; signal?: AbortSignal; onTick?: (s: string, sec: number) => void },
): Promise<{ model: string; taskId: string; status: string; url?: string }> {
	const model = opts.model && VIDEO_MODELS.includes(opts.model) ? opts.model : config.videoModel;
	const submit = await nativeCall(
		ctx,
		VIDEO_PATH,
		{
			model,
			input: { prompt: opts.prompt },
			parameters: { size: opts.size && VIDEO_SIZES.includes(opts.size) ? opts.size : VIDEO_SIZES[0] },
		},
		{ async: true, signal: opts.signal },
	);
	const taskId = submit.body?.output?.task_id;
	if (!taskId) throw new Error(`No task_id returned: ${JSON.stringify(submit.body).slice(0, 300)}`);
	const out = await pollTask(ctx, taskId, { signal: opts.signal, onTick: opts.onTick });
	return { model, taskId, status: out?.task_status ?? "UNKNOWN", url: out?.video_url };
}

/** Parse `/qimage a cat -m wan2.7-image-pro -s 1024*1024` style args. */
/**
 * Download a hosted media URL into <cwd>/out/qtools/. The commands do this because
 * these signed OSS URLs are long enough to wrap across terminal rows, so copying one
 * out of the notify panel reliably yields a truncated (failing) link.
 */
async function saveMedia(ctx: ExtensionContext, url: string, model: string, signal?: AbortSignal): Promise<string> {
	const dir = join(ctx.cwd, "out", "qtools");
	mkdirSync(dir, { recursive: true });
	const ext = (url.split("?")[0].match(/\.(png|jpe?g|webp|mp4|wav|mp3)$/i) ?? [])[0]?.toLowerCase() || ".bin";
	const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
	const dest = join(dir, `${model}-${stamp}${ext}`);
	const res = await fetch(url, { signal });
	if (!res.ok) throw new Error(`download failed (${res.status}) for ${url.slice(0, 80)}`);
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(dest, buf);
	return `${dest} (${(buf.length / 1024).toFixed(0)} KB)`;
}

function parseGenArgs(args: string, models: string[]): { prompt: string; model?: string; size?: string } {
	const tokens = args.trim().split(/\s+/);
	const parts: string[] = [];
	let model: string | undefined;
	let size: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if ((t === "-m" || t === "--model") && tokens[i + 1]) {
			const m = tokens[++i];
			model = models.includes(m) ? m : undefined;
			if (!model) parts.push(m); // not a known model: treat as prompt text
		} else if ((t === "-s" || t === "--size") && tokens[i + 1]) {
			size = tokens[++i].replace(/[x×]/g, "*");
		} else {
			parts.push(t);
		}
	}
	return { prompt: parts.join(" ").trim(), model, size };
}

function formatUrls(label: string, model: string, urls: string[]): string {
	if (!urls.length) return `${label}: no URL in the response from ${model}.`;
	return `${label} from ${model} (${urls.length}):\n${urls.map((u, i) => `  ${i + 1}. ${u}`).join("\n")}\n\nHosted URLs expire; download if you need to keep them.`;
}

// -------------------------------------------------------------- settings TUI

/**
 * `theme` is only a *type* export from pi-coding-agent, not a runtime value, so the
 * theme object has to come from the ctx.ui.custom callback argument.
 */
interface ThemeLike {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

function makeSubmenu(
	th: ThemeLike,
	title: string,
	items: SelectItem[],
	current: string,
	done: (value?: string) => void,
): { render: (w: number) => string[]; invalidate: () => void; handleInput: (d: string) => void } {
	const container = new Container();
	container.addChild(new Text(`${th.fg("accent", th.bold(title))}`, 0, 0));
	container.addChild(new Spacer(1));

	const list = new SelectList(items, Math.min(items.length + 2, 12), getSelectListTheme());
	const idx = items.findIndex((i) => i.value === current);
	if (idx >= 0) list.setSelectedIndex(idx);
	list.onSelect = (item) => done(item.value);
	list.onCancel = () => done(undefined);
	container.addChild(list);

	return {
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => list.handleInput(data),
	};
}

function capabilitySummary(caps: Caps): string {
	const y = (b: boolean) => (b ? "yes" : "NO");
	return (
		`chat: search ${y(caps.chat.search)}, agent ${y(caps.chat.agent)}, code ${y(caps.chat.ci)}` +
		` | /responses: search ${y(caps.responses.web_search)}, code ${y(caps.responses.code_interpreter)},` +
		` extract ${y(caps.responses.web_extractor)},` +
		` t2i-img ${y(caps.responses.web_search_image)}, i2i-img ${y(caps.responses.image_search)}`
	);
}

/**
 * Console capability label -> the `tools[].type` string the API actually wants.
 * This is the trap that made me mis-report both image tools as dead: the Qwen UI
 * says t2i_search / i2i_search, but sending those as a type is silently accepted
 * and ignored, exactly like a made-up name. Real names are below.
 */
const TYPE_MAP: Array<{ label: string; type: string; tool: string }> = [
	{ label: "web_search", type: "web_search", tool: "qwen_web_search" },
	{ label: "web_extractor", type: "web_extractor", tool: "qwen_web_extractor (needs web_search)" },
	{ label: "code_interpreter", type: "code_interpreter", tool: "qwen_code_interpreter" },
	{ label: "t2i_search", type: "web_search_image", tool: "qwen_image_search" },
	{ label: "i2i_search", type: "image_search", tool: "qwen_reverse_image_search" },
];

function capabilityItems(): SelectItem[] {
	return Object.entries(CAPS).map(([id, caps]) => ({
		value: id,
		label: id,
		description: capabilitySummary(caps),
	}));
}

function typeMapItems(): SelectItem[] {
	return TYPE_MAP.map((t) => ({
		value: t.type,
		label: `${t.label}  ->  "${t.type}"`,
		description: `${t.tool} | works on: ${modelsSupporting(t.type as keyof Caps["responses"]).join(", ") || "none"}`,
	}));
}

/** Descriptions are recomputed after every change so they never go stale. */
function descriptionFor(id: string, ctx: ExtensionContext): string {
	const model = ctx.model?.id ?? "?";
	const caps = capsFor(model);
	switch (id) {
		case "searchMode":
			return (
				MODE_NOTES[config.searchMode] +
				(caps.chat.search ? "" : ` — WARNING: ${model} rejects enable_search, so injection is skipped`)
			);
		case "fallbackModel":
			return `Model the qwen_* tools run on only when the active model cannot. Currently ${config.fallbackModel}. (/responses tools use the active model — every chat model here supports them.)`;
		case "showReasoning":
			return "Adds the model's own plan/rationale to tool results. More context, more tokens.";
		case "deepSearchMaxTokens":
			return `max_tokens cap for qwen_deep_search. It burned ~340k prompt tokens uncapped; limit is ${config.deepSearchMaxTokens} now.`;
		case "capabilities":
			return "Measured against the live endpoint. Note the two image tools are gated differently.";
		case "imageModel":
			return `Default for qwen_generate_image and /qimage. All three verified working via the native multimodal-generation endpoint.`;
		case "videoModel":
			return `Default for qwen_generate_video and /qvideo. t2v verified end to end (~96s for 720p). i2v/r2v need an extra input.`;
		case "typemap":
			return "Console capability labels differ from the API tools[].type strings. Sending a label is silently ignored.";
		case "provider":
			return "Where the API key and base URL come from, plus whether the active model is a Qwen plan model.";
	}
	return "";
}

function buildItems(ctx: ExtensionContext, th: ThemeLike): SettingItem[] {
	const model = ctx.model?.id ?? "?";
	const caps = capsFor(model);
	const y = (b: boolean) => (b ? "y" : "-");
	const capLine =
		`${model}: chat ${y(caps.chat.search)}${y(caps.chat.agent)}${y(caps.chat.ci)}` +
		` | res ${y(caps.responses.web_search)}${y(caps.responses.code_interpreter)}${y(caps.responses.web_extractor)}` +
		`${y(caps.responses.web_search_image)}${y(caps.responses.image_search)}`;
	return [
		{
			id: "searchMode",
			label: "Main-loop web search",
			description: descriptionFor("searchMode", ctx),
			currentValue: config.searchMode,
			values: [...SEARCH_MODES],
		},
		{
			id: "fallbackModel",
			label: "Built-in tool model",
			description: descriptionFor("fallbackModel", ctx),
			currentValue: config.fallbackModel,
			// NOTE: do NOT pass { navigateTo } to done(). Verified against pi-tui 0.87.1:
			// closeSubmenu() leaves submenuComponent set, so the submenu never closes
			// (onChange still fires, so it looks like a render hang). The cursor already
			// returns to this row, so navigateTo buys nothing here.
			submenu: (current, done) => makeSubmenu(th, "Built-in tool model", capabilityItems(), current, (v) => done(v)),
		},
		{
			id: "showReasoning",
			label: "Include model reasoning",
			description: descriptionFor("showReasoning", ctx),
			currentValue: config.showReasoning ? "enabled" : "disabled",
			values: ["disabled", "enabled"],
		},
		{
			id: "deepSearchMaxTokens",
			label: "Deep search output cap",
			description: descriptionFor("deepSearchMaxTokens", ctx),
			currentValue: String(config.deepSearchMaxTokens),
			submenu: (current, done) =>
				makeSubmenu(
					th,
					"Deep search output cap",
					TOKEN_CAPS.map((n) => ({ value: String(n), label: String(n) })),
					current,
					(v) => done(v),
				),
		},
		{
			id: "imageModel",
			label: "Default image model",
			description: descriptionFor("imageModel", ctx),
			currentValue: config.imageModel,
			submenu: (current, done) =>
				makeSubmenu(th, "Default image model", IMAGE_MODELS.map((m) => ({ value: m, label: m })), current, (v) => done(v)),
		},
		{
			id: "videoModel",
			label: "Default video model",
			description: descriptionFor("videoModel", ctx),
			currentValue: config.videoModel,
			submenu: (current, done) =>
				makeSubmenu(
					th,
					"Default video model",
					VIDEO_MODELS.map((m) => ({
						value: m,
						label: m,
						description: m.endsWith("t2v") ? "text -> video (verified end to end)" : "needs an extra image/reference input",
					})),
					current,
					(v) => done(v),
				),
		},
		{
			id: "typemap",
			label: "Tool names (label vs API)",
			description: descriptionFor("typemap", ctx),
			currentValue: `${TYPE_MAP.length} mapped`,
			submenu: (_current, done) => makeSubmenu(th, "Console label -> API tools[].type", typeMapItems(), "", () => done(undefined)),
		},
		{
			id: "capabilities",
			label: "Per-model capabilities",
			description: descriptionFor("capabilities", ctx),
			currentValue: capLine,
			submenu: (_current, done) => makeSubmenu(th, "Per-model capabilities", capabilityItems(), "", () => done(undefined)),
		},
		{
			id: "provider",
			label: "Provider",
			description: descriptionFor("provider", ctx),
			currentValue: `${resolveProvider(ctx)}${isQwen(ctx) ? " (active)" : " (not active)"}`,
		},
	];
}

function applyChange(id: string, value: string): void {
	switch (id) {
		case "searchMode":
			if (SEARCH_MODES.includes(value as SearchMode)) config.searchMode = value as SearchMode;
			break;
		case "fallbackModel":
			if (value) config.fallbackModel = value;
			break;
		case "showReasoning":
			config.showReasoning = value === "enabled";
			break;
		case "imageModel":
			if (IMAGE_MODELS.includes(value)) config.imageModel = value;
			break;
		case "videoModel":
			if (VIDEO_MODELS.includes(value)) config.videoModel = value;
			break;
		case "deepSearchMaxTokens": {
			const n = Number.parseInt(value, 10);
			if (Number.isFinite(n) && n > 0) config.deepSearchMaxTokens = n;
			break;
		}
	}
	saveConfig();
}

// ------------------------------------------------------------------ extension

loadConfig();

export default function (pi: ExtensionAPI): void {
	// ---- main-loop web_search injection (chat/completions) ----
	pi.on("before_provider_request", (event, ctx) => {
		if (config.searchMode === "off" || !isQwen(ctx)) return undefined;

		const payload = event.payload;
		if (!payload || typeof payload !== "object") return undefined;
		const body = payload as Record<string, unknown>;
		if (typeof body.model !== "string") return undefined;
		if (!searchCapable(body.model)) return undefined;

		return {
			...body,
			enable_search: true,
			search_options: {
				// Never "agent": that is Agent mode and rejects pi's tools.
				search_strategy: config.searchMode,
				enable_source: true,
				enable_citation: config.searchMode === "max",
			},
		};
	});

	// ------------------------------------------------------------------- tools
	pi.registerTool({
		name: "qwen_web_search",
		label: "Qwen Web Search",
		description:
			"Server-side web search via Qwen's Responses API. Returns the answer plus the actual queries " +
			"issued and the source URLs consulted. Use when you need current facts with citations.",
		promptSnippet: "Search the web and get back answers with source URLs",
		promptGuidelines: [
			"Use qwen_web_search when you need current or verifiable facts with source URLs, and want the search performed server-side rather than via curl.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The search question or query." }),
			model: Type.Optional(Type.String({ description: "Override model id." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `searching: ${params.query}` }] });
			const model = pickResponsesModel(ctx, "web_search", params.model);
			const t = await responsesCall(ctx, { model, input: params.query, tools: ["web_search"], signal });
			return {
				content: [{ type: "text", text: formatResponses(t, "web_search_call") }],
				details: { status: t.status, model, usage: t.usage, callTypes: t.callTypes },
			};
		},
	});

	pi.registerTool({
		name: "qwen_web_extractor",
		label: "Qwen Web Extractor",
		description:
			"Scrape and extract content from specific URLs via Qwen's Responses API web_extractor tool. " +
			"Returns the page text relevant to your stated goal. web_extractor requires web_search, so both are enabled.",
		promptSnippet: "Extract content from specific URLs toward a stated goal",
		promptGuidelines: [
			"Use qwen_web_extractor to read the content of a known URL when local curl is blocked or the page needs rendering/extraction, stating a clear goal.",
		],
		parameters: Type.Object({
			urls: Type.Array(Type.String(), { description: "One or more URLs to extract from." }),
			goal: Type.String({ description: "What information to pull out of those pages." }),
			model: Type.Optional(Type.String({ description: "Override model id." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `extracting ${params.urls.length} url(s)` }] });
			const model = pickResponsesModel(ctx, "web_extractor", params.model);
			const t = await responsesCall(ctx, {
				model,
				input: `Extract from these URLs: ${params.urls.join(", ")}\nGoal: ${params.goal}`,
				tools: ["web_search", "web_extractor"],
				maxTokens: 6144,
				signal,
			});
			return {
				content: [{ type: "text", text: formatResponses(t, "web_extractor_call") }],
				details: { status: t.status, model, urls: params.urls, usage: t.usage, callTypes: t.callTypes },
			};
		},
	});

	pi.registerTool({
		name: "qwen_code_interpreter",
		label: "Qwen Code Interpreter",
		description:
			"Execute Python in Alibaba's sandboxed server-side code interpreter. Returns the code it ran, " +
			"the container id, and the real stdout/stderr. Use for exact numeric, crypto, hash, or math results.",
		promptSnippet: "Run Python in Alibaba's sandboxed server-side code interpreter",
		promptGuidelines: [
			"Use qwen_code_interpreter when an answer needs real code execution rather than recall, such as SHA/MD5 digests, big-integer math, statistics over a pasted dataset, or confirming an algorithm's exact output.",
			"qwen_code_interpreter runs in an isolated Alibaba sandbox with no access to the local filesystem or network, so use bash for local work.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Self-contained instruction, including any input data inline." }),
			model: Type.Optional(Type.String({ description: "Override model id." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "running in sandbox..." }] });
			const model = pickResponsesModel(ctx, "code_interpreter", params.model);
			const t = await responsesCall(ctx, { model, input: params.task, tools: ["code_interpreter"], maxTokens: 6144, signal });
			return {
				content: [{ type: "text", text: formatResponses(t, "code_interpreter_call") }],
				details: { status: t.status, model, usage: t.usage, callTypes: t.callTypes },
			};
		},
	});

	// --------------------------------------------------------- qwen_image_search
	// Console label "t2i_search"; the API type string is web_search_image.
	// Sending "t2i_search" is silently ignored, like any unknown type.
	pi.registerTool({
		name: "qwen_image_search",
		label: "Qwen Image Search (text -> images)",
		description:
			"Search the web for images matching a text description, using Qwen's server-side web_search_image " +
			"tool. Returns the image URLs it found plus the queries it issued. Qwen runs the retrieval; results " +
			"are real URLs, not model guesses. Supported by qwen3.8-max only on this plan.",
		promptSnippet: "Find images on the web from a text description",
		promptGuidelines: [
			"Use qwen_image_search when the user wants pictures of something found on the web, as opposed to qwen_web_search which retrieves text sources.",
			"Report qwen_image_search results as links; the sandbox cannot render images inline.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to find images of, as a short descriptive phrase." }),
			model: Type.Optional(Type.String({ description: "Override model id (only qwen3.8-max supports this tool)." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `image search: ${params.query}` }] });
			const model = pickResponsesModel(ctx, "web_search_image", params.model);
			const t = await responsesCall(ctx, { model, input: params.query, tools: ["web_search_image"], maxTokens: 4096, signal });
			return {
				content: [{ type: "text", text: formatResponses(t, "web_search_image_call") }],
				details: { status: t.status, model, usage: t.usage, callTypes: t.callTypes, imageUrls: t.imageUrls },
			};
		},
	});

	// ------------------------------------------------- qwen_reverse_image_search
	// Console label "i2i_search"; the API type string is image_search. The service
	// fetches the image itself, so even models that reject image *input* can drive it.
	pi.registerTool({
		name: "qwen_reverse_image_search",
		label: "Qwen Reverse Image Search (image -> images)",
		description:
			"Find visually similar images on the web for a given image, using Qwen's server-side image_search " +
			"tool. Accepts an http(s) URL, a data: URL, or a local file path (inlined as base64, 4 MB cap). " +
			"Useful for identifying what is in an image, finding sources, or locating higher-resolution versions.",
		promptSnippet: "Reverse image search: find similar images from a URL or local file",
		promptGuidelines: [
			"Use qwen_reverse_image_search when the user supplies an image and asks where it is from, what it depicts, or wants similar images.",
			"qwen_reverse_image_search takes a local path or URL; prefer a URL for files larger than 4 MB.",
		],
		parameters: Type.Object({
			image: Type.String({ description: "Image to search by: http(s) URL, data: URL, or local file path." }),
			question: Type.Optional(
				Type.String({ description: "Optional instruction shaping the search, e.g. 'find the original photo'." }),
			),
			model: Type.Optional(Type.String({ description: "Override model id." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "reverse image search..." }] });
			const model = pickResponsesModel(ctx, "image_search", params.model);
			const input: ResponsesInput = [
				{
					role: "user",
					content: [
						toImagePart(params.image),
						{
							type: "input_text",
							text: params.question?.trim() || "Find visually similar images and list their URLs.",
						},
					],
				},
			];
			const t = await responsesCall(ctx, { model, input, tools: ["image_search"], maxTokens: 4096, signal });
			return {
				content: [{ type: "text", text: formatResponses(t, "image_search_call") }],
				details: { status: t.status, model, usage: t.usage, callTypes: t.callTypes, imageUrls: t.imageUrls },
			};
		},
	});

	pi.registerTool({
		name: "qwen_deep_search",
		label: "Qwen Deep Search",
		description:
			"Qwen's multi-step 'agent' web search strategy: plans, issues several queries, and synthesises a " +
			"sourced answer. Much deeper than qwen_web_search but far more expensive (~300k prompt tokens " +
			"observed). Runs via chat/completions Agent mode, which cannot be combined with other tools.",
		promptSnippet: "Multi-step agentic web research with sources (expensive)",
		promptGuidelines: [
			"Use qwen_deep_search only for research needing several searches or cross-checking sources, such as tracing a breaking change or resolving conflicting documentation; prefer qwen_web_search for single-fact lookups because qwen_deep_search is very token-expensive.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The research question." }),
			model: Type.Optional(Type.String({ description: "Override model id." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "deep searching (agent strategy)..." }] });
			const model = pickChatCapable(ctx, params.model);
			const r = await agentModeCall(ctx, {
				model,
				prompt: params.query,
				maxTokens: config.deepSearchMaxTokens,
				signal,
				extra: {
					enable_search: true,
					search_options: { search_strategy: "agent", enable_source: true, enable_citation: true },
				},
				onUpdate: (t) => onUpdate?.({ content: [{ type: "text", text: t.slice(-2000) }] }),
			});
			const body = config.showReasoning && r.reasoning ? `\n\n<reasoning>\n${r.reasoning}\n</reasoning>` : "";
			const meta = r.usage ? `\n\n[tokens: prompt=${r.usage.prompt_tokens ?? "?"} total=${r.usage.total_tokens ?? "?"}]` : "";
			return { content: [{ type: "text", text: `${r.text}${body}${meta}` }], details: { model, usage: r.usage } };
		},
	});

	// ------------------------------------------------------ qwen_generate_image
	pi.registerTool({
		name: "qwen_generate_image",
		label: "Qwen Image Generation",
		description:
			"Generate images with the Qwen plan's image models (wan2.7-image, wan2.7-image-pro, qwen-image-3.0-pro) " +
			"through the native multimodal-generation endpoint. These are not chat models, so they are unreachable " +
			"from pi's normal model list. Returns temporary hosted image URLs.",
		promptSnippet: "Generate images with Qwen/Wan image models",
		promptGuidelines: [
			"Use qwen_generate_image when the user asks to create or draw an image; report the returned URLs as links and note they are temporary hosted files.",
			"qwen_generate_image cannot render images in the terminal, so hand the user the URL rather than describing pixels you cannot see.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "What to draw." }),
			model: Type.Optional(Type.String({ description: `Override model. One of: ${IMAGE_MODELS.join(", ")}.` })),
			negativePrompt: Type.Optional(Type.String({ description: "What to avoid." })),
			size: Type.Optional(Type.String({ description: "Pixel size, e.g. 1024*1024." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "generating image..." }] });
			const r = await generateImage(ctx, { ...params, signal });
			const text = r.urls.length
				? formatUrls("Generated images", r.model, r.urls)
				: `No image URL returned by ${r.model}:\n${JSON.stringify(r.raw).slice(0, 600)}`;
			return { content: [{ type: "text", text }], details: { model: r.model, urls: r.urls } };
		},
	});

	// ------------------------------------------------------ qwen_generate_video
	pi.registerTool({
		name: "qwen_generate_video",
		label: "Qwen Video Generation",
		description:
			"Generate a short video from text with the plan's HappyHorse models, using the async task API " +
			"(submit then poll). Blocks until the task finishes, which took ~96s for a 720p clip in testing. " +
			"happyhorse-1.1-t2v is verified end to end; i2v/r2v need an extra image input this tool does not send yet.",
		promptSnippet: "Generate a short video from a text prompt (slow)",
		promptGuidelines: [
			"Use qwen_generate_video only when the user explicitly asks for generated video, and warn them it takes a couple of minutes since it blocks.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Scene and motion description." }),
			model: Type.Optional(Type.String({ description: `Override model. One of: ${VIDEO_MODELS.join(", ")}.` })),
			size: Type.Optional(Type.String({ description: `One of: ${VIDEO_SIZES.join(", ")}.` })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "submitting video task..." }] });
			const r = await generateVideo(ctx, {
				...params,
				signal,
				onTick: (st, sec) => onUpdate?.({ content: [{ type: "text", text: `video ${st} (${sec}s)` }] }),
			});
			const text =
				r.status === "SUCCEEDED"
					? formatUrls("Generated video", r.model, r.url ? [r.url] : []) + `\n(task ${r.taskId})`
					: `Video task ${r.status} (task ${r.taskId})`;
			return { content: [{ type: "text", text }], details: r };
		},
	});

	// ---------------------------------------------------------------- commands
	pi.registerCommand("qimage", {
		description: `Generate an image (default model: ${config.imageModel})`,
		handler: async (args, ctx) => {
			const { prompt, model, size } = parseGenArgs(args, IMAGE_MODELS);
			if (!prompt) {
				ctx.ui.notify("Usage: /qimage <prompt> [-m model] [-s WxH]", "error");
				return;
			}
			ctx.ui.notify(`Generating image with ${model || config.imageModel}...`, "info");
			const r = await generateImage(ctx, { prompt, model, size });
			if (!r.urls.length) {
				ctx.ui.notify(`No image URL from ${r.model}`, "error");
				return;
			}
			// Save locally: the signed URLs wrap across terminal rows and are unreliable
			// to copy out of the panel.
			const saved = await Promise.all(r.urls.map((u) => saveMedia(ctx, u, r.model)));
			ctx.ui.notify(`Image from ${r.model} saved:\n${saved.map((s) => "  " + s).join("\n")}`, "success");
		},
	});

	pi.registerCommand("qvideo", {
		description: `Generate a video, blocking (default model: ${config.videoModel})`,
		handler: async (args, ctx) => {
			const { prompt, model, size } = parseGenArgs(args, VIDEO_MODELS);
			if (!prompt) {
				ctx.ui.notify("Usage: /qvideo <prompt> [-m model] [-s WxH]", "error");
				return;
			}
			const stop = ctx.ui.setWorkingMessage?.("Submitting video task (takes ~1-3 min)...");
			const r = await generateVideo(ctx, {
				prompt,
				model,
				size,
				onTick: (st) => ctx.ui.notify(`video ${st}`, "info"),
			});
			void stop;
			if (r.status === "SUCCEEDED" && r.url) {
				const saved = await saveMedia(ctx, r.url, r.model).catch((e) => `save failed: ${e.message}`);
				ctx.ui.notify(`Video from ${r.model}:\n  ${saved}`, "success");
			} else {
				ctx.ui.notify(`Video task ${r.status} (task ${r.taskId})`, "error");
			}
		},
	});

	pi.registerCommand("qtools-config", {
		description: "Configure Qwen web search, built-in tools, and model fallback",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/qtools-config requires TUI mode. Config file: " + configPath(), "info");
				return;
			}
			await ctx.ui.custom((_tui, th, _kb, done) => {
				const items = buildItems(ctx, th);
				const container = new Container();
				container.addChild(new Text(th.fg("accent", th.bold("Qwen Tools Configuration")), 0, 0));
				container.addChild(new Spacer(1));

				const list = new SettingsList(
					items,
					Math.min(items.length + 2, 14),
					getSettingsListTheme(),
					(id, value) => {
						applyChange(id, value);
						for (const row of items) {
							row.description = descriptionFor(row.id, ctx);
							list.updateValue(row.id, row.currentValue);
						}
						_tui.requestRender();
					},
					() => {
						if (lastSaveError) ctx.ui.notify(`Could not save config: ${lastSaveError}`, "error");
						done(undefined);
					},
					{ enableSearch: true },
				);

				container.addChild(list);

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						list.handleInput(data);
						_tui.requestRender();
					},
				};
			});
		},
	});
}
