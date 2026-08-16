/**
 * dsh-vision-plugin — engine test suite.
 *
 * Run with `npm test` (node --test test/). The engine (lib/engine.js) is the
 * single source of truth for the plugin, so these tests lock its behavior:
 * route discovery, override precedence, caching/dedup, timeouts, the
 * waterfall listener and the tool. The last test also guards version
 * consistency with package.json.
 */
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  VERSION,
  TRANSLATED,
  resetState,
  setConfiguredRoute,
  getConfiguredRoute,
  resolveVisionRoute,
  findProviderForModel,
  runVisionCall,
  streamOnce,
  translateMessages,
  makeWaterfallListener,
  catalogState,
  makeTool,
} from '../lib/engine.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

beforeEach(() => resetState())

function model(id, image = true) {
  return { id, inputModalities: image ? ['text', 'image'] : ['text'] }
}

function makeCtx({ catalogs = {}, streamImpl } = {}) {
  const calls = { stream: 0, listModels: 0, streams: [] }
  return {
    calls,
    llm: {
      listProviders: () => Object.keys(catalogs).map((id) => ({ id })),
      listModels: async (provider) => {
        calls.listModels += 1
        return catalogs[provider] || []
      },
      stream: (opts) => {
        calls.stream += 1
        calls.streams.push(opts)
        if (streamImpl) return streamImpl(opts)
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
}

const imgBlock = (id) => ({ type: 'image', attachment: { attachmentId: id } })
const textStream = (text) => async function* () {
  yield { type: 'text-delta', text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

// ── route discovery ───────────────────────────────────────────────────────────

test('resolveVisionRoute: provider-first, whitelist within a provider, priority order', async () => {
  const ctx = makeCtx({ catalogs: {
    p1: [model('other-vision'), model('deepseek-v4-flash', false)],
    p2: [model('qwen3.7-plus')],
  } })
  // p1's vision model is not on the native whitelist (override-advertised), so
  // it is skipped and p2's whitelisted model wins even without a preference
  assert.deepEqual(await resolveVisionRoute(ctx, null), { provider: 'p2', model: 'qwen3.7-plus' })
  // preferring p1 — which only has untrusted vision models — still lands on p2
  assert.deepEqual(await resolveVisionRoute(ctx, 'p1'), { provider: 'p2', model: 'qwen3.7-plus' })
  // preferring p2 flips to its whitelist model directly
  assert.deepEqual(await resolveVisionRoute(ctx, 'p2'), { provider: 'p2', model: 'qwen3.7-plus' })
})

test('resolveVisionRoute: override-advertised text-only models are never selected', async () => {
  // A deployment may advertise every text-only model as image-capable via
  // modelOverrides (so the chat admits pasted images). Such models reject
  // image blocks upstream ("unknown variant `image_url`, expected `text`"),
  // so discovery must not pick them: no whitelist model -> no route at all.
  const ctx = makeCtx({ catalogs: {
    p1: [model('deepseek-v4-flash'), model('glm-5.1'), model('hy3')],
  } })
  assert.deepEqual(await resolveVisionRoute(ctx, null), { provider: null, model: null })
  // the preferred provider name is still reported even when it has no route
  assert.deepEqual(await resolveVisionRoute(ctx, 'p1'), { provider: 'p1', model: null })
})

test('resolveVisionRoute: no vision model anywhere -> null route', async () => {
  const ctx = makeCtx({ catalogs: { p1: [model('a', false)] } })
  assert.deepEqual(await resolveVisionRoute(ctx, null), { provider: null, model: null })
})

test('findProviderForModel: exact id, prefers the requested provider', async () => {
  const ctx = makeCtx({ catalogs: {
    p1: [model('qwen3.7-plus')],
    p2: [model('qwen3.7-plus'), model('kimi-k3')],
  } })
  assert.equal(await findProviderForModel(ctx, 'kimi-k3', null), 'p2')
  assert.equal(await findProviderForModel(ctx, 'qwen3.7-plus', null), 'p1')
  assert.equal(await findProviderForModel(ctx, 'qwen3.7-plus', 'p2'), 'p2')
  assert.equal(await findProviderForModel(ctx, 'nope', null), null)
})

test('findProviderForModel: accepts any catalog image-capable model, rejects text-only', async () => {
  const ctx = makeCtx({ catalogs: {
    p1: [model('deepseek-v4-flash'), model('qwen3.7-plus')],
  } })
  assert.equal(await findProviderForModel(ctx, 'qwen3.7-plus', null), 'p1')
  // deepseek-v4-flash claims image capability in the catalog (modelOverrides)
  // but is not on the native whitelist: explicit user choices (settings page,
  // tool override) may still select it — the whitelist gates auto-selection only
  assert.equal(await findProviderForModel(ctx, 'deepseek-v4-flash', null), 'p1')
  // a genuinely text-only model is still refused
  const textOnly = makeCtx({ catalogs: { p1: [model('glm-5.1', false)] } })
  assert.equal(await findProviderForModel(textOnly, 'glm-5.1', null), null)
})

// ── runVisionCall: precedence + retry ─────────────────────────────────────────

test('runVisionCall: explicit model parameter overrides the configured route', async () => {
  const ctx = makeCtx({
    catalogs: { p1: [model('qwen3.7-plus'), model('kimi-k3')] },
    streamImpl: textStream('described'),
  })
  setConfiguredRoute({ provider: 'p1', model: 'qwen3.7-plus' })
  const result = await runVisionCall(ctx, [imgBlock('a')], 'what?', 'kimi-k3', null)
  assert.equal(result.model, 'kimi-k3')
  assert.equal(result.description, 'described')
})

test('runVisionCall: configured route used when no explicit model', async () => {
  const ctx = makeCtx({
    catalogs: { p1: [model('qwen3.7-plus'), model('kimi-k3')] },
    streamImpl: textStream('described'),
  })
  setConfiguredRoute({ provider: 'p1', model: 'qwen3.7-plus' })
  const result = await runVisionCall(ctx, [imgBlock('a')], 'what?', null, null)
  assert.equal(result.model, 'qwen3.7-plus')
})

test('runVisionCall: auto-selection when nothing configured', async () => {
  const ctx = makeCtx({
    catalogs: { p1: [model('kimi-k3'), model('qwen3.7-plus')] },
    streamImpl: textStream('described'),
  })
  const result = await runVisionCall(ctx, [imgBlock('a')], 'what?', null, null)
  assert.equal(result.model, 'qwen3.7-plus') // MODEL_PRIORITY order within the provider
  assert.equal(getConfiguredRoute(), null)
})

test('runVisionCall: explicit model not found anywhere -> throws', async () => {
  const ctx = makeCtx({ catalogs: { p1: [model('qwen3.7-plus')] } })
  await assert.rejects(
    () => runVisionCall(ctx, [imgBlock('a')], 'what?', 'ghost-model', null),
    /not an image-capable model/)
})

test('runVisionCall: configured route naming a catalog image-capable model is honored', async () => {
  // The settings page may pick any catalog image-capable model: here
  // deepseek-v4-flash is advertised image-capable via modelOverrides but is
  // not on the native whitelist — the explicit user choice is honored.
  const ctx = makeCtx({
    catalogs: { p1: [model('deepseek-v4-flash'), model('qwen3.7-plus')] },
    streamImpl: textStream('described'),
  })
  setConfiguredRoute({ provider: 'p1', model: 'deepseek-v4-flash' })
  const result = await runVisionCall(ctx, [imgBlock('a')], 'what?', null, null)
  assert.equal(result.model, 'deepseek-v4-flash')
  assert.equal(result.description, 'described')
})

test('runVisionCall: configured route naming a text-only model falls back to auto', async () => {
  // A route saved before catalog gating (or hand-set) may name a model the
  // catalog reports as text-only; such a model would reject the image
  // upstream, so the stale route is ignored and auto-selection runs.
  const ctx = makeCtx({
    catalogs: { p1: [model('glm-5.1', false), model('qwen3.7-plus')] },
    streamImpl: textStream('described'),
  })
  setConfiguredRoute({ provider: 'p1', model: 'glm-5.1' })
  const result = await runVisionCall(ctx, [imgBlock('a')], 'what?', null, null)
  assert.equal(result.model, 'qwen3.7-plus')
  assert.equal(result.description, 'described')
})

test('runVisionCall: no vision route at all -> throws', async () => {
  const ctx = makeCtx({ catalogs: { p1: [model('a', false)] } })
  await assert.rejects(
    () => runVisionCall(ctx, [imgBlock('a')], 'what?', null, null),
    /no vision-capable model/)
})

test('runVisionCall: total failure is retried once on a fallback route', async () => {
  let calls = 0
  const ctx = makeCtx({
    catalogs: { p1: [model('kimi-k3'), model('qwen3.7-plus')] },
    streamImpl: async function* () {
      calls += 1
      if (calls === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }
      } else {
        yield { type: 'text-delta', text: 'recovered' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  })
  const result = await runVisionCall(ctx, [imgBlock('a')], 'what?', null, null)
  assert.equal(calls, 2)
  assert.equal(result.model, 'qwen3.7-plus') // fell back to the next candidate
  assert.equal(result.description, 'recovered')
})

// ── streamOnce: chunk handling, timeouts, abort ──────────────────────────────

test('streamOnce: text deltas then stop -> description', async () => {
  const ctx = makeCtx({
    streamImpl: async function* () {
      yield { type: 'text-delta', text: 'hello ' }
      yield { type: 'text-delta', text: 'world' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const result = await streamOnce(ctx, 'p1', 'm1', [imgBlock('a')], 'q?')
  assert.deepEqual(result, { ok: true, description: 'hello world', truncated: false })
})

test('streamOnce: error finish with no text -> failure with upstream detail', async () => {
  const ctx = makeCtx({
    streamImpl: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E1', status: 429 } } }
    },
  })
  const result = await streamOnce(ctx, 'p1', 'm1', [imgBlock('a')], 'q?')
  assert.equal(result.ok, false)
  assert.match(result.error, /boom/)
  assert.match(result.error, /429/)
})

test('streamOnce: error finish after text was produced -> keeps the content', async () => {
  const ctx = makeCtx({
    streamImpl: async function* () {
      yield { type: 'text-delta', text: 'partial answer' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'late failure' } } }
    },
  })
  const result = await streamOnce(ctx, 'p1', 'm1', [imgBlock('a')], 'q?')
  assert.equal(result.ok, true)
  assert.equal(result.description, 'partial answer')
})

test('streamOnce: max-tokens finish -> truncated flag', async () => {
  const ctx = makeCtx({
    streamImpl: async function* () {
      yield { type: 'text-delta', text: 'x' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  })
  const result = await streamOnce(ctx, 'p1', 'm1', [imgBlock('a')], 'q?')
  assert.equal(result.ok, true)
  assert.equal(result.truncated, true)
})

test('streamOnce: hanging stream times out', async () => {
  const ctx = makeCtx({
    streamImpl: async function* () {
      for (;;) {
        await new Promise((r) => setTimeout(r, 50))
        yield { type: 'text-delta', text: 'x' }
      }
    },
  })
  const result = await streamOnce(ctx, 'p1', 'm1', [imgBlock('a')], 'q?', { timeoutMs: 30 })
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out/)
})

test('streamOnce: aborted signal cancels the call', async () => {
  const ctx = makeCtx({
    streamImpl: async function* () {
      for (;;) {
        await new Promise((r) => setTimeout(r, 50))
        yield { type: 'text-delta', text: 'x' }
      }
    },
  })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  const result = await streamOnce(ctx, 'p1', 'm1', [imgBlock('a')], 'q?', { timeoutMs: 0, signal: controller.signal })
  assert.equal(result.ok, false)
  assert.match(result.error, /cancelled/)
})

// ── translateMessages: preservation, cache, dedup, degradation ───────────────

test('translateMessages: replaces images, preserves other block types, caches', async () => {
  let streams = 0
  const ctx = makeCtx({
    catalogs: { p1: [model('qwen3.7-plus')] },
    streamImpl: async function* () {
      streams += 1
      yield { type: 'text-delta', text: 'a cat' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is this?' },
      imgBlock('att-1'),
      { type: 'file', name: 'data.csv' },
    ],
  }]
  const out1 = await translateMessages(ctx, messages, 'p1')
  const content1 = out1[0].content
  assert.equal(content1.filter((b) => b.type === 'image').length, 0)
  assert.ok(content1.some((b) => b.type === 'file'), 'non-image blocks must be preserved')
  const desc1 = content1.find((b) => b.type === 'text' && /转写|transcribed/.test(b.text))
  assert.ok(desc1)
  assert.match(desc1.text, /a cat/)
  assert.equal(streams, 1)
  // same image + question reuses the cache
  const out2 = await translateMessages(ctx, messages, 'p1')
  assert.equal(streams, 1)
  const desc2 = out2[0].content.find((b) => b.type === 'text' && /转写|transcribed/.test(b.text))
  assert.equal(desc2.text, desc1.text)
})

test('translateMessages: concurrent identical requests share one vision call', async () => {
  let streams = 0
  const ctx = makeCtx({
    catalogs: { p1: [model('qwen3.7-plus')] },
    streamImpl: async function* () {
      streams += 1
      await new Promise((r) => setTimeout(r, 30))
      yield { type: 'text-delta', text: 'slow but one call' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'q' }, imgBlock('att-1')] }]
  const [a, b] = await Promise.all([
    translateMessages(ctx, messages, 'p1'),
    translateMessages(ctx, messages, 'p1'),
  ])
  assert.equal(streams, 1)
  assert.equal(a[0].content.length, 2)
  assert.equal(b[0].content.length, 2)
})

test('translateMessages: vision failure degrades to a placeholder, does not throw', async () => {
  const ctx = makeCtx({
    catalogs: { p1: [model('qwen3.7-plus')] },
    streamImpl: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'down' } } }
    },
  })
  const messages = [{ role: 'user', content: [imgBlock('att-1')] }]
  const out = await translateMessages(ctx, messages, 'p1')
  const content = out[0].content
  assert.equal(content.filter((b) => b.type === 'image').length, 0)
  const desc = content.find((b) => b.type === 'text' && /转写失败|transcription failed/.test(b.text))
  assert.ok(desc)
})

test('translateMessages: nested tool-result images transcribed, assistant images replaced', async () => {
  let streams = 0
  const ctx = makeCtx({
    catalogs: { p1: [model('qwen3.7-plus')] },
    streamImpl: async function* () {
      streams += 1
      yield { type: 'text-delta', text: 'a screenshot of a dashboard' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const messages = [
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', name: 'screenshot', content: [imgBlock('att-nested')] }],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'here you go:' }, imgBlock('att-emitted')],
    },
  ]
  const out = await translateMessages(ctx, messages, 'p1')
  // the nested tool-result image was transcribed in place
  const toolResult = out[0].content[0]
  assert.equal(toolResult.type, 'tool-result')
  assert.equal(toolResult.toolCallId, 'c1')
  assert.equal(toolResult.content.filter((b) => b.type === 'image').length, 0)
  assert.ok(toolResult.content.some((b) => b.type === 'text' && b.text.includes('dashboard')))
  // the assistant-emitted image became a note; no image block survives anywhere
  assert.equal(out[1].content.filter((b) => b.type === 'image').length, 0)
  assert.ok(out[1].content.some((b) => b.type === 'text' && /omitted|省略/.test(b.text)))
  assert.equal(streams, 1) // one shared transcription call for the user message
})

// ── the llm/stream waterfall ─────────────────────────────────────────────────

test('waterfall: native vision model passes through untouched', async () => {
  let nextCalled = false
  const ctx = makeCtx({})
  const listener = makeWaterfallListener(ctx)
  const options = { model: 'qwen3.7-plus', messages: [{ role: 'user', content: [imgBlock('a')] }] }
  const chunks = []
  for await (const c of listener(options, async function* () {
    nextCalled = true
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) {
    chunks.push(c)
  }
  assert.equal(nextCalled, true)
  assert.equal(ctx.calls.stream, 0)
})

test('waterfall: already-translated requests pass through (no recursion)', async () => {
  let nextCalled = false
  const ctx = makeCtx({})
  const listener = makeWaterfallListener(ctx)
  const options = {
    [TRANSLATED]: true,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: [imgBlock('a')] }],
  }
  for await (const _c of listener(options, async function* () {
    nextCalled = true
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) { /* drain */ }
  assert.equal(nextCalled, true)
})

test('waterfall: text-only model gets a translated re-dispatch with the marker', async () => {
  const ctx = makeCtx({
    catalogs: { p1: [model('qwen3.7-plus')] },
    streamImpl: textStream('the cat is black'),
  })
  const listener = makeWaterfallListener(ctx)
  const options = {
    provider: 'p1',
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: [imgBlock('a')] }],
  }
  const chunks = []
  for await (const c of listener(options, async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) {
    chunks.push(c)
  }
  assert.equal(ctx.calls.stream, 2) // 1 translation call + 1 re-dispatch
  const redispatch = ctx.calls.streams[1]
  assert.equal(redispatch[TRANSLATED], true)
  assert.equal(redispatch.model, 'deepseek-v4-flash')
  const content = redispatch.messages[0].content
  assert.equal(content.filter((b) => b.type === 'image').length, 0)
  assert.ok(content.some((b) => b.type === 'text' && b.text.includes('the cat is black')))
  assert.ok(chunks.some((c) => c.type === 'text-delta'))
})

test('waterfall: images nested in tool-result blocks still trigger translation', async () => {
  const ctx = makeCtx({
    catalogs: { p1: [model('qwen3.7-plus')] },
    streamImpl: textStream('chart described'),
  })
  const listener = makeWaterfallListener(ctx)
  const options = {
    provider: 'p1',
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', name: 'screenshot', content: [imgBlock('n1')] }],
    }],
  }
  const chunks = []
  for await (const c of listener(options, async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) {
    chunks.push(c)
  }
  assert.equal(ctx.calls.stream, 2) // translation + re-dispatch
  const redispatch = ctx.calls.streams[1]
  const toolContent = redispatch.messages[0].content[0].content
  assert.equal(toolContent.filter((b) => b.type === 'image').length, 0)
  assert.ok(toolContent.some((b) => b.type === 'text' && b.text.includes('chart described')))
  assert.ok(chunks.some((c) => c.type === 'text-delta'))
})

// ── catalogState ─────────────────────────────────────────────────────────────

test('catalogState: shape, image flags, and catalog caching', async () => {
  const ctx = makeCtx({ catalogs: {
    p1: [model('qwen3.7-plus'), model('deepseek-v4-flash', false)],
    p2: [model('kimi-k3')],
  } })
  const s1 = await catalogState(ctx)
  assert.equal(s1.version, VERSION)
  assert.equal(s1.configuredRoute, null)
  assert.equal(s1.defaultModel, 'qwen3.7-plus')
  assert.equal(s1.models.length, 3)
  const qwen = s1.models.find((m) => m.id === 'qwen3.7-plus')
  assert.equal(qwen.image, true)
  assert.equal(qwen.native, true)
  assert.equal(qwen.provider, 'p1')
  const flash = s1.models.find((m) => m.id === 'deepseek-v4-flash')
  assert.equal(flash.image, false)
  assert.equal(flash.native, false)
  assert.equal(ctx.calls.listModels, 2)
  // second call within the TTL hits the catalog cache
  await catalogState(ctx)
  assert.equal(ctx.calls.listModels, 2)
})

// ── the tool ─────────────────────────────────────────────────────────────────

function toolCtx(overrides = {}) {
  const base = {
    fs: {
      resolve: async (p) => p,
      stat: async () => ({}),
      readBytes: async () => Buffer.from('fake-png-bytes'),
    },
    attachments: {
      imageLimits: {},
      saveImage: async (ref) => ref,
    },
    llm: makeCtx({ catalogs: { p1: [model('qwen3.7-plus')] }, streamImpl: textStream('a logo') }).llm,
  }
  return { ...base, ...overrides }
}

test('makeTool: execute reads the file, saves the image, returns the description', async () => {
  const saved = []
  const ctx = toolCtx({
    attachments: {
      imageLimits: {},
      saveImage: async (ref) => { saved.push(ref); return { attachmentId: 'saved-1' } },
    },
  })
  const tool = makeTool(ctx)
  const result = await tool.execute({ path: '/tmp/logo.png', question: 'What?' }, { signal: new AbortController().signal })
  assert.equal(result.imagePath, '/tmp/logo.png')
  assert.equal(result.description, 'a logo')
  assert.equal(result.model, 'qwen3.7-plus')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.ok(result.truncated === false)
})

test('makeTool: unsupported extension is rejected', async () => {
  const tool = makeTool(toolCtx())
  await assert.rejects(() => tool.execute({ path: 'notes.txt' }, { signal: null }), /unsupported image type/)
})

test('makeTool: explicit override naming a non-whitelist image-capable model is honored', async () => {
  // deepseek-v4-flash claims image capability in the catalog (modelOverrides)
  // and is not on the native whitelist — an explicit tool override may still
  // use it (the whitelist gates auto-selection only)
  const ctx = toolCtx({
    llm: makeCtx({ catalogs: { p1: [model('deepseek-v4-flash')] }, streamImpl: textStream('a logo') }).llm,
  })
  const tool = makeTool(ctx)
  const result = await tool.execute({ path: '/tmp/logo.png', model: 'deepseek-v4-flash' }, { signal: new AbortController().signal })
  assert.equal(result.model, 'deepseek-v4-flash')
  assert.equal(result.description, 'a logo')
})

test('makeTool: explicit override naming a text-only model is rejected', async () => {
  // a catalog text-only model must never receive image blocks, explicit or not
  const ctx = toolCtx({
    llm: makeCtx({ catalogs: { p1: [model('glm-5.1', false)] }, streamImpl: textStream('x') }).llm,
  })
  const tool = makeTool(ctx)
  await assert.rejects(
    () => tool.execute({ path: '/tmp/logo.png', model: 'glm-5.1' }, { signal: null }),
    /not an image-capable model/)
})

test('makeTool: missing file is rejected', async () => {
  const tool = makeTool(toolCtx({ fs: { resolve: async (p) => p, stat: async () => undefined } }))
  await assert.rejects(() => tool.execute({ path: 'ghost.png' }, { signal: null }), /file not found/)
})

// ── version consistency ──────────────────────────────────────────────────────

test('package.json version matches the engine VERSION', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.version, VERSION)
})
