import type { Effort } from '../types'

// Laya knows tasks, not models: ask how demanding the prompt is. Neutral labels and keyword
// descriptions, tuned against laya-serve via `node eval/route.ts`; model names as labels skew it.
export const TIERS: Record<string, { model: string; effort: Effort; label: string; describe: string }> = {
  haiku: { model: 'claude-haiku-5-5', effort: 'low', label: 'trivial', describe: 'quick question, translation, rename, typo, version bump' },
  sonnet: { model: 'claude-sonnet-5-5', effort: 'medium', label: 'routine', describe: 'new feature, refactor, tests, script, query, email, summary' },
  opus: {
    model: 'claude-opus-5-5',
    effort: 'high',
    label: 'hard',
    describe: 'subtle bug, flaky test, memory leak, performance regression, architecture, migration plan, security audit',
  },
  fable: { model: 'claude-fable-5-1', effort: 'xhigh', label: 'research', describe: 'new theory, hypothesis, formal proof, mathematical bound' },
}

// answer_confidence is the top probability, so its floor is 1/tiers: each tier count gets its own
// threshold, the lowest that keeps about 90% of routed prompts on the expected tier.
export const MIN_CONFIDENCE = { withoutFable: 0.475, withFable: 0.375 }

/** The laya-serve choice question over the enabled tiers. */
export function routeQuestion(tiers: Record<string, { label: string; describe: string }>) {
  return {
    type: 'choice',
    instructions: 'How demanding is this request for a coding assistant?',
    criteria: Object.fromEntries(
      Object.entries(tiers).map(([tier, { label, describe }]) => [
        label,
        // Without Fable, research prompts belong to Opus.
        tier === 'opus' && !('fable' in tiers) ? `${describe}, new theory, formal proof` : describe,
      ]),
    ),
  }
}
