import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Effort, Route } from '../types'
import { MIN_CONFIDENCE, TIERS, routeQuestion } from './tiers'

const isRouted = atom({ plugin: 'laya-router', key: 'isRouted' } as const, false)
const pending = atom({ plugin: 'laya-router', key: 'pending' } as const, null)
const route = atom({ plugin: 'laya-router', key: 'route' } as const, null)

const LAYA_HEALTH_TIMEOUT_MS = 2000
const SKILL_TEXT_CAP = 2000

type Ctx = Parameters<Hook<'prompt.submit'>>[0] | Parameters<Hook<'turn.step'>>[0] | Parameters<Hook<'session.start'>>[0]
type Config = { url: string; tiers: Record<string, (typeof TIERS)[string]>; minConfidence: number; headers: Record<string, string>; healthUrl: string; health?: Promise<boolean> }
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

async function classify($: Ctx, text: string, cfg: Config) {
  await update($, isRouted, () => true)

  try {
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
    const confidence = Number(answer.answer_confidence ?? answer.confidence ?? 0)

    if (name === undefined || tier === undefined || confidence < cfg.minConfidence) {
      $.ui.status(`laya: unsure (${confidence.toFixed(2)}), using /model`)
    } else {
      const chosen: Route = { tier: name, model: tier.model, effort: tier.effort, confidence, sessionModel: await $.session.model() }
      await update($, route, () => chosen)
      $.ui.status(`laya → ${chosen.tier} ${confidence.toFixed(2)}`)
    }
  } catch {
    $.ui.status('laya: offline, using /model')
}

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

  on('session.start', ($, e, next) => {
    // Not awaited: the first session.start holds up startup.
    cfg.health = checkHealth($, cfg.healthUrl, headers)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // ponytail: first prompt only, since every switch re-reads the whole conversation uncached.
    if (await read($, isRouted)) {
      return next(e)
    }
    // A skill call types as "/name args"; the skill's text only exists at skill.prompt, so classify it there.
    const name = /^\/(\S+)/.exec(e.text.trim())?.[1]
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
    if ((await $.session.model()) !== chosen.sessionModel) {
      await update($, route, () => null)
      $.ui.status('laya: /model changed, routing off')

      return yield* next(e)
    }

    return yield* next({ ...e, model: chosen.model, effort: chosen.effort })
  })
}
