# dsh-vision-plugin

> Give DeepSeek Harness text-only models a pair of eyes.

**English** | [中文](README.zh.md)

![#dsh-plugin](https://img.shields.io/badge/dsh-plugin-bundle%20composition-1f6feb)

**v1.3.0** · MIT License

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

### Permanent install — loads at every dsh start

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

## Settings page

Open DSH settings (bottom-left ⚙️) → "Vision Model" page:

- Status badge with run state and version
- Dropdown to pick the default vision model (auto-select or a specific model) — saved changes take effect immediately and are **remembered** (stored in the browser), restored automatically on the next dsh start
- Notes showing the active model and route

The UI language follows DSH (Settings → General → Language), switching between Chinese and English automatically.

## FAQ

**Pasting an image fails after switching to another text-only model?**
That model isn't declared in settings.yaml. Add it as in step ② above — hot-reloaded, effective immediately.

**What if opencode-go isn't configured?**
No problem. Since v1.1.0 the plugin scans all configured providers and picks the first route with a vision model. Only when no provider has one does it degrade (the conversation continues, with a note that the image is unavailable).

**My provider rejects pasted images with `unknown variant \`image_url\`, expected \`text\``?**
That error means an image block was sent to a model that only accepts text. Auto-selection never does that: only models on the native-vision whitelist (`NATIVE_VISION_MODELS` in `lib/engine.js`) are picked automatically. But the settings page lists **every catalog image-capable model on every configured provider** — whitelisted ones and any you declared image-capable via `modelOverrides` in settings.yaml alike — and an explicit choice (settings page or `vision_analyze` `model` override) is honored. If the chosen model turns out to reject image input upstream, the call automatically falls back to a whitelisted vision model (or degrades to a placeholder when none is available). If you use a genuinely vision-capable model that isn't whitelisted yet, add it to the whitelist so auto-selection prefers it.

**Does it survive a DSH restart?**
Yes. The bundle is registered in the profile's `dsh.profile.bundles` and loads at every dsh boot — that's the whole point of the permanent install.

**Does it cost extra?**
Each transcription is one vision-model call; the same image with the same question is cached, so follow-up turns reuse it. Vision model priority: explicit tool parameters (model/provider) > settings config > auto-select.

**Is my vision-model choice remembered across restarts?**
Yes — since v1.2.0 the settings-page choice is saved in the browser (localStorage) and restored automatically on the next dsh start; the auto-translation waterfall uses the same route. The host-side route itself is process-local.

**What happens when the vision model errors?**
The conversation never breaks: partial output is kept; a total failure retries once with a fallback model; a hung vision call is cut off after two minutes and counted as a failure (so the fallback retry kicks in); if that fails too, the model is told the image is unavailable and the chat continues.

## Bundle layout

- [`lib/engine.js`](lib/engine.js) — the **shared engine, single source of truth**: `vision_analyze` tool, the `llm/stream` translation waterfall, route discovery, caches, timeouts. Zero imports on purpose (pnpm does not install the dependencies of `link:` profile plugins).
- [`lib/index.js`](lib/index.js) — bundle host adapter (composition plugin row `vision`): registers the tool, the waterfall, and the `/vision/api/state` + `/vision/api/model` JSON API on `ctx.webServer`.
- [`lib/client.js`](lib/client.js) — bundle browser half (`dsh.client` roster entry): the "Vision Model" settings page, served by the web shell at `/plugins/dsh-vision-plugin/client.js`.
- [`cordis.patch.yml`](cordis.patch.yml) — the loader patch row mounting the bundle (`dsh.bundle.patch`).
- [`scripts/check.js`](scripts/check.js) — the consistency check (`npm run check`): verifies the version number is in sync everywhere and `lib/engine.js` stays import-free.
- [`test/engine.test.js`](test/engine.test.js) — the engine test suite (`npm test`): route discovery, override precedence, caching/dedup, timeouts, waterfall, tool.

Developing on the plugin itself: edit [`lib/engine.js`](lib/engine.js) (host logic) or [`lib/client.js`](lib/client.js) (UI), then `npm run check && npm test`.

## Under the hood (optional)

Flow: an image enters the session → the `llm/stream` listener checks the target model — native vision models (whitelist) see the image directly; text-only models get a vision-model transcription dispatched in its place. Image detection is recursive, mirroring the harness: images nested inside `tool-result` blocks and images in assistant messages (from a vision-model session) are translated or replaced too, so no image block ever reaches a text-only model. Translation requests carry a Symbol marker to prevent recursion; results are cached by image + question (TTL + FIFO cap, concurrent turns share one in-flight call).

The settings page lists every catalog image-capable model on every configured provider — not just opencode routes: whitelisted native vision models plus any model you declared image-capable via `modelOverrides`. Auto-selection is the only whitelist-gated path: `resolveVisionRoute` only ever picks `NATIVE_VISION_MODELS` entries, because catalog-only "image capability" is indistinguishable from a `modelOverrides` advertisement, and a text-only model would reject the image blocks upstream (`unknown variant \`image_url\``). Explicit user choices are trusted — your configuration decides; if the chosen model fails upstream, the existing retry falls back to a whitelisted vision model.

Tunable constants live at the top of [`lib/engine.js`](lib/engine.js): `DEFAULT_MODEL` (fallback model), `NATIVE_VISION_MODELS` (native-vision whitelist for auto-selection), `MODEL_PRIORITY` (auto-select order), `STREAM_TIMEOUT_MS` (vision-call hang timeout), `CACHE_TTL_MS` / `CACHE_MAX` (translation cache), `CATALOG_TTL_MS` (model-catalog cache).

## License

MIT
