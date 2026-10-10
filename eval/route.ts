// Scores the tier descriptions against a live laya-serve:  node eval/route.ts
// Runs with Fable off (3 tiers, fable prompts expect opus) and on (4 tiers).
import { MIN_CONFIDENCE, TIERS, routeQuestion } from '../hooks/tiers.ts'

// null = too vague to route, so "unsure" is the right answer. Prompts under 3 words never reach
// Laya (register.ts skips them), so they aren't here.
const PROMPTS: [string, string | null][] = [
  ['Translate this error message into German: "File not found"', 'haiku'],
  ["What's the default port for PostgreSQL?", 'haiku'],
  ['Rename the variable usr to user across src/', 'haiku'],
  ['Fix the typo "recieve" everywhere in the repo', 'haiku'],
  ['Bump the version in package.json to 2.4.0', 'haiku'],
  ['What does the -p flag of mkdir do?', 'haiku'],
  ['Rewrite this commit message in imperative mood: "added login"', 'haiku'],
  ['Sort the imports in app.ts alphabetically', 'haiku'],
  ['Convert this JSON snippet to YAML', 'haiku'],

  ['Add a dark mode toggle to the settings page', 'sonnet'],
  ['Implement GitHub issue #42', 'sonnet'],
  ['Refactor the auth module to use dependency injection', 'sonnet'],
  ['Write a bash script that renames all jpg files by their EXIF date', 'sonnet'],
  ['Write a SQL query that lists customers with more than 3 orders', 'sonnet'],
  ['Add unit tests for the date formatting helpers', 'sonnet'],
  ['Summarize this README for me', 'sonnet'],
  ['Add pagination to the /users API endpoint', 'sonnet'],
  ['Draft an email to the team announcing the new release process', 'sonnet'],
  ['Create a Dockerfile for this Node app', 'sonnet'],
  ['Add a --verbose CLI flag that prints debug output', 'sonnet'],
  ['Convert this class component to a React function component with hooks', 'sonnet'],
  ['Set up a GitHub Actions workflow that runs the tests on every PR', 'sonnet'],

  ['Why does this deadlock only under load?', 'opus'],
  ['Our Kafka consumer loses messages after a rebalance, find out why', 'opus'],
  ['The test passes locally but fails in CI about one run in ten. Figure out why.', 'opus'],
  ['Memory grows by ~50 MB per hour in production, find the leak', 'opus'],
  ['Review the architecture of this monorepo and propose how to split the billing service out', 'opus'],
  ["Users sometimes see another user's cart. Track down the cause.", 'opus'],
  ['Plan a migration from REST to GraphQL without downtime', 'opus'],
  ['Audit the session handling for security vulnerabilities', 'opus'],
  ['Explain how a request flows through this codebase from the HTTP handler to the database', 'opus'],
  ['This query got 20x slower after upgrading Postgres 15 to 16, investigate', 'opus'],

  ['Prove that this lock-free queue is linearizable', 'fable'],
  ['Come up with a new consistency model that sits between causal and linearizable', 'fable'],
  ['Formulate a hypothesis for why attention heads specialize and design an experiment to test it', 'fable'],
  ['Invent a novel compression scheme for time-series sensor data and argue its bounds', 'fable'],
  ['Derive a closed-form bound for the false-positive rate of this modified Bloom filter', 'fable'],
  ['Propose a theory for why our A/B tests systematically overestimate effect sizes', 'fable'],

  ['Help me with my thing.', null],
  ['Can you take a look?', null],
]

const url = `${(process.env.LAYA_URL ?? 'http://localhost:8000').replace(/\/+$/, '')}/v1/systemone`

async function classify(prompt: string, tiers: typeof TIERS) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: prompt, model: 'jev-latest', questions: { route: routeQuestion(tiers) } }),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  }
  const answer = (await response.json()).answers.route
  const tier = Object.keys(tiers).find(tier => tiers[tier]?.label === answer.choice)
  return { choice: String(tier), confidence: Number(answer.answer_confidence) }
}

const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : '-').padStart(4)

for (const fable of [false, true]) {
  const tiers = Object.fromEntries(Object.entries(TIERS).filter(([tier]) => fable || tier !== 'fable'))
  // One at a time: laya-serve rejects bursts.
  const results = []
  for (const [prompt, tier] of PROMPTS) {
    results.push({ prompt, expected: !fable && tier === 'fable' ? 'opus' : tier, ...(await classify(prompt, tiers)) })
  }

  console.log(`\n## ${Object.keys(tiers).length} tiers${fable ? ' (Fable on)' : ''}\n`)
  const min = fable ? MIN_CONFIDENCE.withFable : MIN_CONFIDENCE.withoutFable
  console.log('threshold  routed  accuracy on routed')
  for (let t = 0.25; t <= 0.801; t += 0.025) {
    const routed = results.filter(r => r.confidence >= t)
    const marker = Math.abs(t - min) < 0.001 ? '  ← MIN_CONFIDENCE' : ''
    console.log(`  ${t.toFixed(2)}      ${pct(routed.length, results.length)}    ${pct(routed.filter(r => r.choice === r.expected).length, routed.length)}${marker}`)
  }

  console.log('\nmisses (wrong top choice, any confidence):')
  for (const r of results.filter(r => r.choice !== r.expected)) {
    console.log(`  ${r.confidence.toFixed(2)} ${r.choice.padEnd(6)} want ${String(r.expected).padEnd(6)} ${r.prompt}`)
  }
}
