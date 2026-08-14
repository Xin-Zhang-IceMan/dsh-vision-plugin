/**
 * dsh-vision-plugin — give text-only DSH models (e.g. deepseek-v4) vision.
 *
 * This file is the HOST half of a dynamic Cordis plugin for DeepSeek Harness
 * (DSH). It is written as a plain-JavaScript function body: paste its content
 * verbatim as `code.host` when defining the plugin with `cordis_define`, then
 * activate it with `cordis_run`. No build step, no imports, no TypeScript.
 *
 * What it provides:
 *  1. A model-visible tool `vision_analyze(path, question?, model?, provider?)`
 *     that reads a local image and answers via an image-capable model on the
 *     deployment's own LLM route (no extra credentials needed).
 *  2. An `llm/stream` waterfall listener that automatically translates image
 *     blocks (pasted/attached images) into text descriptions whenever the
 *     target model cannot natively accept images — so a text-only model like
 *     deepseek-v4-flash can still "see" pasted images.
 *
 * Deployment prerequisites:
 *  - The deployment's LLM route must expose at least one image-capable model
 *    (see MODEL_PRIORITY / NATIVE_VISION_MODELS below; the default deployment
 *    route "opencode-go" ships several).
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
 *  - The waterfall listener lives on the root context, so it serves every
 *    session/agent in the process. Requests already handled by this plugin
 *    carry a Symbol marker and are never re-translated (no recursion).
 *  - Translation results are cached per (attachmentId + question) so repeated
 *    turns reuse one vision call.
 *  - Robustness: a stream that produced text but ended with an error finish
 *    keeps its content; a total failure is retried once with a fallback
 *    vision model; if everything fails the turn degrades to a placeholder
 *    block instead of failing the whole conversation.
 */

return {
  inject: ['fs', 'llm', 'attachments'],
  apply(ctx) {
    const DEFAULT_PROVIDER = 'opencode-go'
    const DEFAULT_MODEL = 'qwen3.7-plus'
    // Models that natively accept image input on the deployment route. The
    // deployment advertises deepseek-v4-flash as image-capable too (so the chat
    // admits pasted images), but it is NOT in this set — its images must be
    // translated to text before dispatch.
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

    async function pickModel(provider, requested) {
      if (requested) return requested
      try {
        const models = await ctx.llm.listModels(provider)
        const vision = models.filter((m) =>
          Array.isArray(m.inputModalities) && m.inputModalities.includes('image'))
        for (const id of MODEL_PRIORITY) {
          const found = vision.find((m) => m.id === id)
          if (found) return found.id
        }
        if (vision.length > 0) return vision[0].id
      } catch (err) {
        console.log('vision: model discovery failed, using default:', String(err && err.message || err))
      }
      return DEFAULT_MODEL
    }

    // One vision-model call over the deployment's own llm route. The request
    // carries the TRANSLATED marker so the waterfall listener passes it through.
    // Tolerates a stream that produced text but ended with an error finish
    // (the content is already usable); only a total failure throws, and it is
    // retried once with a fallback model from the priority list.
    async function runVisionCall(imageBlocks, question, requestedModel) {
      let model = requestedModel || await pickModel(DEFAULT_PROVIDER, null)
      let lastError = null
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await streamOnce(model, imageBlocks, question)
        if (result.ok) return { description: result.description, model, truncated: result.truncated }
        lastError = result.error
        console.log('vision: attempt', attempt + 1, 'failed for', model + ':', lastError)
        if (attempt === 0) {
          const fallback = MODEL_PRIORITY.find((id) => id !== model) || DEFAULT_MODEL
          if (fallback !== model) model = fallback
        }
      }
      throw new Error(lastError || 'vision model unavailable')
    }

    async function streamOnce(model, imageBlocks, question) {
      let text = ''
      let reasoning = ''
      let truncated = false
      let finishKind = 'stop'
      let failure = null
      try {
        const chunks = ctx.llm.stream({
          provider: DEFAULT_PROVIDER,
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
    async function translateMessages(messages) {
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
            const result = await runVisionCall(imageBlocks, question, null)
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
      if (options.provider === DEFAULT_PROVIDER && NATIVE_VISION_MODELS.has(options.model)) {
        return yield* next()
      }
      let messages
      try {
        messages = await translateMessages(options.messages)
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

    const tool = harness.defineTool({
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
            description: 'Optional LLM provider route override. Defaults to the deployment route "opencode-go".',
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
        const provider = args.provider || DEFAULT_PROVIDER
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
        const result = await runVisionCall([{ type: 'image', attachment: ref }], question, args.model)
        return { description: result.description, model: result.model, provider, imagePath: args.path, truncated: result.truncated }
      },
    })

    ctx.effect(() => harness.registerTool(ctx, tool))
    console.log('vision plugin active — vision_analyze registered; auto-translation enabled with retry + degrade; default provider:', DEFAULT_PROVIDER, 'default model:', DEFAULT_MODEL)
  },
}
