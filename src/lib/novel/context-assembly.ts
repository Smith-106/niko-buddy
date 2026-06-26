export type ContextSourceStatus = "loaded" | "fallback" | "defaulted"

export interface ContextAssemblySource {
  type: string
  ref: string
  priority?: number
  status?: ContextSourceStatus
}

export interface ContextAssemblyResult {
  task_id: string
  sources: ContextAssemblySource[]
  token_budget: number | null
  estimated_tokens: number
  prompt_chars: number
  hard_constraints: string[]
  gaps: string[]
}
