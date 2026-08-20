# AGENTS.md — dsh-vision-plugin

Guidance for coding agents working in this repository. Read it before making changes.

## What this repository is

**dsh-vision-plugin** is a plugin for DeepSeek Harness (DSH) that gives text-only models vision: images pasted into the chat are transcribed by an image-capable model before they reach a text-only main model, plus the `vision_analyze` tool and a bilingual settings page. Current version lives in `package.json`.

The repo root is a dsh **bundle package** (permanent install): the host half `lib/index.js` and the browser half `lib/client.js` are mounted by the loader row in `cordis.patch.yml`, and both draw all their logic from the single engine `lib/engine.js`. There is no second plugin form, no generated code, and no build step.

## Repository layout

| Path | Role | Editing rule |
|---|---|---|
| `lib/engine.js` | Single source of truth: `vision_analyze` tool, `llm/stream` waterfall, route discovery, caches, timeouts, all tunable constants | **Edit here** |
| `lib/index.js` | Bundle host adapter (composition row `vision`): registers the tool, the waterfall, and the HTTP JSON API `/vision/api/state` + `/vision/api/model` | Edit (thin — no logic) |
| `lib/client.js` | Bundle browser half: the "Vision Model" settings page (bilingual zh/en), served at `/plugins/dsh-vision-plugin/client.js` | Edit |
| `cordis.patch.yml` | Loader patch row mounting the bundle (`dsh.bundle.patch`) | Edit rarely |
| `scripts/check.js` | Consistency check (`npm run check`): version sync + zero-import rule; exit 1 on failure | Edit |
| `test/engine.test.js` | Engine test suite (`npm test`): route discovery, override precedence, caching/dedup, timeouts, waterfall, tool, version sync | Edit (add tests) |
| `README.md`, `README.zh.md` | Human docs (English / Chinese), kept in sync, each mentions `v<version>` | Edit both together |

`clash-logo.png` / `vision-test.png` are scratch images; `*.png` etc. are gitignored.

## The verification loop (always follow)

1. Edit `lib/engine.js` (engine logic) and/or `lib/client.js` (UI).
2. Run `npm run check` — verifies the version is in sync everywhere and `lib/engine.js` stays import-free.
3. Run `npm test` — `node --test test/*.test.js`; must pass **before** finishing any change.

There is no `npm run build` anymore — nothing in this repo is generated.

## Hard invariants

- **`lib/engine.js` must stay import-free** — not even builtins. `scripts/check.js` fails on any `^import` line. Reason: pnpm does not install the dependencies of `link:` profile plugins, so the bundle must not require anything at runtime.
- **Never move logic into the adapter.** `lib/index.js` does registration and transport only; all behavior (route discovery, retry, cache, timeout, translation) belongs in `lib/engine.js`.
- **Every behavioral change to the engine gets a test** in `test/engine.test.js`. Tests use `resetState()` in `beforeEach`; new exported functions must be tested through the existing `makeCtx` / fake-stream helpers.
- **Keep the version in sync** across: `package.json` `version`, `VERSION` in `lib/engine.js`, and a literal `v<version>` mention in **both** READMEs. `npm run check` verifies all of them.

## DSH platform notes (do not violate)

- **Zero runtime dependencies.** The package declares none and must not add any.
- The bundle mounts at boot via the `vision` row in `cordis.patch.yml`; the browser half is served at `/plugins/dsh-vision-plugin/client.js` through the `dsh.client` declaration in `package.json`.
- Host integration points: `ctx.tools.register` (tool), `ctx.on('llm/stream', …)` (waterfall), `ctx.webServer.register` (HTTP API). The client half injects `slots` / `locale` and registers into the `settings.section` slot; it talks to the host via `GET /vision/api/state` and `POST /vision/api/model`.
- **The row must never hard-inject `webServer`.** Since dsh rc.8 the boot audit fails any loader entry left pending on a missing service, and headless stacks have no web server. The settings API is registered through `ctx.inject(['webServer'], …)` inside `apply` — keep it that way.
- **rc.8's `deepseek-official` route is trusted** (see `DEEPSEEK_OFFICIAL_PROVIDER` in `lib/engine.js`): its catalog `inputModalities` is adapter-enforced, so declared image-capable models count as native vision for auto-selection and the waterfall bypass. pi-ai `modelOverrides` advertisements stay untrusted — that asymmetry is intentional and tested.
- A deployment prerequisite that docs and release notes must keep mentioning: text-only models need `input: [text, image]` declared via `modelOverrides` in `~/.dsh/settings.yaml`, otherwise pasted images are rejected before the plugin can transcribe them. On rc.8+ the `llm-deepseek` section (`models[].inputModalities`) is the native alternative for DeepSeek models.
- The translation re-dispatch must always carry the `TRANSLATED` Symbol (and the waterfall must pass such requests through) — that marker is what prevents infinite recursion.

## Code conventions

- Plain modern JavaScript (ESM, `"type": "module"`), **no TypeScript**, no transpile step. Node >= 18.
- Style: 2-space indent, single quotes, semicolons, trailing commas, `===` comparisons.
- Every file starts with a block comment: what it is, its role in the bundle, and what it must not import.
- Section dividers: `// ── section name ──…` inside files.
- Logging goes through `console.log` with the `vision:` prefix (e.g. `vision: translation failed: …`). Tool-facing errors are thrown as `Error` with a `vision_analyze:` prefix; the waterfall and translation paths **never** throw to the conversation — they degrade to a bilingual placeholder block (`[图片内容]（…转写失败…）`) instead.
- User-facing copy is **bilingual zh/en**: the settings page uses the `locale` service dictionaries (`zh` / `en` in `lib/client.js`), and inline fallback strings in the engine (placeholder / failure text) carry both languages.

## Version bumps

1. Bump `version` in `package.json`.
2. Bump `export const VERSION` in `lib/engine.js`.
3. Update the `v<version>` mentions in `README.md` and `README.zh.md` (header badge/line and any body references).
4. Run `npm run check && npm test`.

## Common tasks

- **Add a model to the native-vision whitelist** → edit `NATIVE_VISION_MODELS` (and usually `MODEL_PRIORITY`) at the top of `lib/engine.js`; add/extend a route-discovery test.
- **Change the settings page** → edit `lib/client.js` (remember zh + en dictionaries), then `npm run check && npm test`.
- **Add a tunable** (timeout, cache size) → new constant in `lib/engine.js`, document it in the file header, add a test.
- **Fix a bug** → reproduce it as a `test/engine.test.js` case first, fix `lib/engine.js`, then `npm run check && npm test`.
- **Update the docs** → edit `README.md` and `README.zh.md` together, keeping the version mentions intact.

## Commit message style

Follow the existing history: subject + optional `(#dsh-plugin)` suffix, e.g. `v1.1.0: dynamic vision-route discovery across all providers, no hard-coded route (#dsh-plugin)`. Version-bump commits lead with the version.
