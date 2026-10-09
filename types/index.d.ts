export type Effort = 'low' | 'medium' | 'high' | 'xhigh'

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
    'laya-router': { isRouted: boolean; route: Route | null }
  }
}
