/**
 * dsh-vision-plugin — give text-only DSH models (e.g. deepseek-v4) vision.
 *
 * HOST half of the bundle (composition plugin row). This module is imported
 * by the dsh Loader at boot (row `vision` in cordis.patch.yml, package
 * `dsh-vision-plugin` in the profile's `dsh.profile.bundles`), so the plugin
 * is permanently active on every dsh start — no cordis_define/cordis_run
 * needed and it survives restarts. The browser half is lib/client.js.
 *
 * What it provides:
 *  1. A model-visible tool `vision_analyze(path, question?, model?, provider?)`
 *     that reads a local image and answers via an image-capable model on one
 *     of the deployment's configured LLM routes (no extra credentials).
 *  2. An `llm/stream` waterfall listener that automatically translates image
 *     blocks (pasted/attached images) into text descriptions whenever the
 *     target model cannot natively accept images — so a text-only model like
 *     deepseek-v4-flash can still "see" pasted images.
 *  3. A small JSON API (`GET /vision/api/state`, `POST /vision/api/model`)
 *     that backs the settings page (see lib/client.js): configure the
 *     default vision route (provider + model) from the UI. The configured
 *     route is process-local and takes precedence over auto-selection.
 *
 * Route discovery (v1.1.0 — no hard-coded provider):
 *  - `resolveVisionRoute(preferred)`: walks every registered provider (the
 *    calling request's provider first, then all `llm.listProviders()`),
 *    queries each catalog via `llm.listModels`, and picks the first
 *    image-capable model — preferring NATIVE_VISION_MODELS whitelist entries,
 *    then MODEL_PRIORITY order, then any remaining image-capable model.
 *  - The waterfall listener prefers the triggering request's own provider, so
 *    transcription follows whatever route the conversation is using.
 *  - If no provider exposes a vision model, translation degrades to a
 *    placeholder instead of failing the turn.
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
 *
 * Notes:
 *  - The waterfall listener registers on this row's context, which shares the
 *    root isolate, so it serves every session/agent in the process. Requests
 *    already handled by this plugin carry a Symbol marker and are never
 *    re-translated (no recursion).
 *  - Translation results are cached per (attachmentId + question) so repeated
 *    turns reuse one vision call.
 *  - Robustness: a stream that produced text but ended with an error finish
 *    keeps its content; a total failure is retried once with a fallback
 *    route; if everything fails the turn degrades to a placeholder block
 *    instead of failing the whole conversation.
 */

// Zero non-builtin imports on purpose: pnpm does not install the
// dependencies of `link:` profile plugins, and the module's own imports
// resolve from this package's real path — never from the profile's shared
// node_modules fallback. The tool definition below is therefore built
// inline in the exact shape `ctx.tools.register` validates
// (ToolRuntime.register: output { schema, render, presentationMeta? },
// positive timeoutMs; parameters are the raw JSON schema the agent loop
// shows the model).

export const name = 'vision'

/** Services this row needs: the injected `llm`/`fs`/`attachments` services,
 * the tool registry, and the web server (settings JSON API). */
export const inject = ['fs', 'llm', 'attachments', 'tools', 'webServer']

export function apply(ctx) {
  const DEFAULT_MODEL = 'qwen3.7-plus'
  const VERSION = '1.1.1'
  // Models that natively accept image input wherever they appear. The
  // deployment may advertise text-only models as image-capable via
  // modelOverrides (so the chat admits pasted images), but those models are
  // NOT in this set — their images must be translated to text before dispatch.
  const NATIVE_VISION_MODELS = new Set([
    'minimax-m3', 'qwen3.7-plus', 'qwen3.6-plus',
    'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3',
    'mimo-v2.5', 'grok-4.5',
  ])
  // Preferred order when auto-selecting a vision model for translation.
  const MODEL_PRIORITY = [
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
  // Marker carried by every request this plugin already processed (the
  // translated re-dispatch and the internal vision calls), so the waterfall
  // listener never re-translates them.
  const TRANSLATED = Symbol('vision-translated')
  const DEFAULT_QUESTION = 'Describe this image in detail: its content, layout, visible text, colors, objects, and anything else notable.'
  const VISION_SYSTEM = 'You are an image analysis assistant integrated into a coding agent. Answer the user question about the provided image accurately and concisely, in the language of the question. Quote visible text verbatim when relevant.'
  // attachmentId + question -> description, so repeated turns reuse one vision call.
  const cache = new Map()
  // User-configured default vision route ({ provider, model }, null = auto).
  let configuredRoute = null

  // Every provider route registered in this deployment, preferred first.
  function registeredProviders(preferred) {
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

  // Find the first image-capable model, preferring the caller's provider,
  // then native-vision whitelist models, then MODEL_PRIORITY order.
  async function resolveVisionRoute(preferredProvider) {
    for (const provider of registeredProviders(preferredProvider)) {
      try {
        const models = await ctx.llm.listModels(provider)
        const vision = models.filter((m) =>
          Array.isArray(m.inputModalities) && m.inputModalities.includes('image'))
        const native = vision.filter((m) => NATIVE_VISION_MODELS.has(m.id))
        const candidates = native.length > 0 ? native : vision
        for (const id of MODEL_PRIORITY) {
          const found = candidates.find((m) => m.id === id)
          if (found) return { provider, model: found.id }
        }
        if (candidates.length > 0) return { provider, model: candidates[0].id }
      } catch (err) {
        console.log('vision: catalog lookup failed for provider', provider + ':', String(err && err.message || err))
      }
    }
    return { provider: preferredProvider || null, model: null }
  }

  // Find the provider that serves one exact image-capable model id.
  async function findProviderForModel(model, preferredProvider) {
    for (const provider of registeredProviders(preferredProvider)) {
      try {
        const models = await ctx.llm.listModels(provider)
        const found = models.find((m) => m.id === model
          && Array.isArray(m.inputModalities) && m.inputModalities.includes('image'))
        if (found) return provider
      } catch (err) {
        console.log('vision: catalog lookup failed for provider', provider + ':', String(err && err.message || err))
      }
    }
    return null
  }

  async function catalogState() {
    let models = []
    for (const provider of registeredProviders(null)) {
      try {
        const all = await ctx.llm.listModels(provider)
        for (const m of all) {
          models.push({
            id: m.id,
            name: m.name || m.id,
            image: Array.isArray(m.inputModalities) && m.inputModalities.includes('image'),
            provider,
          })
        }
      } catch (err) {
        console.log('vision: catalog lookup failed for provider', provider + ':', String(err && err.message || err))
      }
    }
    const route = configuredRoute || await resolveVisionRoute(null)
    return {
      version: VERSION,
      configuredRoute: configuredRoute || null,
      defaultModel: DEFAULT_MODEL,
      provider: (route && route.provider) || null,
      nativeVisionModels: [...NATIVE_VISION_MODELS],
      priority: MODEL_PRIORITY,
      models,
    }
  }

  // One vision-model call over the deployment's own LLM routes. The request
  // carries the TRANSLATED marker so the waterfall listener passes it through.
  // Tolerates a stream that produced text but ended with an error finish
  // (the content is already usable); only a total failure throws, and it is
  // retried once with a fallback route.
  async function runVisionCall(imageBlocks, question, requestedModel, requestedProvider) {
    let provider = null
    let model = null
    if (configuredRoute) {
      provider = configuredRoute.provider
      model = configuredRoute.model
    } else if (requestedModel) {
      provider = await findProviderForModel(requestedModel, requestedProvider)
      model = requestedModel
      if (provider === null) {
        throw new Error(`vision: "${requestedModel}" is not an image-capable model on any configured provider`)
      }
    } else {
      const route = await resolveVisionRoute(requestedProvider || null)
      provider = route.provider
      model = route.model
      if (!provider || !model) {
        throw new Error('vision: no vision-capable model found on any configured provider')
      }
    }
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await streamOnce(provider, model, imageBlocks, question)
      if (result.ok) return { description: result.description, model, provider, truncated: result.truncated }
      lastError = result.error
      console.log('vision: attempt', attempt + 1, 'failed for', provider + '/' + model + ':', lastError)
      if (attempt === 0) {
        const route = await resolveVisionRoute(provider)
        if (route.model !== null && route.model !== model) {
          provider = route.provider
          model = route.model
        }
      }
    }
    throw new Error(lastError || 'vision model unavailable')
  }

  async function streamOnce(provider, model, imageBlocks, question) {
    let text = ''
    let reasoning = ''
    let truncated = false
    let finishKind = 'stop'
    let failure = null
    try {
      const chunks = ctx.llm.stream({
        provider,
        model,
        system: VISION_SYSTEM,
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: question }] }],
        [TRANSLATED]: true,
      })
      for await (const chunk of chunks) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
        else if (chunk.type === 'finish') {
          finishKind = chunk.reason.kind
          if (chunk.reason.failure) failure = chunk.reason.failure
        }
      }
    } catch (err) {
      return { ok: false, error: `vision model call failed: ${String(err && err.message || err)}` }
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

  // Replace image blocks in user messages with vision-model text descriptions.
  // A failed translation degrades to a placeholder instead of failing the turn.
  async function translateMessages(messages, preferredProvider) {
    const out = []
    for (const message of messages) {
      if (!message || message.role !== 'user' || !Array.isArray(message.content)
        || !message.content.some((b) => b && b.type === 'image')) {
        out.push(message)
        continue
      }
      const imageBlocks = message.content.filter((b) => b && b.type === 'image')
      const textBlocks = message.content.filter((b) => b && b.type === 'text')
      const question = textBlocks.map((b) => b.text).join('\n').trim() || DEFAULT_QUESTION
      const ids = imageBlocks.map((b, idx) => (b.attachment && b.attachment.attachmentId) || ('?#' + idx)).join('+')
      const key = ids + '\u0000' + question
      let description = cache.get(key)
      let failed = false
      if (description === undefined) {
        try {
          const result = await runVisionCall(imageBlocks, question, null, preferredProvider)
          description = result.description
          if (cache.size >= 300) cache.clear()
          cache.set(key, description)
        } catch (err) {
          failed = true
          description = `[图片转写失败：${String(err && err.message || err)}]`
          console.log('vision: translation failed:', String(err && err.message || err))
        }
      }
      const newContent = []
      for (const block of textBlocks) newContent.push(block)
      newContent.push({
        type: 'text',
        text: failed
          ? `[图片内容]（视觉模型转写失败，图片内容不可用）\n${description}`
          : `[图片内容]（已由视觉模型自动转写）\n${description}`,
      })
      out.push({ ...message, content: newContent })
    }
    return out
  }

  // Waterfall around every model call: when a request carries image blocks and
  // the target model is not a native vision model, translate the images to
  // text via the vision model first, then re-dispatch with text-only messages.
  ctx.on('llm/stream', async function* (options, next) {
    if (!options || !Array.isArray(options.messages)
      || !options.messages.some((m) => m && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'image'))) {
      return yield* next()
    }
    if (options[TRANSLATED]) return yield* next()
    if (NATIVE_VISION_MODELS.has(options.model)) {
      return yield* next()
    }
    let messages
    try {
      messages = await translateMessages(options.messages, options.provider)
    } catch (err) {
      // Unexpected failure inside translation itself: degrade rather than kill
      // the turn — strip image blocks so the text-only model still answers.
      console.log('vision: translation crashed:', String(err && err.stack || err))
      messages = options.messages.map((m) => {
        if (!m || m.role !== 'user' || !Array.isArray(m.content)) return m
        const textBlocks = m.content.filter((b) => b && b.type === 'text')
        if (!m.content.some((b) => b && b.type === 'image')) return m
        return { ...m, content: [...textBlocks, { type: 'text', text: '[图片内容]（视觉模型转写失败，图片内容不可用）' }] }
      })
    }
    console.log('vision: image blocks translated to text for', options.provider + '/' + options.model)
    return yield* ctx.llm.stream({ ...options, [TRANSLATED]: true, messages })
  })

  const tool = {
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
          description: 'Optional vision model id override (e.g. "qwen3.7-plus", "kimi-k3", "grok-4.5"). When omitted, an image-capable model is chosen automatically.',
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
      const result = await runVisionCall([{ type: 'image', attachment: ref }], question, args.model, provider)
      return { description: result.description, model: result.model, provider: result.provider, imagePath: args.path, truncated: result.truncated }
    },
  }

  ctx.effect(() => ctx.tools.register(tool))

  // ── settings JSON API (browser half reads these) ───────────────────────────

  const sendJson = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  const readJsonBody = (req, maxBytes = 65536) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })

  // GET /vision/api/state -> current catalog + configured route.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/vision/api/state',
    handler: async (_req, res) => {
      try {
        sendJson(res, 200, await catalogState())
      } catch (err) {
        console.log('vision: /vision/api/state failed:', String(err && err.message || err))
        sendJson(res, 500, { error: String(err && err.message || err) })
      }
    },
  }))

  // POST /vision/api/model {model, provider?} — model: null resets to auto.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/vision/api/model',
    handler: async (req, res) => {
      let args
      try {
        args = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { error: String(err && err.message || err) })
        return
      }
      try {
        const model = args && args.model !== undefined && args.model !== null ? String(args.model) : null
        if (model === null) {
          configuredRoute = null
          console.log('vision: default vision route set to auto')
        } else {
          const preferred = args && args.provider ? String(args.provider) : null
          const provider = await findProviderForModel(model, preferred)
          if (provider === null) {
            throw new Error(`vision: "${model}" is not an image-capable model on any configured provider`)
          }
          configuredRoute = { provider, model }
          console.log('vision: default vision route set to', provider + '/' + model)
        }
        sendJson(res, 200, await catalogState())
      } catch (err) {
        console.log('vision: /vision/api/model failed:', String(err && err.message || err))
        sendJson(res, 400, { error: String(err && err.message || err) })
      }
    },
  }))

  console.log('vision plugin v' + VERSION + ' active — tool + auto-translation + /vision/api ready (host-composition row, loads at boot)')
}
