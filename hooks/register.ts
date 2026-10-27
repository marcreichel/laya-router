import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Effort, Route } from '../types'
import { MIN_CONFIDENCE, TIERS, routeQuestion } from './tiers'

const isRouted = atom({ plugin: 'laya-router', key: 'isRouted' } as const, false)
const pending = atom({ plugin: 'laya-router', key: 'pending' } as const, null)
const route = atom({ plugin: 'laya-router', key: 'route' } as const, null)
const strikes = atom({ plugin: 'laya-router', key: 'strikes' } as const, 0)
const lastCall = atom({ plugin: 'laya-router', key: 'lastCall' } as const, null)
const nudge = atom({ plugin: 'laya-router', key: 'nudge' } as const, null)
const startModel = atom({ plugin: 'laya-router', key: 'startModel' } as const, null)

const LAYA_HEALTH_TIMEOUT_MS = 2000
const SKILL_TEXT_CAP = 2000
// Failed or repeated tool calls in a row before suggesting a bigger model.
const STRIKES_TO_NUDGE = 3
const LOG_CAP = 1000

type Ctx =
  | Parameters<Hook<'prompt.submit'>>[0]
  | Parameters<Hook<'turn.step'>>[0]
  | Parameters<Hook<'session.start'>>[0]
  | Parameters<Hook<'tool.call'>>[0]
  | Parameters<Hook<'session.end'>>[0]
  | Parameters<Hook<'command.run'>>[0]
type Config = { url: string; tiers: Record<string, (typeof TIERS)[string]>; minConfidence: number; headers: Record<string, string>; healthUrl: string; health?: Promise<boolean>; carriedModel?: string }
type Answer = { choice?: unknown; confidence?: unknown; answer_confidence?: unknown }

// $.http.fetch takes no timeout or signal, so race /health against a short sleep: a cheap endpoint that's slow is down.
// A request that loses keeps running in the background until the host gives up.
async function checkHealth($: Ctx, url: string, headers: Record<string, string>) {
  try {
    const timer = new AbortController()
    const timeout = $.clock.sleep(LAYA_HEALTH_TIMEOUT_MS, { signal: timer.signal }).then(() => {
      throw new Error('timeout')
    })
    const response = await Promise.race([$.http.fetch(url, { headers }), timeout]).finally(() => timer.abort())
    return response.ok
  } catch {
    return false
  }
}

// Checked once at startup so the first prompt doesn't wait for it. Down (or never checked) is checked again before
// classifying, so a laya-serve started after Claude Code still routes.
async function isUp($: Ctx, cfg: Config) {
  if (!(await cfg.health)) {
    cfg.health = checkHealth($, cfg.healthUrl, cfg.headers)
  }
  return cfg.health
}

// Calibration data: what was routed, and what happened after. Read it back with /laya-log.
// ponytail: read-modify-write of one array, so two entries written at the same instant can lose one.
async function log($: Ctx, event: string, data: Record<string, unknown>) {
  try {
    const entries = ((await $.store.get('log')) as unknown[] | undefined) ?? []
    const entry = { at: new Date(await $.clock.now()).toISOString(), session: await $.session.id(), event, ...data }
    await $.store.set('log', [...entries, entry].slice(-LOG_CAP))
  } catch {}
}

// Throws when laya-serve is down or fails; `tier` is undefined for a choice no enabled tier has.
async function ask($: Ctx, text: string, cfg: Config) {
  if (!(await isUp($, cfg))) {
    throw new Error('down')
  }
  // Laya answered /health, so wait for the answer however long it takes (up to the host's 30 s): CPU inference and
  // a first request that loads the weights are slow, not broken.
  const response = await $.http.fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cfg.headers },
    body: JSON.stringify({
      state: text,
      model: 'jev-latest',
      questions: { route: routeQuestion(cfg.tiers) },
    }),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const answer: Answer = JSON.parse(response.text)?.answers?.route ?? {}
  const [name, tier] = Object.entries(cfg.tiers).find(([, t]) => t.label === answer.choice) ?? []
  return { name, tier, confidence: Number(answer.answer_confidence ?? answer.confidence ?? 0) }
}

async function classify($: Ctx, text: string, cfg: Config) {
  await update($, isRouted, () => true)
  // A /model before the first prompt is a choice too: don't route over it.
  const start = (await read($, startModel)) ?? cfg.carriedModel ?? null
  if (start !== null && (await $.session.model()) !== start) {
    $.ui.status('laya: /model changed, routing off')
    await log($, 'route', { tier: null, manual: true })
    return
  }

  try {
    const { name, tier, confidence } = await ask($, text, cfg)

    if (name === undefined || tier === undefined || confidence < cfg.minConfidence) {
      $.ui.status(`laya: unsure (${confidence.toFixed(2)}), using /model`)
      await log($, 'route', { tier: null, confidence })
    } else {
      const chosen: Route = { tier: name, model: tier.model, effort: tier.effort, confidence, sessionModel: await $.session.model() }
      await update($, route, () => chosen)
      $.ui.status(`laya → ${chosen.tier} ${confidence.toFixed(2)}`)
      await log($, 'route', { tier: name, confidence })
    }
  } catch {
    $.ui.status('laya: offline, using /model')
    await log($, 'route', { tier: null, offline: true })
  }
}

// Switching mid-session re-reads the whole conversation uncached, so the person decides: suggest once, never switch.
async function suggest($: Ctx, tier: string, reason: string) {
  if ((await read($, route)) === null || (await read($, nudge)) !== null) {
    return
  }
  await update($, nudge, () => tier)
  $.ui.status(`laya: ${reason}, consider /model ${tier}`)
  await log($, 'nudge', { tier, reason })
}

function tierAbove(cfg: Config, tier: string) {
  const order = Object.keys(cfg.tiers)
  return order[order.indexOf(tier) + 1]
}

// A later prompt Laya reads as a harder tier than the session was routed to (debugging, architecture, …).
async function checkDrift($: Ctx, text: string, cfg: Config) {
  const chosen = await read($, route)
  if (chosen === null || (await read($, nudge)) !== null) {
    return
  }
  try {
    const { name, confidence } = await ask($, text, cfg)
    const order = Object.keys(cfg.tiers)
    if (name !== undefined && confidence >= cfg.minConfidence && order.indexOf(name) > order.indexOf(chosen.tier)) {
      await suggest($, name, 'this got harder')
    }
  } catch {}
}

export const register: Register = (on, options) => {
  const base = String(options.layaUrl ?? 'http://localhost:8000').replace(/\/+$/, '')
  const apiKey = String(options.layaApiKey ?? '')
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {}
  // Fable isn't in every subscription, so it's opt-in; without it Laya picks from the other three.
  const enableFable = String(options.enableFable ?? false) === 'true'
  // Claude Code validates each <tier>Effort against its options before load, falling back to the default.
  const tiers = Object.fromEntries(
    Object.entries(TIERS)
      .filter(([tier]) => tier !== 'fable' || enableFable)
      .map(([tier, t]) => [tier, { ...t, effort: (options[`${tier}Effort`] as Effort | undefined) ?? t.effort }]),
  )
  const minConfidence = enableFable ? MIN_CONFIDENCE.withFable : MIN_CONFIDENCE.withoutFable

  const cfg: Config = { url: `${base}/v1/systemone`, healthUrl: `${base}/health`, headers, tiers, minConfidence }

  on('session.start', async ($, e, next) => {
    // Not awaited: the first session.start holds up startup.
    cfg.health = checkHealth($, cfg.healthUrl, headers)
    // Kept across reloads, so a /model picked before one still counts as picked.
    const model = await $.session.model()
    await update($, startModel, m => m ?? model)
    await $.command.register({ name: 'laya-log', description: 'Show what laya-router routed and what happened after, as JSON lines' })
    return next(e)
  })

  on('command.run', { command: 'laya-log' }, async $ => {
    const entries = ((await $.store.get('log')) as unknown[] | undefined) ?? []
    return { text: entries.length ? entries.map(entry => JSON.stringify(entry)).join('\n') : 'laya-router: nothing logged yet' }
  })

  // Running /model is a choice even when it keeps the model ("/model opus" on Opus), which no snapshot can see.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const chosen = await read($, route)
    if (chosen !== null) {
      await log($, 'reroute', { from: chosen.tier, to: e.args || null, nudged: await read($, nudge) })
    }
    await update($, isRouted, () => true)
    await update($, pending, () => null)
    await update($, route, () => null)
    await update($, nudge, () => null)
    $.ui.status('laya: /model used, routing off')
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear and a resume go on under a new session with fresh state and no session.start, so its baseline comes
    // from here.
    if (e.reason === 'clear' || e.reason === 'resume') {
      cfg.carriedModel = await $.session.model()
    }
    const suggested = await read($, nudge)
    if (suggested !== null) {
      await log($, 'nudge-ignored', { tier: suggested })
    }
    if (await read($, isRouted)) {
      await log($, 'end', { reason: e.reason })
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // ponytail: route the first prompt only, since every switch re-reads the whole conversation uncached.
    // Later prompts can only raise a nudge; not awaited, so the prompt never waits on laya-serve.
    if (await read($, isRouted)) {
      void checkDrift($, e.text, cfg)
      return next(e)
    }
    // A skill call types as "/name args"; the skill's text only exists at skill.prompt, so classify it there.
    const name = /^\/(\S+)/.exec(e.text.trim())?.[1]
    if (name === 'laya-log') {
      return next(e)
    }
    if (name !== undefined && (await $.command.list()).some((c) => c.name === name && (c.source === 'user' || c.source === 'plugin'))) {
      await update($, pending, () => e.text.trim())
      return next(e)
    }
    // Laya reads "hi" as a confident trivial task, which would lock the session to Haiku. Routing a later prompt
    // instead would switch models mid-conversation and drop the prompt cache, so stay on /model.
    if (e.text.trim().split(/\s+/).length < 3) {
      await update($, isRouted, () => true)
      $.ui.status('laya: unsure, using /model')
      return next(e)
    }
    await classify($, e.text, cfg)

    return next(e)
  }).catch(($, e, next) => next(e)) // routing is best effort: never hold a prompt back

  // ponytail: skill text is capped, since a SKILL.md is long and Laya's answer only needs its gist.
  // Some accounts (e.g. team/organization) don't offer skill.prompt; turn.step then routes on the typed command.
  try {
    on('skill.prompt', async ($, e, next) => {
      const typed = await read($, pending)
      if (typed !== null && !(await read($, isRouted))) {
        await update($, pending, () => null)
        await classify($, `${typed}\n\n${e.text.slice(0, SKILL_TEXT_CAP)}`, cfg)
      }
      return next(e)
    }).catch(($, e, next) => next(e))
  } catch {}

  on('turn.step', async function* ($, e, next) {
    // No skill.prompt fired for the pending command (unavailable here), so route on what was typed.
    const typed = e.agentId === undefined ? await read($, pending) : null
    if (typed !== null) {
      await update($, pending, () => null)
      // Same rule as a plain prompt: a bare "/commit" says too little, so stay on /model.
      if (typed.split(/\s+/).length >= 3) {
        await classify($, typed, cfg)
      } else {
        await update($, isRouted, () => true)
        $.ui.status('laya: unsure, using /model')
      }
    }
    const chosen = e.agentId === undefined ? await read($, route) : null
    if (chosen === null) {
      return yield* next(e)
    }

    // A manual /model after routing wins for the rest of the session.
    const sessionModel = await $.session.model()
    if (sessionModel !== chosen.sessionModel) {
      const suggested = await read($, nudge)
      await update($, route, () => null)
      await update($, nudge, () => null)
      $.ui.status('laya: /model changed, routing off')
      await log($, 'reroute', { from: chosen.tier, to: sessionModel, nudged: suggested })

      return yield* next(e)
    }

    return yield* next({ ...e, model: chosen.model, effort: chosen.effort })
  })

  // Repeated tool errors, or the same call again, mean the routed model is struggling.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // Never rethrow from here: the call already ran.
    try {
      const chosen = e.agentId === undefined ? await read($, route) : null
      if (chosen !== null) {
        const call = JSON.stringify({ ...e, tool_use_id: undefined })
        const isRetry = call === (await read($, lastCall))
        await update($, lastCall, () => call)
        const n = await update($, strikes, n => (result.isError || isRetry ? n + 1 : 0))
        const up = tierAbove(cfg, chosen.tier)
        if (n >= STRIKES_TO_NUDGE && up !== undefined) {
          await suggest($, up, result.isError ? 'tools keep failing' : 'going in circles')
        }
      }
    } catch {}
    return result
  })
}
