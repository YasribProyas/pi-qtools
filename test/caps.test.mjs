#!/usr/bin/env node
// Capability-gate tests: no network, no credentials, no config written.
//   node --experimental-strip-types test/caps.test.mjs
//
// The point of these tests is one rule: an id nobody measured must never be assumed
// able to take enable_search. glm-5.3 shipped on the plan, matched no row, inherited
// "search capable" from the old UNKNOWN_CAPS default, and every pi turn 400'd.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Import the pure capability module, NOT the extension: the extension imports pi, which
// would make this test need a full pi install. That is the whole reason the table moved.
const { createCaps, CAPS, FALLBACK_CHAIN, modelsSupporting } = await import(
	join(here, "..", "src", "capabilities.ts")
);

// A reader with a fixed learned-skip list, mirroring how the extension wires the config.
let learned = [];
const { capsFor, capsSource, searchCapable, chooseModel, candidateOrder, fallbackChain } = createCaps({
	blocklist: () => learned,
	fallbackModel: () => "qwen3.6-flash",
});

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

// 1. The poison pill, permanently dead: an unmeasured id gets NO passive search.
check("unmeasured id is not search-capable (the glm-5.3 class of bug)", () => {
	assert.equal(searchCapable("kimi-k3"), false);
	assert.equal(capsSource("kimi-k3"), "unknown model, no capabilities assumed");
});
check("unmeasured id still gets the /responses tools", () => {
	assert.equal(capsFor("kimi-k3").responses.web_search, true);
	assert.equal(capsFor("kimi-k3").responses.web_search_image, false);
});

// 2. Measured rows, including the ones that reject chat search.
check("glm-5.3 measured: no chat search, /responses web_search works", () => {
	assert.equal(capsSource("glm-5.3"), "measured");
	assert.equal(capsFor("glm-5.3").chat.search, false);
	assert.equal(capsFor("glm-5.3").responses.web_search, true);
});
check("glm-5.2 measured: same shape", () => {
	assert.equal(capsFor("glm-5.2").chat.search, false);
});
check("deepseek-v4.1-flash measured: chat search works", () => {
	assert.equal(capsSource("deepseek-v4.1-flash"), "measured");
	assert.equal(capsFor("deepseek-v4.1-flash").chat.search, true);
});
check("auto (plan router alias) measured", () => {
	assert.equal(capsSource("auto"), "measured");
	assert.equal(capsFor("auto").chat.search, true);
});
check("qwen3.8-flash measured and search-capable", () => {
	assert.equal(searchCapable("qwen3.8-flash"), true);
});

// 3. Family inference keeps a dated release from falling through to "unknown".
check("glm family: next GLM is search-incapable by inference", () => {
	assert.equal(searchCapable("glm-5.4"), false);
	assert.match(capsSource("glm-5.4"), /^GLM/);
});
check("deepseek family: next DeepSeek keeps chat search", () => {
	assert.equal(searchCapable("deepseek-v4.2-flash-1101"), true);
});
check("qwen chat family: next Qwen keeps chat search", () => {
	assert.equal(searchCapable("qwen3.9-max-1105"), true);
});

// 4. The generation-only rule must win over the qwen chat rule, or a future
//    qwen-audio id would be treated as a chat model that takes injection.
check("qwen-audio / qwen-image / wan / happyhorse are not chat-capable", () => {
	for (const id of ["qwen-audio-4.0-tts-plus", "qwen-image-4.0-pro", "wan3.0-image", "happyhorse-2.0-t2v"]) {
		assert.equal(capsFor(id).chat.search, false, `${id} chat.search`);
		assert.equal(capsFor(id).responses.web_search, false, `${id} responses.web_search`);
	}
});

// 5. Exact rows always beat family rules.
check("exact row beats family rule (qwen-audio-3.0-tts-plus stays NO_RES)", () => {
	assert.equal(capsSource("qwen-audio-3.0-tts-plus"), "measured");
	assert.equal(capsFor("qwen-audio-3.0-tts-plus").responses.code_interpreter, false);
});

// 6. The image tools must not cost a max-tier model. This was the second bug: the table
//    claimed web_search_image was qwen3.8-max only, so pickResponsesModel's hardcoded
//    "qwen3.7-max" last resort was itself incapable (measured 400 on both image tools),
//    and every fallback landed on an expensive model that then failed.
check("flash tiers really do run web_search_image (corrected table)", () => {
	for (const id of ["qwen3.6-flash", "qwen3.8-flash", "qwen3.7-plus", "qwen3.8-max"]) {
		assert.equal(capsFor(id).responses.web_search_image, true, `${id} web_search_image`);
	}
});
check("qwen3.7-max cannot run the image tools", () => {
	assert.equal(capsFor("qwen3.7-max").responses.web_search_image, false);
	assert.equal(capsFor("qwen3.7-max").responses.image_search, false);
});
check("image search from a GLM model picks the cheapest capable id, not a max", () => {
	const res = (id) => capsFor(id).responses.web_search_image;
	assert.equal(chooseModel(res, "glm-5.3"), "qwen3.6-flash");
	assert.equal(capsFor(chooseModel(res, "glm-5.3")).responses.web_search_image, true);
});
check("the old hardcoded last resort is never chosen for image tools", () => {
	for (const tool of ["web_search_image", "image_search"]) {
		const picked = chooseModel((id) => capsFor(id).responses[tool], "glm-5.3");
		assert.notEqual(picked, "qwen3.7-max", `${tool} must not fall back to qwen3.7-max`);
		assert.notEqual(picked, undefined, `${tool} must resolve`);
	}
});

// 7. Policy: the active model is kept whenever it can serve the tool.
check("active model is preferred over the cheaper fallback", () => {
	assert.equal(chooseModel((id) => capsFor(id).responses.web_search, "qwen3.7-max"), "qwen3.7-max");
});
check("explicit request beats active model", () => {
	assert.equal(chooseModel((id) => capsFor(id).responses.web_search, "glm-5.3", "qwen3.8-flash"), "qwen3.8-flash");
});
check("chain order is cheap-first and starts with config.fallbackModel", () => {
	assert.equal(fallbackChain()[0], "qwen3.6-flash");
	assert.deepEqual(candidateOrder("glm-5.3").slice(0, 3), ["glm-5.3", "qwen3.6-flash", "qwen3.8-flash"]);
});
check("chat agent mode (deep search) resolves off a GLM model", () => {
	assert.equal(chooseModel((id) => capsFor(id).chat.agent, "glm-5.3"), "qwen3.6-flash");
});
check("an impossible capability resolves to undefined, not to a model that will 400", () => {
	assert.equal(chooseModel(() => false, "glm-5.3"), undefined);
});

// 8. A learned skip only ever removes a capability, and clearing it restores. Use a
//    family-capable id: an unmeasured id is already false thanks to the fail-safe default,
//    so it would prove nothing here.
{
	const id = "qwen3.9-flash"; // family rule -> chat search yes
	learned = [];
	const r = createCaps({ blocklist: () => learned, fallbackModel: () => "qwen3.6-flash" });
	try {
		assert.equal(r.searchCapable(id), true, "family rule grants search before the skip");
		learned = [id];
		assert.equal(r.searchCapable(id), false, "learned skip blocks search");
		assert.equal(r.capsSource(id), "learned: rejects enable_search");
		assert.equal(r.capsFor(id).responses.web_search, true, "skip must not touch /responses");
		learned = [];
		assert.equal(r.searchCapable(id), true, "clearing the skip restores it");
		console.log("  ok   learned skip only subtracts, and clearing restores");
	} catch (e) {
		failures++;
		console.log(`  FAIL learned skip behaviour\n       ${e.message.split("\n")[0]}`);
	}
}

// 9. Table sanity: every chain entry must be a real measured row, or the chain is a guess.
{
	const unmeasured = FALLBACK_CHAIN.filter((id) => !CAPS[id]);
	if (unmeasured.length === 0) {
		console.log("  ok   every fallback-chain id has a measured row");
	} else {
		failures++;
		console.log(`  FAIL chain ids with no CAPS row: ${unmeasured.join(", ")}`);
	}
}

console.log(failures === 0 ? "\nall capability tests passed" : `\n${failures} capability test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
