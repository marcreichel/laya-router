import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Stands in for laya-serve, the session's /model and the model request beneath the plugin.
function world(on: On, laya: { status: number; choice?: string; confidence?: number }) {
  const sent: { model: string; effort?: unknown }[] = []
  const calls: string[] = []
  let sessionModel = 'claude-opus-5-5'

  on('http.fetch', ($, e) => {
    calls.push(e.init?.body ?? '')
    return { value: { status: laya.status, ok: laya.status < 300, headers: {}, text: JSON.stringify({ answers: { route: { choice: laya.choice, answer_confidence: laya.confidence } } }) } }
  })
  on('session.model', () => ({ value: sessionModel }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  return { sent, calls, setModel: (m: string) => (sessionModel = m) }
}

function submit($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // drained, so the request beneath runs
  }
}

test('routes the session from its first prompt only', async ($, on) => {
  const w = world(on, { status: 200, choice: 'haiku', confidence: 0.9 })

  await submit($, 'Translate hello into French.')
  await step($)
  await submit($, 'Now prove the Riemann hypothesis.')
  await step($)

  expect(w.calls.length).toBe(1)
  expect(JSON.parse(w.calls[0] ?? '').state).toBe('Translate hello into French.')
  expect(w.sent).toEqual([
    { model: 'claude-haiku-5-5', effort: 'low' },
    { model: 'claude-haiku-5-5', effort: 'low' },
  ])
})

test('leaves subagents alone', { options: { enableFable: true } }, async ($, on) => {
  const w = world(on, { status: 200, choice: 'fable', confidence: 0.7 })

  await submit($, 'Invent a new theory of dark matter.')
  await step($, 'agent-1')
  await step($)

  expect(w.sent).toEqual([
    { model: 'claude-opus-5-5', effort: 'high' },
    { model: 'claude-fable-5-1', effort: 'xhigh' },
  ])
})

test('leaves Fable out unless enabled', async ($, on) => {
  const w = world(on, { status: 200, choice: 'fable', confidence: 0.9 })

  await submit($, 'Invent a new theory of dark matter.')
  await step($)

  expect(Object.keys(JSON.parse(w.calls[0] ?? '').questions.route.criteria)).toEqual(['haiku', 'sonnet', 'opus'])
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('keeps /model when laya is unsure', async ($, on) => {
  const w = world(on, { status: 200, choice: 'haiku', confidence: 0.39 })

  await submit($, 'Help me with my thing.')
  await step($)

  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('keeps /model when laya-serve is down', async ($, on) => {
  const w = world(on, { status: 503 })

  await submit($, 'Translate hello into French.')
  await step($)

  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('a manual /model switch turns routing off', async ($, on) => {
  const w = world(on, { status: 200, choice: 'haiku', confidence: 0.9 })

  await submit($, 'Translate hello into French.')
  await step($)
  w.setModel('claude-sonnet-5-5')
  await step($)
  w.setModel('claude-opus-5-5')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('sends the configured URL and API key', { options: { layaUrl: 'http://laya:9000/', layaApiKey: 's3cret' } }, async ($, on) => {
  let seen: { url: string; auth?: string } | null = null
  on('http.fetch', ($, e) => {
    seen = { url: e.url, auth: e.init?.headers?.authorization }
    return { value: { status: 503, ok: false, headers: {}, text: '' } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await submit($, 'hi')

  expect(seen).toEqual({ url: 'http://laya:9000/v1/systemone', auth: 'Bearer s3cret' })
})
