import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Effort, Route } from '../types'
import { MIN_CONFIDENCE, TIERS, routeQuestion } from './tiers'

const isRouted = atom({ plugin: 'laya-router', key: 'isRouted' } as const, false)
const route = atom({ plugin: 'laya-router', key: 'route' } as const, null)

type Answer = { choice?: unknown; confidence?: unknown; answer_confidence?: unknown }

export const register: Register = (on, options) => {
  const url = `${String(options.layaUrl ?? 'http://localhost:8000').replace(/\/+$/, '')}/v1/systemone`
  const apiKey = String(options.layaApiKey ?? '')
  // Fable isn't in every subscription, so it's opt-in; without it Laya picks from the other three.
  const enableFable = String(options.enableFable ?? false) === 'true'
  // Claude Code validates each <tier>Effort against its options before load, falling back to the default.
  const tiers = Object.fromEntries(
    Object.entries(TIERS)
      .filter(([tier]) => tier !== 'fable' || enableFable)
      .map(([tier, t]) => [tier, { ...t, effort: (options[`${tier}Effort`] as Effort | undefined) ?? t.effort }]),
  )
  const minConfidence = enableFable ? MIN_CONFIDENCE.withFable : MIN_CONFIDENCE.withoutFable

  on('prompt.submit', async ($, e, next) => {
    // ponytail: first prompt only, since every switch re-reads the whole conversation uncached.
    if (await read($, isRouted)) {
      return next(e)
    }
    // Laya reads "hi" as a confident trivial task, which would lock the session to Haiku.
    if (e.text.trim().split(/\s+/).length < 3) {
      $.ui.status('laya: waiting for a longer prompt')
      return next(e)
    }
    await update($, isRouted, () => true)

    try {
      const response = await $.http.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          state: e.text,
          model: 'jev-latest',
          questions: { route: routeQuestion(tiers) },
        }),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const answer: Answer = JSON.parse(response.text)?.answers?.route ?? {}
      const [name, tier] = Object.entries(tiers).find(([, t]) => t.label === answer.choice) ?? []
      const confidence = Number(answer.answer_confidence ?? answer.confidence ?? 0)

      if (name === undefined || tier === undefined || confidence < minConfidence) {
        $.ui.status(`laya: unsure (${confidence.toFixed(2)}), using /model`)
      } else {
        const chosen: Route = { tier: name, model: tier.model, effort: tier.effort, confidence, sessionModel: await $.session.model() }
        await update($, route, () => chosen)
        $.ui.status(`laya → ${chosen.tier} ${confidence.toFixed(2)}`)
      }
    } catch {
      $.ui.status('laya: offline, using /model')
    }

    return next(e)
  }).catch(($, e, next) => next(e)) // routing is best effort: never hold a prompt back

  on('turn.step', async function* ($, e, next) {
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
