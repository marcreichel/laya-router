import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Effort, Route } from '../types'

// Laya knows tasks, not models: ask what kind of task the prompt is, with
// descriptions tuned against laya-serve.
const TIERS: Record<string, { model: string; effort: Effort; describe: string }> = {
  haiku: { model: 'claude-haiku-5-5', effort: 'low', describe: 'a simple translation, lookup or rewrite' },
  sonnet: { model: 'claude-sonnet-5-5', effort: 'medium', describe: 'writing a common query, script, email or summary' },
  opus: { model: 'claude-opus-5-5', effort: 'high', describe: 'finding and fixing a subtle bug or analysing a complex system' },
  fable: { model: 'claude-fable-5-1', effort: 'xhigh', describe: 'inventing new theories, hypotheses or proofs' },
}
const MIN_CONFIDENCE = 0.6

const isRouted = atom({ plugin: 'laya-router', key: 'isRouted' } as const, false)
const route = atom({ plugin: 'laya-router', key: 'route' } as const, null)

type Answer = { choice?: unknown; confidence?: unknown; answer_confidence?: unknown }

export const register: Register = (on, options) => {
  const url = `${String(options.layaUrl ?? 'http://localhost:8000').replace(/\/+$/, '')}/v1/systemone`
  const apiKey = String(options.layaApiKey ?? '')

  on('prompt.submit', async ($, e, next) => {
    // ponytail: first prompt only, since every switch re-reads the whole conversation uncached.
    if (await read($, isRouted)) {
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
          questions: {
            route: {
              type: 'choice',
              instructions: 'What kind of task is this?',
              criteria: Object.fromEntries(Object.entries(TIERS).map(([tier, { describe }]) => [tier, describe])),
            },
          },
        }),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const answer: Answer = JSON.parse(response.text)?.answers?.route ?? {}
      const tier = typeof answer.choice === 'string' ? TIERS[answer.choice] : undefined
      const confidence = Number(answer.answer_confidence ?? answer.confidence ?? 0)

      if (tier === undefined || confidence < MIN_CONFIDENCE) {
        $.ui.status(`laya: unsure (${confidence.toFixed(2)}), using /model`)
      } else {
        const chosen: Route = { tier: String(answer.choice), model: tier.model, effort: tier.effort, confidence, sessionModel: await $.session.model() }
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
