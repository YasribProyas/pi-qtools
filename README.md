# pi-qtools

Bridge between [pi](https://pi.dev) and the **Qwen Token Plan** subscription.

The plan ships server-side tools and media models that pi cannot reach on its own:
pi talks `/chat/completions` to a chat model, while these live on `/responses`, on
native `/api/v1/services/...` endpoints, or behind async task polling. This package
exposes them as pi tools *and* slash commands.

Requires a `qwen-token-plan*` provider authenticated in pi (`/login`).

## Tools (agent-callable)

| Tool | Backing capability | Notes |
|---|---|---|
| `qwen_web_search` | `/responses` `web_search` | answer + queries issued + source URLs |
| `qwen_web_extractor` | `/responses` `web_search` + `web_extractor` | page text filtered to a stated goal; the API requires the search tool alongside |
| `qwen_code_interpreter` | `/responses` `code_interpreter` | returns the Python it ran, container id, real stdout |
| `qwen_image_search` | `/responses` `web_search_image` | text → image URLs. Runs on flash tiers too (see the matrix) |
| `qwen_reverse_image_search` | `/responses` `image_search` | image URL or local file → similar images; accepts a local path and inlines it as a data URL (4 MB cap) |
| `qwen_deep_search` | chat `search_strategy: "agent"` | multi-step research; very expensive (~340k prompt tokens observed) |
| `qwen_generate_image` | native `multimodal-generation` | `wan2.7-image`, `wan2.7-image-pro`, `qwen-image-3.0-pro`; sync; `image` edits a reference picture; `save: true` writes into `<cwd>/out/qtools/` |
| `qwen_generate_video` | native `video-generation` + task polling | `happyhorse-1.1-t2v` / `-i2v` / `-r2v`; async, ~90-120s; `save: true` writes the mp4 |

## Passive main-loop search

When the active model is a Qwen plan chat model, `enable_search` is injected into
pi's own requests, so the model can search without calling a tool. Modes:

| mode | cost/turn | behaviour |
|---|---|---|
| `off` | 0 | memory only |
| `turbo` (default) | ~330 tok | searches, fresh answers |
| `max` | ~420 tok | wider search + inline `[n]` citations |

`search_strategy: "agent"` and `enable_code_interpreter` are **never** injected:
both flip Alibaba "Agent mode", which rejects any `tools` array, and pi always
sends one. That is why those two capabilities are standalone tools instead.

## Commands

- `/qtools-config` — settings TUI (search mode, model defaults, capability matrix)
- `/qimage <prompt> [-i img] [-m model] [-s WxH]` — saves into `out/qtools/`
- `/qvideo <prompt> [-i <path|url>] [-m model] [-s WxH]` — `-i` selects image-to-video; saves into `out/qtools/`

### Image editing (measured)

Passing a reference image turns the same endpoint from text-to-image into
image+prompt editing. The shape is one extra content part:

```json
{ "input": { "messages": [ { "role": "user", "content": [
  { "image": "https://... or data:image/png;base64,..." },
  { "text": "turn this into a red panda, keep the flat vector style" }
] } ] } }
```

Verified: a flat-vector pig + that prompt came back a red panda **in the same
style**, and a local file inlined as a data URL worked too. Two reference images
in one message are accepted.

The trap here is that a wrong request shape still returns a valid image, just
generated from the text alone. Every claim above was checked by asking a vision
model (`qwen3.8-max`, which has real image input on this plan) to describe the
output, not by trusting the HTTP 200.

## Getting parameter hints

pi exposes no `argumentHint` for extension commands, so `/qimage` and `/qvideo` make
themselves discoverable three ways:

1. their **signature is in the command description**, visible in the `/` picker
2. **`--help`** (or running with no prompt) prints every flag, the allowed values, the
   active default and the exact output path
3. **argument completion**: after `/qimage ` or on a partial flag, suggestions list
   `-m`/`-s`/`-i`/`--help`, and after `-m `/`-s ` they list the valid models/sizes

Completions are suppressed while a prompt is being typed, because pi replaces the
whole argument region with the chosen value — offering a flag mid-prompt would
delete what was already written.

## Video generation schema (measured)

All three models post to `/api/v1/services/aigc/video-generation/video-synthesis`
with `X-DashScope-Async: enable`, then poll `GET /api/v1/tasks/{id}`.

```json
{
  "model": "happyhorse-1.1-i2v",
  "input": {
    "prompt": "the pig blinks slowly",
    "media": [{ "type": "first_frame", "url": "https://... or data:image/png;base64,..." }]
  },
  "parameters": { "size": "1280*720" }
}
```

| fact | value |
|---|---|
| required field | `input.media` (an array; `img_url` / `image_url` / `ref_url` are all ignored) |
| `media[].type` for i2v | exactly `"first_frame"` |
| `media[].type` for r2v | exactly `"reference_image"` |
| t2v | takes no `media` at all |
| status of each mode | t2v, i2v and r2v all reached `SUCCEEDED` end to end |
| minimum source image | **300x300** |
| local files | supported by inlining a `data:` URL; verified with a 5.0 MB PNG (6.7 MB base64) |
| output resolution | follows the **source aspect ratio**; `size` is advisory for i2v/r2v (a square frame returned 1440x1440) |

**Critical gotcha:** the submit call returns **HTTP 200 with a `task_id` even when the
request is wrong**. Every shape above was discovered by polling a *failed* task and
reading `output.message`, not by reading the submit response. Never treat a successful
submit as a successful generation — this tool surfaces `status` and `detail` for that reason.

Image generation sizes must be **589824-16777216 total pixels** (768² to 4096²); `512*512`
is rejected.

## Configuration

Persisted to `<agentDir>/qtools.json` (migrated automatically from the older
`qwen-tools.json` on first load):

```json
{
  "searchMode": "turbo",
  "fallbackModel": "qwen3.6-flash",
  "showReasoning": false,
  "deepSearchMaxTokens": 16384,
  "imageModel": "wan2.7-image",
  "videoModel": "happyhorse-1.1-t2v",
  "searchBlocklist": []
}
```

## Model catalog overlay

pi ships its model list from a remote catalog that lags the plan. Measured against
the live `/models` route: the plan serves **21** ids, pi's catalog knew **10**. Four
of the missing ones are usable chat models that simply could not be selected.

This package overlays its own measured list on top of pi's, adding only what pi
lacks. It runs on every model refresh, so a pi update that drops or renames a model
gets corrected on the next refresh without a manual edit.

| added id | verified |
|---|---|
| `qwen4-max-preview` | chat, reasoning, image input, all 6 thinking levels |
| `deepseek-v4.1-flash` | chat, reasoning, image input, all 6 thinking levels |
| `deepseek-v4.1-flash-1017` | chat, reasoning, image input |
| `auto` | plan router; chat, reasoning, image input |

Every row was probed, not copied from a sibling model — the same rule the
capability table follows after `glm-5.3` shipped unmeasured and 400'd every turn.
That includes `enable_search`: all four accept it, and prompt-token inflation
(235-387 vs a ~10-28 baseline) confirms search actually ran rather than the flag
merely being tolerated. They inherit `search=true` from the Qwen family rule, so
this had to be measured rather than assumed.
`contextWindow`/`maxTokens` are plan-wide family values, not per-model measurements:
the endpoint accepts `max_tokens=999999` without complaint, so it cannot reveal the
real ceiling.

**Scope: `qwen-token-plan` and `qwen-token-plan-individual` only.** Both share the
ap-southeast-1 endpoint these rows were measured on. `qwen-token-plan-cn` serves
cn-beijing, a different regional deployment whose model list has never been probed
(the SG key returns 401 there), so it is deliberately excluded rather than handed
SG-measured ids. Add it only after probing its `/models` route with a CN credential.

**Generation and audio ids are deliberately excluded.** `wan2.7-image`,
`qwen-image-3.0-pro`, `wan3.0-video` and `qwen-audio-3.0-*` are not chat models;
adding them to pi's picker would create entries that 400 on every turn. This package
already drives them through their native endpoints.

### Two rules that keep it non-destructive

pi's `refreshModels` return value **replaces the provider's entire model list**, so:

1. pi's baseline is carried through verbatim, and **pi's own metadata wins** for any
   id it already knows — its catalog is vendor-refreshed and may carry corrections.
2. With no baseline to merge into, the overlay returns *nothing* and adds nothing.

Rule 2 was learned the hard way. The first implementation returned `[]` on that
path, which **wiped all 11 built-in plan models**. Measured with pi 1.5.0:
`pi -ne --list-models` showed 11, the extension showed 0. Returning nothing keeps
pi's list intact; the additions land on the next refresh once pi has a stored
catalog. Nothing is persisted to `models-store.json` — that file belongs to pi's
catalog refresh, and writing an overlay into it would corrupt its etag bookkeeping.

`/qtools-config` reports what was added under **Added plan models**.

## Verified capability matrix

Measured against the live endpoint rather than taken from docs, because the two
surfaces differ per model:

| model | chat search | agent | chat code_int | `/responses` tools | `web_search_image` | `image_search` |
|---|---|---|---|---|---|---|
| qwen3.8-max | yes | no | no | all | yes | yes |
| qwen3.8-flash | yes | no | no | all | **yes** | yes |
| qwen3.7-max | yes | yes | yes | s/c/e | **no** | **no** |
| qwen3.7-plus | yes | yes | yes | all | **yes** | yes |
| qwen3.6-flash | yes | yes | yes | all | **yes** | **yes** |
| deepseek-v4-* | yes | yes | yes | s/c/e | no | no |
| deepseek-v4.1-flash | yes | (inherited) | yes (streaming) | s/c/e | no | no |
| glm-5.2 | **no** | no | no | s/c/e | no | no |
| glm-5.3 | **no** | no | no | s/c/e | no | no |
| auto (plan router) | yes | unknown | unknown | s/c/e | no | no |
| anything unmeasured | **no** | no | no | s/c/e | no | no |

Two corrections from the 2026-10-10 remeasurement, both of which were load-bearing bugs:

- **`web_search_image` is not qwen3.8-max-only.** The table used to claim that, and it
  is wrong: qwen3.6-flash, qwen3.7-plus and qwen3.8-flash all fire `web_search_image_call`.
- **qwen3.7-max cannot run either image tool** — it 400s on both. Since it was the
  hardcoded last resort in the pickers, a GLM model asking for image search used to be
  routed to a model that then failed the call, on the most expensive tier on the plan.

`agent` = chat `search_strategy: "agent"` (qwen_deep_search). `s/c/e` = `/responses`
web_search / code_interpreter / web_extractor. Cells marked (inherited) come from the
family rule, not from a direct measurement of that id.

Capability state lives in `src/capabilities.ts` (the measured table, the family rules, the
fail-safe default, the fallback chain) and imports nothing, so it is testable with no pi and
no network. `extensions/qtools.ts` owns everything else: config file, HTTP, tools, TUI.

`glm-5.2` and `glm-5.3` reject `enable_search` with a hard error, so injection is
skipped for them; without that guard every turn would fail after a model switch. They
can still *use* the search tools: `/responses` web_search, code_interpreter and
web_extractor all run on a GLM model — only the passive chat injection is lost.

### Which model runs a tool

`requested -> active -> config.fallbackModel -> FALLBACK_CHAIN`, first capable id wins:

- The **active** model is used whenever its row allows the tool, so selecting a model
  is not a silent invitation to bill a different one — and the answering model is also
  the model that writes the search queries and reads the pages.
- Only when the active row says no does the chain step off it, and it steps onto the
  **cheapest capable** id, not a fixed one. The chain is `qwen3.6-flash -> qwen3.8-flash
  -> qwen3.7-plus -> deepseek-v4-flash -> deepseek-v4.1-flash -> qwen3.7-max ->
  qwen3.8-max`, led by `config.fallbackModel` (default `qwen3.6-flash`, the cheapest id
  measured running every surface). Max tiers sit at the end because the plan bills them
  at several times a flash tier.
- If nothing can serve the capability, the tool **errors with the list of models that
  were tried** instead of quietly calling a model that will 400.

Passive injection has no such choice: it rides inside the active model's own
`/chat/completions` body, which is why the capability table exists at all.

### How an unknown model id is handled

Three layers, in this order. `node --experimental-strip-types test/caps.test.mjs`
pins all of them.

1. **Exact row** in `CAPS` (`extensions/qtools.ts`) — measured, authoritative.
2. **Family rule** (`FAMILY_CAPS`) — a regex on the id, so a dated release like
   `glm-5.4` or `qwen3.9-max-1105` inherits its family's shape instead of falling
   through. The generation-only rule (`qwen-audio-*`, `qwen-image-*`, `wan*`,
   `happyhorse*`) must stay first, or a future `qwen-audio` id would be read as a
   chat model. `/qtools-config` -> per-model capabilities lists the rules, and the
   active model's line says which layer answered for it.
3. **Fail-safe default** — `UNKNOWN_CAPS.chat.search = false`. This is deliberate
   and is the whole point of the layering: a wrong `true` broke *every* turn when
   glm-5.3 shipped and matched nothing, while a wrong `false` only costs the passive
   search bonus and `qwen_web_search` still works.

If a *family guess* turns out wrong, the extension heals itself: the finalized
assistant message carries the request model id and the upstream error text, so when
that text mentions `enable_search` the id is appended to `config.searchBlocklist`
and later turns skip the injection. One bad turn, not forever. Clear them in
`/qtools-config` -> learned skips. Measured ids never learn — the table outranks the
runtime, and a verified model that suddenly rejects search should surface as an
error rather than be silently reconfigured around.

### Adding a model the plan just shipped

1. Check whether pi even lists it. The plan's own `/models` is not the same set as
   the pi.dev catalogue; on 2026-10-09 the endpoint served `glm-5.3`,
   `deepseek-v4.1-flash` and `auto` while pi's catalogue listed none of them. Add the
   missing id to `~/.pi/agent/models.json` under the provider, mirroring a sibling
   row's `compat`/`thinkingLevelMap`, and verify `reasoning_effort` levels by hand —
   glm-5.3 accepts only `low|high|max` and 400s on `medium`/`xhigh`, and it silently
   drops image parts, so declare `input: ["text"]`.
2. Measure the chat surface: `enable_search`, and `enable_code_interpreter` **in
   streaming mode** (non-streaming rejects it with a misleading 400).
3. Measure the `/responses` surface with the real `tools[].type` strings, not the
   console labels (see Known gaps).
4. Add the row to `CAPS` in `src/capabilities.ts`, run `npm test`, then release. If the id
   matches a `FAMILY_CAPS` rule, measure it anyway: family rules are inferences, and only a
   `CAPS` row is reported as `measured`.

## Testing

```sh
npm test                                  # parse guard + capability gating, no dependencies
bash test/injection.e2e.sh                # live injection behaviour against a mock (needs pi)
```

`npm test` is two dependency-free scripts, and that is deliberate: CI runs it with **no
install step**, so a missing or mismatched pi package cannot break a release.

- `test/parse.check.mjs` imports `extensions/qtools.ts` and counts `ERR_MODULE_NOT_FOUND` as
  success, because module resolution happens only *after* the TypeScript is parsed. It exists
  because a table extraction once left two copies of `export function learnedSearchSkips` in
  the file, and pi only reported that at load time as
  `Failed to load extension ... has already been declared`. A file that cannot parse must
  never reach `npm publish`.
- `test/caps.test.mjs` asserts the gating rules by importing `src/capabilities.ts` directly.

The workflow also fails the build if `node_modules` is ever tracked again: a node_modules
**symlink** is not caught by the usual `node_modules/` gitignore pattern (git stores symlinks
as files, mode `120000`), and one once shipped an absolute path from a maintainer's laptop
into the public repo. The ignore rule is `node_modules`, no trailing slash.

`test/injection.e2e.sh` boots `test/mock_endpoint.py` on 127.0.0.1, runs real `pi -p`
sessions in a throwaway `PI_CODING_AGENT_DIR`, and asserts whether `enable_search`
reached the wire for a family-yes id, a glm id, an unmeasured id, and a deliberately
wrong family guess (which must be learned after one rejected turn). Nothing leaves
the machine and your own `~/.pi/agent` is never touched.

## Known gaps

- **TTS / ASR are not implemented.** `qwen-audio-3.0-tts-plus` resolves as a model on
  `/api/v1/services/audio/tts/SpeechSynthesizer` but the engine returns
  `InvalidParameter [cosyvoice:] Engine error [411]: TTS speak operation failed` for
  every request shape tried (plain, `format`/`sample_rate`, `parameters`, and with
  `X-DashScope-SSE: enable`). `/api/v1/services/audio/asr/transcription` reports it
  needs async on one call and `url error` when given the async header. The correct
  request contract is still unknown — likely WebSocket-only.
- `happyhorse-1.1-r2v` reaches `SUCCEEDED` with `media[].type: "reference_image"`, so the
  request shape is confirmed. Whether the output faithfully follows the reference was not
  checked (that needs vision comparison, which this package does not add).
- Realtime voice (`qwen-audio-3.0-realtime-plus`) is intentionally out of scope.
- pi's model catalogue labels `qwen3.7-plus` as `input: ['text','image']`, but the
  gateway rejects image input on it ("only supports text modality"). Upstream bug.
- Console capability labels differ from API `tools[].type` strings. The Qwen UI says
  `t2i_search`/`i2i_search`; the API wants `web_search_image`/`image_search`. Sending
  a label is **silently ignored** — the endpoint accepts any type string, including
  nonsense, so "no error" does not mean "supported". `/qtools-config` lists the mapping.

## Development

```bash
pi install ./path/to/qtools     # loads from this path, no copy
pi -e ./extensions/qtools.ts "prompt"   # one-off load
```

## License

MIT
