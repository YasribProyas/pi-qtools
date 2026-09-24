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
| `qwen_image_search` | `/responses` `web_search_image` | text → image URLs. **qwen3.8-max only** |
| `qwen_reverse_image_search` | `/responses` `image_search` | image URL or local file → similar images; accepts a local path and inlines it as a data URL (4 MB cap) |
| `qwen_deep_search` | chat `search_strategy: "agent"` | multi-step research; very expensive (~340k prompt tokens observed) |
| `qwen_generate_image` | native `multimodal-generation` | `wan2.7-image`, `wan2.7-image-pro`, `qwen-image-3.0-pro`; sync; `save: true` writes into `<cwd>/out/qtools/` |
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
- `/qimage <prompt> [-m model] [-s WxH]` — saves into `out/qtools/`
- `/qvideo <prompt> [-i <path|url>] [-m model] [-s WxH]` — `-i` selects image-to-video; saves into `out/qtools/`

### Getting parameter hints

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
  "fallbackModel": "qwen3.7-max",
  "showReasoning": false,
  "deepSearchMaxTokens": 16384,
  "imageModel": "wan2.7-image",
  "videoModel": "happyhorse-1.1-t2v"
}
```

## Verified capability matrix

Measured against the live endpoint rather than taken from docs, because the two
surfaces differ per model:

| model | chat search | agent | chat code_int | `/responses` tools | `web_search_image` | `image_search` |
|---|---|---|---|---|---|---|
| qwen3.8-max | yes | no | no | all | **yes** | yes |
| qwen3.8-flash | yes | no | no | s/c/e | no | yes |
| qwen3.7-max | yes | yes | yes | s/c/e | no | no |
| qwen3.7-plus | yes | yes | yes | s/c/e | no | yes |
| qwen3.6-flash | yes | yes | yes | s/c/e | no | yes |
| deepseek-v4-* | yes | yes | yes | s/c/e | no | no |
| glm-5.2 | **no** | no | no | s/c/e | no | no |

`glm-5.2` rejects `enable_search` with a hard error, so injection is skipped for it;
without that guard every turn would fail after a model switch.

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
