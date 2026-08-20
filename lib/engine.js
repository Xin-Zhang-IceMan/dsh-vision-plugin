/**
 * dsh-vision-plugin — shared engine (single source of truth).
 *
 * This module is the ONE engine behind the plugin: the bundle host half
 * lib/index.js imports it directly (ESM); the browser half is lib/client.js.
 * test/engine.test.js locks the engine's behavior.
 *
 * Zero imports (builtin or otherwise) on purpose: pnpm does not install the
 * dependencies of `link:` profile plugins, so the bundle must not require
 * anything at runtime.
 *
 * What it provides:
 *  1. A model-visible tool `vision_analyze(path, question?, model?, provider?)`
 *     (makeTool) that reads a local image and answers via an image-capable
 *     model on one of the deployment's configured LLM routes (no extra
 *     credentials). Explicit model/provider parameters override the
 *     settings-page default for that single call.
 *  2. An `llm/stream` waterfall listener (makeWaterfallListener) that
 *     automatically translates image blocks (pasted/attached images) into
 *     text descriptions whenever the target model cannot natively accept
 *     images — so a text-only model like deepseek-v4-flash can still "see"
 *     pasted images.
 *  3. A settings surface (catalogState / setConfiguredRoute) that backs the
 *     settings page; the host adapter exposes it as HTTP routes. The
 *     host-side route is process-local; the client half persists it in the
 *     browser and re-applies it after a restart.
 *
 * Route discovery (v1.1.0 — no hard-coded provider):
 *  - resolveVisionRoute walks every registered provider (the calling
 *    request's provider first, then all `llm.listProviders()`), queries each
 *    catalog via `llm.listModels` (cached for CATALOG_TTL_MS), and picks the
 *    first image-capable model — preferring NATIVE_VISION_MODELS whitelist
 *    entries, then MODEL_PRIORITY order, then any remaining image-capable
 *    model.
 *  - The waterfall listener prefers the triggering request's own provider, so
 *    transcription follows whatever route the conversation is using.
 *  - If no provider exposes a vision model, translation degrades to a
 *    placeholder instead of failing the turn.
 *
 * dsh v0.1.0-rc.8+ deepseek-official route (v1.4.0):
 *  - rc.8 ships a built-in `deepseek-official` provider (llm-deepseek) whose
 *    catalog `inputModalities` is the harness-sanctioned native-image switch:
 *    the adapter itself refuses image blocks for models that do not declare
 *    them, so a declared image-capable model is trusted — it joins the
 *    auto-selection pool (after whitelisted models) and the waterfall passes
 *    its image blocks through untranslated.
 *  - pi-ai modelOverrides advertisements remain untrusted for auto-selection
 *    exactly as before: they exist to admit pasted images for text-only
 *    models, whose images must be transcribed.
 *
 * Image dispatch trust model (v1.3.0):
 *  - AUTO-selection (no user choice) stays whitelist-gated: only
 *    NATIVE_VISION_MODELS models are auto-picked, because catalog-only image
 *    capability is untrusted — deployments advertise text-only models as
 *    image-capable via modelOverrides (so the chat admits pasted images),
 *    and such models reject image blocks upstream ("unknown variant
 *    `image_url`, expected `text`").
 *  - EXPLICIT user choices (the settings-page default route, the
 *    vision_analyze `model` override) accept ANY catalog image-capable model
 *    on any configured provider — the user's own configuration decides. If
 *    the chosen model turns out to reject image blocks upstream, the call
 *    fails and the existing retry falls back to a whitelisted vision model,
 *    or the turn degrades to a placeholder.
 *
 * Robustness:
 *  - A stream that produced text but ended with an error finish keeps its
 *    content; a total failure is retried once with a fallback route; if
 *    everything fails the turn degrades to a placeholder block instead of
 *    failing the whole conversation.
 *  - A vision call that hangs is cut off after STREAM_TIMEOUT_MS and treated
 *    as a failure, so the fallback retry can kick in; the caller's AbortSignal
 *    (tool cancellation) stops the call too.
 *  - Translation results are cached per (attachmentId + question) with a TTL
 *    and a FIFO cap; concurrent identical requests share one in-flight call.
 *  - Requests already handled by this plugin carry the TRANSLATED marker and
 *    are never re-translated (no recursion).
 *  - Image blocks are detected recursively, mirroring the harness's own
 *    contentHasImage: they can sit at the top level of a message or nested
 *    inside tool-result blocks, and assistant messages may carry images
 *    (history from a vision-model session). All of them are translated or
 *    replaced so no image block ever reaches a text-only model.
 *
 * Deployment prerequisites:
 *  - At least one configured LLM provider must expose an image-capable model.
 *  - To let pasted images pass the host's admission check for a text-only
 *    model, the deployment advertises that model as image-capable via
 *    `modelOverrides` in settings.yaml (see README):
 *
 *      llm-pi-ai:
 *        providers:
 *          opencode-go:
 *            apiKeyEnv: OPENCODE_GO_API_KEY
 *            modelOverrides:
 *              deepseek-v4-flash:
 *                input: [text, image]
 */

export const VERSION = '1.4.0'

/** Fallback model advertised in the settings page when nothing is configured. */
export const DEFAULT_MODEL = 'qwen3.7-plus'

/** Models that natively accept image input wherever they appear. The
 * deployment may advertise text-only models as image-capable via
 * modelOverrides (so the chat admits pasted images), but those models are
 * NOT in this set — their images must be translated to text before dispatch.
 * This whitelist is the AUTO-SELECTION trust gate (v1.3.0): only these
 * models are auto-picked when the user did not choose, because catalog-only
 * "image capability" is indistinguishable from a modelOverrides
 * advertisement, and text-only models reject image blocks upstream. Explicit
 * user choices (settings page, vision_analyze `model` override) may name any
 * catalog image-capable model. */
export const NATIVE_VISION_MODELS = new Set([
  'minimax-m3', 'qwen3.7-plus', 'qwen3.6-plus',
  'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3',
  'mimo-v2.5', 'grok-4.5',
])

/** The provider route owned by the harness's built-in llm-deepseek plugin
 * (dsh v0.1.0-rc.8+). On this route the catalog's inputModalities is the
 * harness-sanctioned native-image switch: the adapter itself refuses image
 * blocks for models that do not declare them, so a declared image-capable
 * model is trusted to receive images natively — unlike pi-ai modelOverrides,
 * which advertise capability only to admit pasted images. */
export const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official'

/** Preferred order when auto-selecting a vision model for translation. */
export const MODEL_PRIORITY = [
  'qwen3.7-plus', 'kimi-k3', 'grok-4.5', 'minimax-m3',
  'qwen3.6-plus', 'kimi-k2.6', 'mimo-v2.5', 'kimi-k2.7-code',
]

const MEDIA_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Marker carried by every request this plugin already processed (the
 * translated re-dispatch and the internal vision calls), so the waterfall
 * listener never re-translates them. */
export const TRANSLATED = Symbol('vision-translated')

export const DEFAULT_QUESTION = 'Describe this image in detail: its content, layout, visible text, colors, objects, and anything else notable.'
const VISION_SYSTEM = 'You are an image analysis assistant integrated into a coding agent. Answer the user question about the provided image accurately and concisely, in the language of the question. Quote visible text verbatim when relevant.'

// ── shared state ─────────────────────────────────────────────────────────────
/** User-configured default vision route ({ provider, model }, null = auto). */
let configuredRoute = null
/** attachmentId + question -> { text, at }; repeated turns reuse one vision call. */
const cache = new Map()
/** Same key currently being transcribed (dedupes concurrent turns). */
const inFlight = new Map()
/** provider -> { at, models }; listModels results are cached briefly. */
const catalogCache = new Map()

const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 300
const CATALOG_TTL_MS = 60 * 1000
/** A vision call that produces nothing for this long counts as failed. */
const STREAM_TIMEOUT_MS = 120 * 1000

export function getConfiguredRoute() { return configuredRoute }
export function setConfiguredRoute(route) { configuredRoute = route }

/** Reset all module state — used by the test suite. */
export function resetState() {
  configuredRoute = null
  cache.clear()
  inFlight.clear()
  catalogCache.clear()
}

// ── route discovery ───────────────────────────────────────────────────────────

/** Every provider route registered in this deployment, preferred first. */
export function registeredProviders(ctx, preferred) {
  const providers = []
  if (preferred) providers.push(preferred)
  try {
    for (const p of ctx.llm.listProviders()) {
      if (!providers.includes(p.id)) providers.push(p.id)
    }
  } catch (err) {
    console.log('vision: provider discovery failed:', String(err && err.message || err))
  }
  return providers
}

async function listModelsCached(ctx, provider) {
  const hit = catalogCache.get(provider)
  if (hit !== undefined && Date.now() - hit.at < CATALOG_TTL_MS) return hit.models
  const models = await ctx.llm.listModels(provider)
  catalogCache.set(provider, { at: Date.now(), models })
  return models
}

// A model may be auto-selected (and the waterfall may pass its images
// through untranslated) only when it is genuinely image-capable:
//  - a whitelisted model id on any provider, catalog image-capable, or
//  - any catalog image-capable model on the harness's deepseek-official
//    route, where the adapter itself enforces the declared capability
//    (dsh rc.8 native image requests).
// Catalog-only image capability elsewhere is untrusted: deployments advertise
// text-only models as image-capable via pi-ai modelOverrides (so the chat
// admits pasted images), and such models reject image blocks upstream.
function isTrustedVisionModel(model, provider) {
  return !!model
    && isImageCapableModel(model)
    && (NATIVE_VISION_MODELS.has(model.id) || provider === DEEPSEEK_OFFICIAL_PROVIDER)
}

// Catalog-level image capability: the deployment's model catalog (including
// any modelOverrides the user declared) says this model takes image input.
// This is the gate for EXPLICIT user choices — the settings-page route and
// the vision_analyze `model` override. Untrusted for auto-selection.
function isImageCapableModel(model) {
  return !!model && Array.isArray(model.inputModalities) && model.inputModalities.includes('image')
}

// AUTO-SELECTION: find the first trusted vision model, preferring the
// caller's provider, then whitelist MODEL_PRIORITY order within a provider,
// then any remaining trusted model on it. Providers whose only
// "image-capable" models come from modelOverrides advertisements are skipped
// — only trusted native vision models are ever auto-picked.
export async function resolveVisionRoute(ctx, preferredProvider) {
  for (const provider of registeredProviders(ctx, preferredProvider)) {
    try {
      const models = await listModelsCached(ctx, provider)
      const trusted = models.filter((m) => isTrustedVisionModel(m, provider))
      for (const id of MODEL_PRIORITY) {
        const found = trusted.find((m) => m.id === id)
        if (found) return { provider, model: found.id }
      }
      if (trusted.length > 0) return { provider, model: trusted[0].id }
    } catch (err) {
      console.log('vision: catalog lookup failed for provider', provider + ':', String(err && err.message || err))
    }
  }
  return { provider: preferredProvider || null, model: null }
}

// Find the provider that serves one exact catalog image-capable model id.
// Used for EXPLICIT selections (settings route, tool override): any model the
// deployment's catalog reports as image-capable qualifies, whitelisted or
// not — the user's configuration decides. Returns null for text-only models.
export async function findProviderForModel(ctx, model, preferredProvider) {
  for (const provider of registeredProviders(ctx, preferredProvider)) {
    try {
      const models = await listModelsCached(ctx, provider)
      const found = models.find((m) => m.id === model && isImageCapableModel(m))
      if (found) return provider
    } catch (err) {
      console.log('vision: catalog lookup failed for provider', provider + ':', String(err && err.message || err))
    }
  }
  return null
}

export async function catalogState(ctx) {
  let models = []
  for (const provider of registeredProviders(ctx, null)) {
    try {
      const all = await listModelsCached(ctx, provider)
      for (const m of all) {
        models.push({
          id: m.id,
          name: m.name || m.id,
          image: Array.isArray(m.inputModalities) && m.inputModalities.includes('image'),
          native: isTrustedVisionModel(m, provider),
          provider,
        })
      }
    } catch (err) {
      console.log('vision: catalog lookup failed for provider', provider + ':', String(err && err.message || err))
    }
  }
  const route = configuredRoute || await resolveVisionRoute(ctx, null)
  // Native vision ids shown on the settings page: the whitelist plus any
  // rc.8 deepseek-official model the catalog trusts (native flag is
  // provider-aware, so duplicate ids on override-advertised routes are kept
  // out).
  const nativeIds = new Set(NATIVE_VISION_MODELS)
  for (const m of models) {
    if (m.native && !nativeIds.has(m.id)) nativeIds.add(m.id)
  }
  return {
    version: VERSION,
    configuredRoute: configuredRoute || null,
    defaultModel: DEFAULT_MODEL,
    provider: (route && route.provider) || null,
    nativeVisionModels: [...nativeIds],
    priority: MODEL_PRIORITY,
    models,
  }
}

// ── the vision call itself ────────────────────────────────────────────────────

/** One vision-model call over the deployment's own LLM routes. The request
 * carries the TRANSLATED marker so the waterfall listener passes it through.
 * Tolerates a stream that produced text but ended with an error finish (the
 * content is already usable); only a total failure throws, and it is retried
 * once with a fallback route. Explicit call parameters (model/provider) and
 * the settings-page default win over auto-selection; auto-selection is the
 * last resort and only ever picks whitelisted native vision models. */
export async function runVisionCall(ctx, imageBlocks, question, requestedModel, requestedProvider, { timeoutMs, signal } = {}) {
  let provider = null
  let model = null
  if (requestedModel) {
    // Explicit per-call override wins over the configured default — any
    // catalog image-capable model qualifies (whitelisted or not).
    provider = await findProviderForModel(ctx, requestedModel, requestedProvider || (configuredRoute && configuredRoute.provider))
    model = requestedModel
    if (provider === null) {
      throw new Error(`vision: "${requestedModel}" is not an image-capable model on any configured provider`)
    }
  } else if (configuredRoute) {
    // The settings-page default: honored when the catalog still reports the
    // model as image-capable on a configured provider (it may be a
    // non-whitelisted model the user declared via modelOverrides — their
    // choice, honored with automatic fallback if the upstream refuses).
    provider = await findProviderForModel(ctx, configuredRoute.model, configuredRoute.provider)
    model = configuredRoute.model
    if (provider === null) {
      console.log('vision: ignoring configured route', configuredRoute.provider + '/' + configuredRoute.model + ': not image-capable per the catalog; falling back to auto-selection')
    }
  }
  if (provider === null || model === null) {
    const route = await resolveVisionRoute(ctx, requestedProvider || (configuredRoute && configuredRoute.provider))
    provider = route.provider
    model = route.model
    if (!provider || !model) {
      throw new Error('vision: no vision-capable model found on any configured provider')
    }
  }
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await streamOnce(ctx, provider, model, imageBlocks, question, { timeoutMs, signal })
    if (result.ok) return { description: result.description, model, provider, truncated: result.truncated }
    lastError = result.error
    console.log('vision: attempt', attempt + 1, 'failed for', provider + '/' + model + ':', lastError)
    if (attempt === 0) {
      const route = await resolveVisionRoute(ctx, provider)
      if (route.model !== null && route.model !== model) {
        provider = route.provider
        model = route.model
      }
    }
  }
  throw new Error(lastError || 'vision model unavailable')
}

/** Consume one llm.stream call, with a hang timeout and abort support. A
 * stream that produced text but ended with an error finish keeps its content
 * ({ ok: true }); only a total failure returns { ok: false }. */
export async function streamOnce(ctx, provider, model, imageBlocks, question, { timeoutMs = STREAM_TIMEOUT_MS, signal } = {}) {
  let text = ''
  let reasoning = ''
  let truncated = false
  let finishKind = 'stop'
  let failure = null
  let stopped = false
  let timer = null
  let onAbort = null
  const consume = (async () => {
    const chunks = ctx.llm.stream({
      provider,
      model,
      system: VISION_SYSTEM,
      messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: question }] }],
      [TRANSLATED]: true,
    })
    for await (const chunk of chunks) {
      if (stopped) break
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk.type === 'finish') {
        finishKind = chunk.reason.kind
        if (chunk.reason.failure) failure = chunk.reason.failure
      }
    }
  })()
  const done = consume.then(() => 'done')
  done.catch(() => {}) // the race may settle first; swallow a late rejection
  const guard = new Promise((resolve) => {
    if (timeoutMs > 0) {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    }
    if (signal && typeof signal.aborted === 'boolean') {
      if (signal.aborted) {
        resolve('abort')
        return
      }
      onAbort = () => resolve('abort')
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  let outcome
  try {
    outcome = await Promise.race([done, guard])
  } catch (err) {
    return { ok: false, error: `vision model call failed: ${String(err && err.message || err)}` }
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (onAbort !== null) signal.removeEventListener('abort', onAbort)
  }
  if (outcome !== 'done') {
    stopped = true
    return { ok: false, error: `vision model call ${outcome === 'timeout' ? 'timed out' : 'was cancelled'}` }
  }
  const produced = text.trim().length > 0 || reasoning.trim().length > 0
  if ((finishKind === 'error' || finishKind === 'aborted') && !produced) {
    const detail = failure
      ? `${failure.message}${failure.code ? ' [' + failure.code + ']' : ''}${failure.status ? ' (HTTP ' + failure.status + ')' : ''}`
      : 'unknown upstream error'
    return { ok: false, error: `vision model returned an error: ${detail}` }
  }
  if (finishKind === 'error' || finishKind === 'aborted') {
    // Content was produced before the stream errored; keep it.
    console.log('vision: stream ended with', finishKind, 'but text was produced; keeping it')
  }
  if (finishKind === 'max-tokens') truncated = true
  const description = text.trim().length > 0 ? text.trim() : (reasoning.trim() || '(no textual output)')
  return { ok: true, description, truncated }
}

// ── image translation ─────────────────────────────────────────────────────────

function cacheGet(key) {
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return entry.text
}

function cacheSet(key, text) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { text, at: Date.now() })
}

// Mirrors the harness's own contentHasImage: image blocks can sit at the top
// level of a message or nested inside tool-result blocks.
function hasImage(content) {
  return Array.isArray(content) && content.some((b) =>
    b && (b.type === 'image' || (b.type === 'tool-result' && hasImage(b.content))))
}

// Collect every image block, top-level first, then nested in tool-results.
function collectImages(content) {
  const found = []
  const walk = (blocks) => {
    for (const b of blocks) {
      if (!b) continue
      if (b.type === 'image') found.push(b)
      else if (b.type === 'tool-result' && Array.isArray(b.content)) walk(b.content)
    }
  }
  walk(content)
  return found
}

// Replace every image block (recursively) with the given text block, keeping
// the surrounding structure (tool-result blocks keep their identity).
function replaceImages(content, textBlock) {
  const out = []
  for (const b of content) {
    if (!b) {
      out.push(b)
    } else if (b.type === 'image') {
      out.push({ ...textBlock })
    } else if (b.type === 'tool-result' && Array.isArray(b.content)) {
      out.push({ ...b, content: replaceImages(b.content, textBlock) })
    } else {
      out.push(b)
    }
  }
  return out
}

// Non-user messages (assistant output, …): the image is replaced by a short
// note — it cannot be transcribed as input, but it must not reach the model.
function omitImages(content) {
  return replaceImages(content, { type: 'text', text: '[模型输出的图片已省略 / image emitted by the model omitted]' })
}

// Replace image blocks in messages with vision-model text descriptions.
// Every non-image block (text, file, tool-result, …) is preserved; a failed
// translation degrades to a placeholder instead of failing the turn. Results
// are cached per (attachmentId + question); concurrent identical requests
// share one call. Image blocks are handled wherever they appear: top-level in
// user messages, nested inside tool-result blocks, or in assistant messages.
export async function translateMessages(ctx, messages, preferredProvider) {
  const out = []
  for (const message of messages) {
    if (!message || !Array.isArray(message.content) || !hasImage(message.content)) {
      out.push(message)
      continue
    }
    if (message.role !== 'user') {
      out.push({ ...message, content: omitImages(message.content) })
      continue
    }
    const imageBlocks = collectImages(message.content)
    const textBlocks = message.content.filter((b) => b && b.type === 'text')
    const question = textBlocks.map((b) => b.text).join('\n').trim() || DEFAULT_QUESTION
    const ids = imageBlocks.map((b, idx) => (b.attachment && b.attachment.attachmentId) || ('?#' + idx)).join('+')
    const key = ids + '\u0000' + question
    let description = cacheGet(key)
    let failed = false
    if (description === undefined) {
      const pending = inFlight.get(key)
      if (pending === undefined) {
        const promise = runVisionCall(ctx, imageBlocks, question, null, preferredProvider).then((r) => r.description)
        inFlight.set(key, promise)
        try {
          description = await promise
          cacheSet(key, description)
        } catch (err) {
          failed = true
          description = `[图片转写失败 / transcription failed: ${String(err && err.message || err)}]`
          console.log('vision: translation failed:', String(err && err.message || err))
        } finally {
          inFlight.delete(key)
        }
      } else {
        try {
          description = await pending
        } catch (err) {
          failed = true
          description = `[图片转写失败 / transcription failed: ${String(err && err.message || err)}]`
        }
      }
    }
    out.push({
      ...message,
      content: replaceImages(message.content, {
        type: 'text',
        text: failed
          ? `[图片内容]（视觉模型转写失败 / transcription failed，图片内容不可用）\n${description}`
          : `[图片内容]（已由视觉模型自动转写 / auto-transcribed by vision model）\n${description}`,
      }),
    })
  }
  return out
}

// ── the llm/stream waterfall ─────────────────────────────────────────────────

/** True when a request for this model may keep its image blocks untranslated:
 * a whitelisted model on any route, or a catalog image-capable model on the
 * harness's deepseek-official route — the rc.8+ adapter-enforced native-image
 * switch, where a declared capability is what the adapter will actually
 * serialize. Catalog failures degrade to false: the request gets transcribed,
 * which is always safe. */
export async function shouldKeepImages(ctx, provider, model) {
  if (NATIVE_VISION_MODELS.has(model)) return true
  if (provider !== DEEPSEEK_OFFICIAL_PROVIDER) return false
  try {
    const models = await listModelsCached(ctx, provider)
    return isTrustedVisionModel(models.find((m) => m.id === model), provider)
  } catch (err) {
    console.log('vision: native-image check failed for', provider + '/' + model + ':', String(err && err.message || err))
    return false
  }
}

/** Waterfall around every model call: when a request carries image blocks —
 * top-level, nested inside tool-results, or in assistant messages — and the
 * target model is not a native vision model, translate the images to text via
 * the vision model first, then re-dispatch with text-only messages. */
export function makeWaterfallListener(ctx) {
  return async function* (options, next) {
    if (!options || !Array.isArray(options.messages)
      || !options.messages.some((m) => m && hasImage(m.content))) {
      return yield* next()
    }
    if (options[TRANSLATED]) return yield* next()
    if (await shouldKeepImages(ctx, options.provider, options.model)) {
      return yield* next()
    }
    let messages
    try {
      messages = await translateMessages(ctx, options.messages, options.provider)
    } catch (err) {
      // Unexpected failure inside translation itself: degrade rather than kill
      // the turn — strip image blocks (recursively) so the text-only model
      // still answers.
      console.log('vision: translation crashed:', String(err && err.stack || err))
      messages = options.messages.map((m) => {
        if (!m || !Array.isArray(m.content) || !hasImage(m.content)) return m
        return {
          ...m,
          content: replaceImages(m.content, {
            type: 'text',
            text: '[图片内容]（视觉模型转写失败 / transcription failed，图片内容不可用）',
          }),
        }
      })
    }
    console.log('vision: image blocks translated to text for', options.provider + '/' + options.model)
    return yield* ctx.llm.stream({ ...options, [TRANSLATED]: true, messages })
  }
}

// ── the tool ─────────────────────────────────────────────────────────────────

export function makeTool(ctx) {
  return {
    name: 'vision_analyze',
    description: 'Analyze a local image file with an external vision-capable model and return its content as detailed text. Use this whenever you need to see, read, or understand an image (screenshots, photos, diagrams, charts, UI mockups, scanned documents, plots). The image is sent to a vision model and its description is returned to you as text.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the image file (PNG, JPEG, WebP, or GIF). Absolute paths are used as-is; relative paths resolve against the session workspace.',
        },
        question: {
          type: 'string',
          description: 'Optional specific question about the image. When omitted, the vision model produces a detailed description of the whole image.',
        },
        model: {
          type: 'string',
          description: 'Optional vision model id override (e.g. "qwen3.7-plus", "kimi-k3", "grok-4.5"). Takes precedence over the settings-page default for this call; when omitted, the configured default or an auto-selected image-capable model is used.',
        },
        provider: {
          type: 'string',
          description: 'Optional LLM provider route override. When omitted, the route is discovered automatically across all configured providers.',
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          model: { type: 'string' },
          provider: { type: 'string' },
          imagePath: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      render(args, value) {
        const head = value.truncated ? ' [output truncated]' : ''
        return [{
          type: 'text',
          text: `[vision] ${value.provider}/${value.model} analyzed ${value.imagePath}${head}\n\n${value.description}`,
        }]
      },
      presentationMeta(args, value) {
        return { imagePath: args.path, model: value.model, provider: value.provider }
      },
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const provider = args.provider || null
      const target = await ctx.fs.resolve(args.path)
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) {
        throw new Error(`vision_analyze: file not found: ${args.path}`)
      }
      const lower = args.path.toLowerCase()
      let mediaType = null
      for (const ext of Object.keys(MEDIA_BY_EXT)) {
        if (lower.endsWith(ext)) { mediaType = MEDIA_BY_EXT[ext]; break }
      }
      if (mediaType === null) {
        throw new Error('vision_analyze: unsupported image type; use PNG, JPEG, WebP, or GIF')
      }
      const limits = ctx.attachments.imageLimits
      const maxBytes = limits && limits.maxImageBytes ? limits.maxImageBytes : 20 * 1024 * 1024
      const bytes = await ctx.fs.readBytes(target, exec.signal, maxBytes)
      if (bytes.length === 0) throw new Error('vision_analyze: image file is empty')
      const ref = await ctx.attachments.saveImage({
        data: bytes,
        mediaType,
        name: String(args.path.split('/').pop() || 'image'),
      })
      const question = args.question && args.question.trim().length > 0
        ? args.question.trim()
        : DEFAULT_QUESTION
      const result = await runVisionCall(ctx, [{ type: 'image', attachment: ref }], question, args.model, provider, { signal: exec.signal })
      return { description: result.description, model: result.model, provider: result.provider, imagePath: args.path, truncated: result.truncated }
    },
  }
}
