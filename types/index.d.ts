export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The model the first prompt was routed to, and the /model it overrides. */
export type Route = {
  tier: string
  model: string
  effort: Effort
  confidence: number
  sessionModel: string
}

declare module 'claude-code' {
  interface PluginState {
    'laya-router': {
      isRouted: boolean
      pending: string | null
      route: Route | null
      /** Failed or repeated main-thread tool calls in a row. */
      strikes: number
      /** The last main-thread tool call, to spot the same one again. */
      lastCall: string | null
      /** The tier the status line suggested moving up to, once per session. */
      nudge: string | null
      /** The session's model at start, to tell a /model picked before the first prompt. */
      startModel: string | null
    }
  }
}
