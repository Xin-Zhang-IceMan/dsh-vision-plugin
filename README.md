# dsh-vision-plugin

> Give text-only DSH models (e.g. deepseek-v4) vision — a dynamic Cordis plugin for DeepSeek Harness, with a bilingual settings UI.

**English** | [中文](README.zh.md)

![#dsh-plugin](https://img.shields.io/badge/dsh-plugin-dynamic%20cordis-1f6feb)

**Current version: v1.0.1** — the UI shows only the current version, no version history.

## Features

1. **`vision_analyze` tool** — the model can call it directly to analyze a local image file (PNG / JPEG / WebP / GIF) and get a detailed text description from a vision model.
2. **Auto-translation of pasted images** — images pasted/uploaded into the chat enter the session; when the target model is text-only, an `llm/stream` waterfall listener automatically transcribes them into text via a vision model before dispatch. **Text-only models can "see" images.**
3. **Bilingual settings UI** — a "视觉模型 / Vision Model" page in the DSH settings panel: shows the current version status and lets you configure the default vision model; the UI language follows the DSH interface language automatically (Settings → General → Language).

## How it works

```
Paste image → Host admission check (modelOverrides declares image capability → admitted)
           → session message carries image blocks
           → llm/stream waterfall listener:
               1. no images → pass through (zero overhead)
               2. already handled by this plugin (Symbol marker) → pass through (no recursion)
               3. target model is a native vision model (whitelist) → pass through (native image input)
               4. otherwise (text-only model) → vision model transcribes to text → re-dispatch
           → main model answers from the text description
```

- Reuses the deployment's own LLM route (default `opencode-go`) — **no extra API keys**.
- Vision model selection priority: **UI config > per-call override > auto-select** (`qwen3.7-plus → kimi-k3 → grok-4.5 → minimax-m3 → …`).
- Translation results are cached by `attachmentId + question` (up to 300 entries), so follow-up turns reuse one vision call.
- The listener lives on the root context and serves every session; it is removed automatically when the plugin stops.

## Settings UI

DSH settings panel (bottom-left ⚙️) → **Vision Model** page:

- **Status badge**: `● Running` + `v1.0.1` — only the current version is shown.
- **Default vision model**: dropdown with "Auto-select (recommended)" or any image-capable model (e.g. `kimi-k3`, `grok-4.5`); save takes effect immediately.
- **Info area**: currently effective model, LLM route, native-vision whitelist, and a short description of the translation mechanism.

## Fault tolerance

| Scenario | Behavior |
| --- | --- |
| Vision model produced content but the stream errored at the end | **Keep the generated content**, not treated as failure |
| Vision model totally failed (no output) | **Retry once with a fallback model** |
| Retry still fails | **Degrade to a placeholder block**, the conversation continues |
| Errors | **Real upstream reason surfaced** (code / HTTP status) |

## Installation

### 0. One-click install (send this prompt to DSH)

Copy the block below and send it to DSH (a session running the `cordis` agent preset). The agent will fetch the source, define and run the plugin, configure `settings.yaml`, and verify the install:

```text
Install the dsh-vision-plugin (DeepSeek Harness vision plugin v1.0.1) for me:

1. Obtain the plugin source (fetch via curl, or read from a local checkout):
   - Host half:   https://raw.githubusercontent.com/Xin-Zhang-IceMan/dsh-vision-plugin/main/plugin/vision-plugin.js
   - Client half: https://raw.githubusercontent.com/Xin-Zhang-IceMan/dsh-vision-plugin/main/plugin/vision-plugin.client.js

2. Define the dynamic Cordis plugin with cordis_define:
   - kind: "new", idPrefix: "visn"
   - code.host   = the full content of vision-plugin.js (the function body)
   - code.client = the full content of vision-plugin.client.js (the function body)
   - name: "Vision Assistant"
   - purpose: one sentence describing the plugin

3. Activate it with cordis_run (mode: "run"); approve the Client half when prompted.

4. If ~/.dsh/settings.yaml does not yet declare image capability for the text-only
   default model, add (hot-reloaded, no restart needed):
   llm-pi-ai:
     providers:
       opencode-go:
         apiKeyEnv: OPENCODE_GO_API_KEY
         modelOverrides:
           deepseek-v4-flash:
             input: [text, image]

5. Verify:
   - Tool.listTools shows vision_analyze
   - The settings panel has a "Vision Model" page (bilingual, follows the UI language)
   - Pasting an image into the chat is transcribed automatically
```

### 1. Load the plugin (DSH dynamic-plugin mechanism)

Pass the content of [`plugin/vision-plugin.js`](plugin/vision-plugin.js) as `code.host` and [`plugin/vision-plugin.client.js`](plugin/vision-plugin.client.js) as `code.client` in one `cordis_define` call (pick any `idPrefix`, e.g. `visn`), then activate with `cordis_run`:

```
cordis_define  → returns pluginId / packageId
cordis_run     → activates (the Client half needs one approval in the UI)
```

### 2. Configure the deployment (let text-only models accept pasted images)

Before a message enters the session, the host checks the current model's `inputModalities`. To let a text-only model pass the check (images are then transcribed by this plugin), declare image capability for it in `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      # Advertise the text-only model as image-capable: the chat admits pasted
      # images, and this plugin's llm/stream listener transcribes them to text.
      modelOverrides:
        deepseek-v4-flash:
          input: [text, image]
```

> settings.yaml is hot-reloaded by chokidar — no restart needed.
> Add the same entry for other text-only models (e.g. `deepseek-v4-pro`) to extend the capability.

## Usage

### Paste images

Paste (or drag-and-drop / upload) an image into the chat with a sentence like "What's in this image?" — text-only models will answer it.

### vision_analyze tool

| Parameter | Required | Description |
| --- | --- | --- |
| `path` | ✅ | Image file path (PNG/JPEG/WebP/GIF) |
| `question` | ❌ | Specific question about the image; defaults to a full description |
| `model` | ❌ | Vision model id override (e.g. `kimi-k3`); defaults to UI config → auto-select |
| `provider` | ❌ | LLM provider route; defaults to `opencode-go` |

## Constants (edit `plugin/vision-plugin.js`)

| Constant | Description |
| --- | --- |
| `VERSION` | Plugin version shown in the settings UI |
| `DEFAULT_PROVIDER` | LLM route (default `opencode-go`) |
| `DEFAULT_MODEL` | Fallback vision model (default `qwen3.7-plus`) |
| `NATIVE_VISION_MODELS` | Native-vision whitelist (images sent natively, not transcribed) |
| `MODEL_PRIORITY` | Auto-selection priority for vision models |

## Notes

- The plugin is a **process-local dynamic plugin**: after a DSH restart, re-run `cordis_run` with the same `pluginId` / `packageId`; to persist it, migrate the code into a host-composition plugin row.
- The UI-configured default vision model lives in **process memory** (valid for the plugin's lifetime); a restart returns to auto-select.
- Text-only models advertised via `modelOverrides` show an "image-capable" mark in the model picker — intentional (they do handle images through transcription).
- Translation depends on the deployment route exposing vision models; update `DEFAULT_PROVIDER` / `NATIVE_VISION_MODELS` / `MODEL_PRIORITY` if the route changes.

## License

MIT
