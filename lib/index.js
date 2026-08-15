/**
 * dsh-vision-plugin — bundle HOST half (composition plugin row `vision`).
 *
 * Thin adapter around the shared engine in lib/engine.js — the single source
 * of truth. This module is imported by the dsh Loader at boot (row `vision`
 * in cordis.patch.yml, package `dsh-vision-plugin` in the profile's
 * `dsh.profile.bundles`), so the plugin is permanently active on every dsh
 * start — no cordis_define/cordis_run needed and it survives restarts. The
 * browser half is lib/client.js.
 *
 * This adapter contributes the bundle-specific surface only:
 *  - tool registration via ctx.tools.register (engine's makeTool);
 *  - the settings JSON API on ctx.webServer: GET /vision/api/state and
 *    POST /vision/api/model (engine's catalogState / setConfiguredRoute);
 *  - the llm/stream waterfall listener (engine's makeWaterfallListener).
 *
 * Zero non-builtin imports on purpose — the single relative import of
 * ./engine.js resolves from this package's real path, never from the
 * profile's shared node_modules fallback (pnpm does not install the
 * dependencies of `link:` profile plugins).
 */

import {
  VERSION,
  makeTool,
  makeWaterfallListener,
  catalogState,
  setConfiguredRoute,
  findProviderForModel,
} from './engine.js'

export const name = 'vision'

/** Services this row needs: the injected `llm`/`fs`/`attachments` services,
 * the tool registry, and the web server (settings JSON API). */
export const inject = ['fs', 'llm', 'attachments', 'tools', 'webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(makeTool(ctx)))

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
        sendJson(res, 200, await catalogState(ctx))
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
          setConfiguredRoute(null)
          console.log('vision: default vision route set to auto')
        } else {
          const preferred = args && args.provider ? String(args.provider) : null
          const provider = await findProviderForModel(ctx, model, preferred)
          if (provider === null) {
            throw new Error(`vision: "${model}" is not an image-capable model on any configured provider`)
          }
          setConfiguredRoute({ provider, model })
          console.log('vision: default vision route set to', provider + '/' + model)
        }
        sendJson(res, 200, await catalogState(ctx))
      } catch (err) {
        console.log('vision: /vision/api/model failed:', String(err && err.message || err))
        sendJson(res, 400, { error: String(err && err.message || err) })
      }
    },
  }))

  ctx.on('llm/stream', makeWaterfallListener(ctx))

  console.log('vision plugin v' + VERSION + ' active — tool + auto-translation + /vision/api ready (host-composition row, loads at boot)')
}
