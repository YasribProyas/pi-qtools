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
| `qwen_generate_image` | native `multimodal-generation` | `wan2.7-image`, `wan2.7-image-pro`, `qwen-image-3.0-pro`; sync |
| `qwen_generate_video` | native `video-generation` + task polling | `happyhorse-1.1-*`; async, ~1.5–3 min |

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
- `/qimage <prompt> [-m model] [-s WxH]`
- `/qvideo <prompt> [-m model] [-s WxH]`

## Configuration

Persisted to `<agentDir>/qwen-tools.json`:

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
- `happyhorse-1.1-i2v` / `-r2v` are selectable but the tool sends only a text prompt,
  so they will not behave as expected yet.
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
pi -e ./extensions/qwen-tools.ts "prompt"   # one-off load
```

## License

MIT
