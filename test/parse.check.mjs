#!/usr/bin/env node
// Parse guard for the extension itself, with NO dependencies installed.
//
//   node --experimental-strip-types test/parse.check.mjs
//
// Why this exists: the capability table was extracted into src/capabilities.ts and the
// surgery left TWO copies of `export function learnedSearchSkips`. pi reported it as
// "Failed to load extension ... Identifier 'learnedSearchSkips' has already been declared"
// — after commit. CI cannot import the extension (it has no pi installed), so without this
// check a file that cannot even parse would ship as a release.
//
// Trick: importing the extension always fails in a bare checkout with ERR_MODULE_NOT_FOUND
// on "@earendil-works/pi-coding-agent". That failure happens at module RESOLUTION, which is
// strictly after the TypeScript is transformed and parsed. So reaching that error proves the
// file parses; any SyntaxError/ParseError instead is a real defect in the source.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const files = ["../extensions/qtools.ts", "../src/capabilities.ts"];

let failures = 0;
for (const rel of files) {
	const path = join(here, rel);
	try {
		await import(path);
		console.log(`  ok   ${rel} loads outright`);
	} catch (e) {
		const code = e?.code ?? "";
		const msg = String(e?.message ?? e);
		const resolved = code === "ERR_MODULE_NOT_FOUND" || /Cannot find package|Cannot find module/.test(msg);
		if (resolved) {
			// Only reachable for the extension; src/capabilities.ts imports nothing.
			console.log(`  ok   ${rel} parses (stopped at a missing pi peer package)`);
		} else {
			failures++;
			console.log(`  FAIL ${rel} does not parse\n       ${msg.split("\n")[0]}`);
		}
	}
}

console.log(failures === 0 ? "\nsource parses" : `\n${failures} file(s) failed to parse`);
process.exit(failures === 0 ? 0 : 1);
