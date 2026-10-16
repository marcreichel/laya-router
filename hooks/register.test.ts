import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Stands in for laya-serve, the session's /model and the model request beneath the plugin.
function world(on: On, laya: { status: number; choice?: string; confidence?: number; health?: number[] | 'hang'; delayMs?: number; timeFlies?: boolean }) {
  const sent: { model: string; effort?: unknown }[] = []
  const calls: string[] = []
  const healthChecks: number[] = []
  const statuses: (string | undefined)[] = []
  let sessionModel = 'claude-opus-5-5'

  on('http.fetch', async ($, e) => {
    if (e.url.endsWith('/health')) {
      if (laya.health === 'hang') {
        return new Promise(() => {})
      }
      // Answers in turn, the last one for good; up unless told otherwise.
      const status = laya.health?.[healthChecks.length] ?? laya.health?.at(-1) ?? 200
      healthChecks.push(status)
      return { value: { status, ok: status < 300, headers: {}, text: '' } }
    }
    calls.push(e.init?.body ?? '')
    if (laya.delayMs) {
      await new Promise(r => setTimeout(r, laya.delayMs))
    }
    return { value: { status: laya.status, ok: laya.status < 300, headers: {}, text: JSON.stringify({ answers: { route: { choice: laya.choice, answer_confidence: laya.confidence } } }) } }
  })
  // The health timeout only fires against a /health that hangs.
  on('clock.sleep', () => (laya.health === 'hang' || laya.timeFlies ? { value: undefined } : new Promise(() => {})))
  on('session.model', () => ({ value: sessionModel }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  return { sent, calls, healthChecks, statuses, setModel: (m: string) => (sessionModel = m) }
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
  const w = world(on, { status: 200, choice: 'trivial', confidence: 0.9 })

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
  const w = world(on, { status: 200, choice: 'research', confidence: 0.7 })

  await submit($, 'Invent a new theory of dark matter.')
  await step($, 'agent-1')
  await step($)

  expect(w.sent).toEqual([
    { model: 'claude-opus-5-5', effort: 'high' },
    { model: 'claude-fable-5-1', effort: 'xhigh' },
  ])
})

test('leaves Fable out unless enabled', async ($, on) => {
  const w = world(on, { status: 200, choice: 'research', confidence: 0.9 })

  await submit($, 'Invent a new theory of dark matter.')
  await step($)

  const criteria = JSON.parse(w.calls[0] ?? '').questions.route.criteria
  expect(Object.keys(criteria)).toEqual(['trivial', 'routine', 'hard'])
  expect(criteria.hard.endsWith(', new theory, formal proof')).toBe(true)
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('uses the configured effort per tier', { options: { opusEffort: 'max' } }, async ($, on) => {
  const w = world(on, { status: 200, choice: 'hard', confidence: 0.9 })

  await submit($, 'Why does this deadlock only under load?')
  await step($)

  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'max' }])
})

test('keeps /model when laya is unsure', async ($, on) => {
  const w = world(on, { status: 200, choice: 'trivial', confidence: 0.39 })

  await submit($, 'Help me with my thing.')
  await step($)

  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('keeps /model for the session when the first prompt is under 3 words', async ($, on) => {
  const w = world(on, { status: 200, choice: 'trivial', confidence: 0.9 })

  await submit($, 'hi there')
  await step($)
  await submit($, 'Translate hello into French.')
  await step($)

  expect(w.calls.length).toBe(0)
  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(w.statuses).toEqual(['laya: unsure, using /model'])
})

test('keeps /model when laya-serve fails to classify', async ($, on) => {
  const w = world(on, { status: 503 })

  await submit($, 'Translate hello into French.')
  await step($)

  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('skips classifying when /health is down', async ($, on) => {
  const w = world(on, { status: 200, choice: 'trivial', confidence: 0.9, health: [503] })

  await submit($, 'Translate hello into French.')
  await step($)

  expect(w.calls.length).toBe(0)
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
  expect(w.statuses).toEqual(['laya: offline, using /model'])
})

test('gives up on a /health that does not answer', async ($, on) => {
  const w = world(on, { status: 200, choice: 'trivial', confidence: 0.9, health: 'hang' })

  await submit($, 'Translate hello into French.')
  await step($)

  expect(w.calls.length).toBe(0)
  expect(w.statuses).toEqual(['laya: offline, using /model'])
})

test('waits for a healthy but slow laya-serve', async ($, on) => {
  // Time flies, so a timeout still raced against classify would win.
  const w = world(on, { status: 200, choice: 'trivial', confidence: 0.9, delayMs: 50, timeFlies: true })

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await submit($, 'Translate hello into French.')
  await step($)

  expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
})

test('reuses the startup health check while laya-serve is up', async ($, on) => {
  const w = world(on, { status: 200, choice: 'trivial', confidence: 0.9 })

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await submit($, 'Translate hello into French.')
  await step($)

  expect(w.healthChecks).toEqual([200])
  expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
})

test('checks /health again when laya-serve was down at startup', async ($, on) => {
  const w = world(on, { status: 200, choice: 'trivial', confidence: 0.9, health: [503, 200] })

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await submit($, 'Translate hello into French.')
  await step($)

  expect(w.healthChecks).toEqual([503, 200])
  expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
})

test('a manual /model switch turns routing off', async ($, on) => {
  const w = world(on, { status: 200, choice: 'trivial', confidence: 0.9 })

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
  const health: (string | undefined)[] = []
  on('http.fetch', ($, e) => {
    if (e.url.endsWith('/health')) {
      health.push(e.init?.headers?.authorization)
      return { value: { status: 200, ok: true, headers: {}, text: '' } }
    }
    seen = { url: e.url, auth: e.init?.headers?.authorization }
    return { value: { status: 503, ok: false, headers: {}, text: '' } }
  })
  on('clock.sleep', () => new Promise(() => {}))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await submit($, 'Translate hello into French.')

  expect(seen).toEqual({ url: 'http://laya:9000/v1/systemone', auth: 'Bearer s3cret' })
  expect(health).toEqual(['Bearer s3cret'])
})

test('routes a skill call from its expanded text, not the typed command', async ($, on) => {
  const w = world(on, { status: 200, choice: 'hard', confidence: 0.9 })
  on('command.list', () => ({ value: [{ name: 'implement-issue', description: '', source: 'user' }] }))
  on('skill.prompt', ($, e) => ({ text: e.text }))

  await submit($, '/implement-issue 12345')
  expect(w.calls.length).toBe(0)
  await $.skill.prompt({ skill: 'implement-issue', text: 'Implement the issue.' })
  await step($)

  expect(JSON.parse(w.calls[0] ?? '').state).toBe('/implement-issue 12345\n\nImplement the issue.')
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('routes a skill call from the typed command when skill.prompt never fires', async ($, on) => {
  const w = world(on, { status: 200, choice: 'hard', confidence: 0.9 })
  on('command.list', () => ({ value: [{ name: 'implement-issue', description: '', source: 'user' }] }))

  await submit($, '/implement-issue fix the flaky login test')
  await step($)

  expect(JSON.parse(w.calls[0] ?? '').state).toBe('/implement-issue fix the flaky login test')
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('keeps /model for the session after a bare skill call without skill.prompt', async ($, on) => {
  const w = world(on, { status: 200, choice: 'trivial', confidence: 0.9 })
  on('command.list', () => ({ value: [{ name: 'commit', description: '', source: 'plugin' }] }))

  await submit($, '/commit')
  await step($)
  await submit($, 'Translate hello into French.')
  await step($)

  expect(w.calls.length).toBe(0)
  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(w.statuses).toEqual(['laya: unsure, using /model'])
})
