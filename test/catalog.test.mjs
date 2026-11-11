#!/usr/bin/env node
// Catalog-merge tests: no network, no credentials, no pi install.
//   node --experimental-strip-types test/catalog.test.mjs
//
// The rule these protect: pi's refreshModels return value REPLACES the provider's
// entire model list. A merge that drops the baseline would silently delete every
// model pi knows about, leaving only our four rows.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { mergeCatalog, missingIds, QTOOLS_MODELS, PLAN_PROVIDERS } = await import(
	join(here, "..", "src", "catalog.ts")
);

let failures = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`  ok   ${name}`);
	} catch (e) {
		failures++;
		console.log(`  FAIL ${name}\n       ${e.message.split("\n")[0]}`);
	}
}

const piCatalog = [
	{ id: "qwen3.8-max", name: "Qwen3.8 Max", contextWindow: 1000000 },
	{ id: "qwen3.7-max", name: "Qwen3.7 Max", contextWindow: 1000000 },
	{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 1000000 },
];

// 1. The destructive case: no baseline must never yield a replacement list.
check("empty baseline is flagged unsafe, not silently replaced", () => {
	for (const baseline of [undefined, []]) {
		const r = mergeCatalog(baseline);
		assert.equal(r.unsafe, true);
		assert.deepEqual(r.models, []);
		assert.deepEqual(r.added, []);
	}
});

// 2. Baseline survives verbatim, including pi's own metadata.
check("baseline models are preserved in order and unchanged", () => {
	const r = mergeCatalog(piCatalog);
	assert.equal(r.unsafe, false);
	assert.deepEqual(r.models.slice(0, 3), piCatalog);
	assert.equal(r.models.length, piCatalog.length + QTOOLS_MODELS.length);
});

// 3. Only genuinely missing ids are added.
check("adds exactly the ids pi lacks", () => {
	const r = mergeCatalog(piCatalog);
	assert.deepEqual(r.added, QTOOLS_MODELS.map((m) => m.id));
	assert.deepEqual(missingIds(piCatalog), r.added);
});

check("adds nothing when pi already knows every curated id", () => {
	const full = [...piCatalog, ...QTOOLS_MODELS];
	const r = mergeCatalog(full);
	assert.deepEqual(r.added, []);
	assert.equal(r.models.length, full.length);
});

check("partial overlap adds only the remainder", () => {
	const partial = [...piCatalog, QTOOLS_MODELS[0]];
	const r = mergeCatalog(partial);
	assert.deepEqual(r.added, QTOOLS_MODELS.slice(1).map((m) => m.id));
});

// 4. pi's metadata wins for an id it already knows — its catalog is vendor-refreshed.
check("pi's own row wins over our curated row for the same id", () => {
	const theirs = { id: "qwen4-max-preview", name: "Vendor Name", contextWindow: 262144 };
	const r = mergeCatalog([theirs]);
	const row = r.models.find((m) => m.id === "qwen4-max-preview");
	assert.equal(row.name, "Vendor Name");
	assert.equal(row.contextWindow, 262144);
	assert.deepEqual(r.added, QTOOLS_MODELS.filter((m) => m.id !== "qwen4-max-preview").map((m) => m.id));
});

// 5. No duplicate ids can reach pi.
check("merged list has no duplicate ids", () => {
	const r = mergeCatalog([...piCatalog, ...QTOOLS_MODELS, piCatalog[0]]);
	const ids = r.models.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length);
});

// 6. Malformed baseline entries must not crash the merge or invent ids.
check("baseline entries without a usable id are ignored, not crashed on", () => {
	const r = mergeCatalog([null, undefined, {}, { id: 42 }, { id: "qwen3.8-max" }]);
	assert.equal(r.unsafe, false);
	assert.equal(r.models.length, 5 + QTOOLS_MODELS.length);
});

// 7. Generation ids must never leak into the chat picker.
check("no generation/audio model is offered as a chat model", () => {
	const forbidden = ["wan2.7-image", "wan2.7-image-pro", "qwen-image-3.0-pro", "wan3.0-video", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-asr-flash", "qwen-audio-3.0-realtime-plus"];
	const ids = QTOOLS_MODELS.map((m) => m.id);
	for (const f of forbidden) assert.equal(ids.includes(f), false, `${f} must not be a chat entry`);
});

// 8. Every curated row carries the fields pi requires, with measured capabilities.
check("every curated row is a complete, measured chat model", () => {
	for (const m of QTOOLS_MODELS) {
		assert.equal(m.type, "chat");
		assert.equal(m.api, "openai-completions");
		assert.equal(m.reasoning, true, `${m.id}: reasoning was probed YES`);
		assert.deepEqual(m.input, ["text", "image"], `${m.id}: image input was probed YES`);
		assert.ok(m.contextWindow > 0 && m.maxTokens > 0);
		assert.equal(m.cost.input, 0, "subscription plan is prepaid");
		assert.equal(m.compat.thinkingFormat, "qwen");
		for (const lvl of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
			assert.equal(m.thinkingLevelMap[lvl], lvl, `${m.id}: ${lvl} returned 200`);
		}
	}
});

check("overlay covers only the measured ap-southeast-1 providers", () => {
	assert.deepEqual([...PLAN_PROVIDERS].sort(), [
		"qwen-token-plan",
		"qwen-token-plan-individual",
	]);
	// cn-beijing is a different regional deployment; its /models route has never
	// been probed (the SG key 401s there), so it must not inherit SG-measured ids.
	assert.equal(PLAN_PROVIDERS.includes("qwen-token-plan-cn"), false);
});

console.log(failures === 0 ? "\n  all catalog tests passed" : `\n  ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
