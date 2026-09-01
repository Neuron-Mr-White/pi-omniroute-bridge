#!/usr/bin/env node
/**
 * dsh-omniroute-sync — the DeepSeek Harness twin of this bridge.
 *
 * Fetches the OmniRoute OpenAI-compatible model listing and merges it into
 * the running harness's user-settings document as the `llm-pi-ai` provider
 * route `omniroute`, so every chat-capable model OmniRoute advertises shows
 * up in the harness Model selector / Models page. The harness reads
 * `$DSH_HOME/settings.yaml` live (hot-reloaded), so no restart is needed.
 *
 * The API key is never written into settings: the profile references
 * `OMNI_API_KEY` and the script stores that key in the harness credential
 * store (`$DSH_HOME/.credentials.yaml`), which is exactly where the web
 * Models page writes credentials.
 *
 * Usage:
 *   node bin/dsh-omniroute-sync.mjs [--base-url <url>] [--api-key <key>]
 *       [--dsh-home <dir>] [--dry-run] [--no-credential]
 *
 * Defaults:
 *   --base-url  read from ~/.pi/agent/omniroute-bridge/config.json (the old
 *               Pi bridge config), falling back to http://localhost:20128
 *   --api-key   read from that config, falling back to $OMNI_API_KEY
 *   --dsh-home  $DSH_HOME, falling back to ~/.dsh
 *
 * Settings shape written (owned section only; every other top-level section
 * of the settings document is preserved verbatim):
 *
 *   llm-pi-ai:
 *     providers:
 *       omniroute:
 *         apiKeyEnv: OMNI_API_KEY
 *         displayName: OmniRoute
 *         api: openai-completions
 *         baseURL: https://router.oino.dev/v1
 *         models:
 *           - id: deepseek/deepseek-v4-pro
 *             name: deepseek/DeepSeek V4 Pro
 *             contextWindow: 1000000
 *             maxTokens: 384000
 *             input: [text, image]   # only when the endpoint says so
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}
const hasFlag = (name) => process.argv.includes(name)

const DRY_RUN = hasFlag('--dry-run')
const NO_CREDENTIAL = hasFlag('--no-credential')

// ── defaults from the old Pi bridge config ───────────────────────────────────

const bridgeConfigPath = join(homedir(), '.pi', 'agent', 'omniroute-bridge', 'config.json')
function readBridgeConfig() {
  try {
    return JSON.parse(readFileSync(bridgeConfigPath, 'utf8'))
  } catch {
    return {}
  }
}

const bridge = readBridgeConfig()
const baseUrl = arg('--base-url', bridge.baseUrl ?? 'http://localhost:20128')
const apiKey = arg('--api-key', bridge.apiKey ?? process.env.OMNI_API_KEY)
const dshHome = arg('--dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const settingsPath = join(dshHome, 'settings.yaml')
const credentialsPath = join(dshHome, '.credentials.yaml')
const providerKey = 'omniroute'
const providerDisplay = 'OmniRoute'

/** Model ids that are not chat/LLM capabilities; never synced into the picker. */
const NON_CHAT = /(embedding|rerank|moderation|whisper|tts|stt|speech|sdxl|dall-?e|flux|midjourney|suno|stable-diffusion|\bvideo\b|\baudio\b)/i

// ── model listing ────────────────────────────────────────────────────────────

async function fetchModels() {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`
  let response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
    })
  } catch (error) {
    throw new Error(`could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}${response.status === 401 || response.status === 403 ? ' — check the API key' : ''}`)
  }
  const body = await response.json()
  const data = body?.data
  if (!Array.isArray(data)) {
    throw new Error(`${url} answered without a "data" array — not an OpenAI-compatible listing`)
  }
  return data
}

function toNumber(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function toString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Normalize one listing entry into a pi-ai profile model entry. */
function normalizeModel(entry) {
  const id = toString(entry?.id)
  if (!id) return undefined
  if (NON_CHAT.test(id)) return undefined
  const name = toString(entry?.name) ?? id
  const contextWindow = toNumber(entry?.context_length ?? entry?.context_window)
  const maxTokens = toNumber(entry?.max_output_tokens ?? entry?.max_tokens)
  const input = Array.isArray(entry?.input_modalities)
    ? [...new Set(entry.input_modalities)].filter((m) => m === 'text' || m === 'image')
    : undefined
  const model = { id, name }
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  if (input !== undefined && input.length > 0 && input.includes('image')) model.input = ['text', ...input.filter((m) => m !== 'text')]
  return model
}

// ── YAML emission (owned section only) ───────────────────────────────────────

/** Quote a scalar only when plain YAML would misread it. */
function yamlScalar(value) {
  if (typeof value === 'number') return String(value)
  const str = String(value)
  if (/^[A-Za-z0-9][A-Za-z0-9_./()\[\]\- ]*$/.test(str) && !str.includes('  ')) return str
  // Double-quoted (JSON-style escaping is valid YAML double-quote syntax).
  return JSON.stringify(str)
}

/** The full `llm-pi-ai:` section, two-space indented, starting at column 0. */
function renderSection(models) {
  const lines = ['llm-pi-ai:', '  providers:', `    ${providerKey}:`]
  lines.push(`      apiKeyEnv: OMNI_API_KEY`)
  lines.push(`      displayName: ${yamlScalar(providerDisplay)}`)
  lines.push('      api: openai-completions')
  lines.push(`      baseURL: ${yamlScalar(baseUrl.replace(/\/+$/, '') + '/v1')}`)
  lines.push('      models:')
  for (const model of models) {
    lines.push(`        - id: ${yamlScalar(model.id)}`)
    lines.push(`          name: ${yamlScalar(model.name)}`)
    if (model.contextWindow !== undefined) lines.push(`          contextWindow: ${model.contextWindow}`)
    if (model.maxTokens !== undefined) lines.push(`          maxTokens: ${model.maxTokens}`)
    if (model.input !== undefined) {
      lines.push('          input:')
      for (const modality of model.input) lines.push(`            - ${modality}`)
    }
  }
  return lines.join('\n')
}

/**
 * Replace (or append) the top-level `llm-pi-ai:` block inside an existing
 * settings document. Only that one top-level section is touched; everything
 * else — other sections, comments, blank lines — stays byte-for-byte intact.
 */
function upsertSection(document, section) {
  const lines = document.split('\n')
  const start = lines.findIndex((line) => /^llm-pi-ai:\s*$/.test(line))
  if (start === -1) {
    const trimmed = document.replace(/\s+$/, '')
    return `${trimmed === '' ? '' : trimmed + '\n'}${section}\n`
  }
  // The block runs to the next top-level (column-0) key or the end of file.
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) {
      end = i
      break
    }
  }
  const before = lines.slice(0, start).join('\n')
  const after = lines.slice(end).join('\n')
  const joined = `${before === '' ? '' : before + '\n'}${section}${after === '' ? '' : '\n' + after}`
  return joined.endsWith('\n') ? joined : `${joined}\n`
}

/** Store the key in the harness credential store when absent (KEY: value lines). */
function upsertCredential(apiKeyValue) {
  if (NO_CREDENTIAL) return 'skipped (--no-credential)'
  let document = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : ''
  const linePattern = /^OMNI_API_KEY:\s*.*$/m
  const entry = `OMNI_API_KEY: ${apiKeyValue}`
  if (linePattern.test(document)) return 'already present'
  document = document.replace(/\s+$/, '')
  writeFileSync(credentialsPath, `${document === '' ? '' : document + '\n'}${entry}\n`)
  return 'written'
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!apiKey) {
    throw new Error('no API key: pass --api-key, set OMNI_API_KEY, or fix ~/.pi/agent/omniroute-bridge/config.json')
  }
  const entries = await fetchModels()
  const seen = new Set()
  const models = []
  for (const entry of entries) {
    const model = normalizeModel(entry)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  models.sort((a, b) => a.id.localeCompare(b.id))

  const section = renderSection(models)
  const existing = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
  const updated = upsertSection(existing, section)

  const credentialNote = NO_CREDENTIAL ? 'skipped (--no-credential)' : upsertCredential(apiKey)
  if (DRY_RUN) {
    console.log(`[dry-run] ${settingsPath} would gain ${models.length} models under llm-pi-ai.providers.${providerKey}`)
    console.log(`[dry-run] credential ${credentialsPath}: ${credentialNote}`)
    return
  }
  if (updated === existing) {
    console.log(`settings unchanged (${models.length} models already configured)`)
  } else {
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(settingsPath, updated)
    console.log(`wrote ${settingsPath} (${models.length} models under llm-pi-ai.providers.${providerKey})`)
  }
  console.log(`credential ${credentialsPath}: ${credentialNote}`)
  const skipped = entries.length - models.length
  if (skipped > 0) console.log(`skipped ${skipped} non-chat entries`)
  console.log(`provider route: ${providerKey} -> ${baseUrl}/v1 (openai-completions)`)
}

main().catch((error) => {
  console.error(`dsh-omniroute-sync: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
