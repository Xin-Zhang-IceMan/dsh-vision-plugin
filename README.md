# dsh-vision-plugin

> Give DeepSeek Harness text-only models a pair of eyes.

**English** | [中文](README.zh.md)

![#dsh-plugin](https://img.shields.io/badge/dsh-plugin-bundle%20composition-1f6feb)

**v1.1.1** · MIT License

---

The deepseek-v4 family is text-only: you can paste screenshots and photos into the chat, but the model can't see them. This plugin sits in between — images are first sent to a vision model (qwen3.7-plus, kimi-k3, …) which transcribes them into text, and that text is what the main model reads. **Paste an image, switch to any text-only model, and it just works.**

## What it looks like

```
You: What's this?                    (pasted a Clash Verge logo)

Assistant: That's the Clash Verge logo. A black cat silhouette on the left,
           the text "Clash Verge" on the right. It's a GUI client for the
           Clash proxy core…
```

The image is transcribed by a vision model; the main model answers from the description, as naturally as if it could see.

## Three things it does

1. **Paste an image and ask** — paste or drop an image into the chat and any text-only model can answer about it. No special command needed.
2. **`vision_analyze` tool** — the model can call it directly to analyze a local image file, with an optional question ("What's the value in row 3 of this table?") and an optional vision model override.
3. **Settings page for the vision model** — a "Vision Model" page in the DSH settings panel: pick the default vision model, see the active route. Bilingual, follows the UI language.

## Quick start

### Option A: permanent install — loads at every dsh start (recommended)

The repo root is a dsh *bundle package* (`dsh-vision-plugin`): the host half
[`lib/index.js`](lib/index.js), the browser half [`lib/client.js`](lib/client.js),
and the plugin row [`cordis.patch.yml`](cordis.patch.yml). Register the bundle in
your profile and dsh mounts the plugin at boot — no `cordis_define`/`cordis_run`,
survives restarts.

**① Install with `dsh plugin`.** The package is published on npm, so one
command is enough — `dsh plugin` installs it with pnpm, then automatically
appends it to `dsh.profile.bundles` (the package declares `dsh.bundle`):

```bash
dsh plugin --profile web add dsh-vision-plugin
```

Developing on the plugin itself? Install your local checkout instead — edits
apply on the next dsh restart, no registry round-trip:

```bash
dsh plugin --profile web add /path/to/deepseek-harness-plug
# or run from inside the checkout directory:
dsh plugin --profile web add .
```

Then confirm the row composes:

```bash
dsh --profile web --dump-config        # the composed tree shows the "vision" row
```

**② Declare image capability.** Before a message enters the session, the host checks the current model's input modalities. Declare image capability for your text-only models in `~/.dsh/settings.yaml` so they accept images (the plugin transcribes them afterwards):

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      modelOverrides:
        deepseek-v4-flash:
          input: [text, image]
        deepseek-v4-pro:
          input: [text, image]
        # add every other text-only model you may switch to;
        # native vision models need no override
```

The file is hot-reloaded — no restart. **Declare every text-only model you might switch to**: otherwise pasting an image after switching to an undeclared model is rejected before the plugin can transcribe it.

**③ Restart dsh.** On boot the loader mounts the `vision` row: `vision_analyze` is registered, the `llm/stream` image-translation waterfall is live, `/vision/api/state` answers the settings page, and the browser half is served at `/plugins/dsh-vision-plugin/client.js`. Verify: Settings → "Vision Model" page, `vision_analyze` in the tool list, then paste an image and ask.

### Option B: dynamic plugin (no repo checkout) — process-local

Prefer this when you don't want a local bundle checkout: send the block below to a DSH session and let the agent install it. Dynamic plugins are process-local — after a dsh restart, re-activate with `cordis_run` (same pluginId/packageId).

```text
Install the dsh-vision-plugin (DeepSeek Harness vision plugin v1.1.1) for me:

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

4. If ~/.dsh/settings.yaml does not yet declare image capability for text-only
   models, add (hot-reloaded, no restart needed):
   llm-pi-ai:
     providers:
       opencode-go:
         apiKeyEnv: OPENCODE_GO_API_KEY
         modelOverrides:
           deepseek-v4-flash:
             input: [text, image]

5. Verify:
   - Tool.listTools shows vision_analyze
   - The settings panel has a "Vision Model" page
   - Pasting an image into the chat is transcribed automatically
```

## Settings page

Open DSH settings (bottom-left ⚙️) → "Vision Model" page:

- Status badge with run state and version
- Dropdown to pick the default vision model (auto-select or a specific model) — saved changes take effect immediately
- Notes showing the active model and route

The UI language follows DSH (Settings → General → Language), switching between Chinese and English automatically.

## FAQ

**Pasting an image fails after switching to another text-only model?**
That model isn't declared in settings.yaml. Add it as in step ② above — hot-reloaded, effective immediately.

**What if opencode-go isn't configured?**
No problem. Since v1.1.0 the plugin scans all configured providers and picks the first route with a vision model. Only when no provider has one does it degrade (the conversation continues, with a note that the image is unavailable).

**Does it survive a DSH restart?**
With the permanent install (Option A) it loads at every boot — that's the whole point. Dynamic plugins (Option B) are process-local: after a restart, re-run `cordis_run` with the same pluginId/packageId.

**Does it cost extra?**
Each transcription is one vision-model call; the same image with the same question is cached, so follow-up turns reuse it. Vision model priority: settings config > call parameter > auto-select.

**What happens when the vision model errors?**
The conversation never breaks: partial output is kept; a total failure retries once with a fallback model; if that fails too, the model is told the image is unavailable and the chat continues.

## Bundle layout

- [`lib/index.js`](lib/index.js) — host half (composition plugin row `vision`): `vision_analyze` tool, the `llm/stream` translation waterfall, and the `/vision/api/state` + `/vision/api/model` JSON API. Zero non-builtin imports on purpose (pnpm does not install the dependencies of `link:` profile plugins).
- [`lib/client.js`](lib/client.js) — browser half (`dsh.client` roster entry): the "Vision Model" settings section, served by the web shell at `/plugins/dsh-vision-plugin/client.js`.
- [`cordis.patch.yml`](cordis.patch.yml) — the loader patch row mounting the bundle (`dsh.bundle.patch`).
- [`plugin/vision-plugin.js`](plugin/vision-plugin.js) / [`plugin/vision-plugin.client.js`](plugin/vision-plugin.client.js) — the dynamic-plugin sources used by Option B (same engine, `harness` API).

## Under the hood (optional)

Flow: an image enters the session → the `llm/stream` listener checks the target model — native vision models (whitelist) see the image directly; text-only models get a vision-model transcription dispatched in its place. Translation requests carry a Symbol marker to prevent recursion, and results are cached by image + question.

Tunable constants live at the top of [`lib/index.js`](lib/index.js): `DEFAULT_MODEL` (fallback model), `NATIVE_VISION_MODELS` (native-vision whitelist), `MODEL_PRIORITY` (auto-select order).

## License

MIT
