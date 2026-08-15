/**
 * dsh-vision-plugin — consistency check.
 *
 * The dynamic-plugin copies (plugin/*.js) were removed, so there is no build
 * step anymore. This script verifies:
 *   - lib/engine.js stays import-free (the bundle must not require anything
 *     at runtime — pnpm does not install the dependencies of `link:` profile
 *     plugins);
 *   - the version number is consistent across package.json, lib/engine.js
 *     and both READMEs, so a bump can never drift again.
 *
 * Usage:
 *   node scripts/check.js   # verify, exit 1 on any inconsistency
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const read = (p) => readFileSync(path.join(root, p), 'utf8')

const version = JSON.parse(read('package.json')).version
let dirty = false

// ── zero-import rule ─────────────────────────────────────────────────────────
const engine = read('lib/engine.js')
if (/^import\s/m.test(engine)) {
  console.log('[check] lib/engine.js must stay import-free (the bundle must not require anything at runtime)')
  dirty = true
}

// ── version consistency ──────────────────────────────────────────────────────
const engineVersion = engine.match(/export const VERSION = '([^']+)'/)
if (!engineVersion || engineVersion[1] !== version) {
  console.log(`[check] version mismatch: package.json says ${version}, lib/engine.js says ${engineVersion ? engineVersion[1] : 'missing'}`)
  dirty = true
}
for (const r of ['README.md', 'README.zh.md']) {
  const text = read(r)
  if (!text.includes(`v${version}`)) {
    console.log(`[check] version mismatch: ${r} does not mention v${version}`)
    dirty = true
  }
}

if (dirty) process.exitCode = 1
else console.log('[check] version + zero-import checks pass')
