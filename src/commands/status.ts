import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/platform"
import { createDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { DraftStatus } from "@/lib/novel/draft-state-machine"
import type { ContextAssemblyResult } from "@/lib/novel/context-assembly"

export type NovelSessionStatus = "running" | "completed" | "paused" | "blocked"

export type NovelGateType = "consistency" | "anti_ai" | "quality"
export type NovelGateStatus = "pending" | "passed" | "failed" | "warning"

export interface StatusFinding {
  severity: string
  description: string
  location?: string | null
  suggestion?: string | null
}

export interface StatusDecisionGate {
  gate_type: NovelGateType
  mechanical_findings: StatusFinding[]
  semantic_findings: StatusFinding[]
  retry_count: number
  max_retry: number
  status: NovelGateStatus
}

export interface StatusSchema {
  schema_version: string
  session_id: string
  created_at: string
  updated_at: string
  source: string
  status: NovelSessionStatus
  active_step_index: number | null
  current_task?: string | null
  boundary_contract: unknown
  execution_criteria: unknown[]
  task_decomposition: unknown[]
  decision_gates: Record<string, StatusDecisionGate>
  context_assembly?: ContextAssemblyResult | null
  draft: unknown | null
  memory_snapshot: unknown | null
  evidence_refs?: string[]
}

export interface NovelDraftStatusPayload {
  draft_id: string
  draft_status: DraftStatus
  conversation_id: string
  source_task_id?: string
  chapter_number?: number
  user_request: string
  task_brief?: string
  draft_content?: string
  final_content?: string
  review_results?: unknown[]
  accepted_at?: string
  rejected_at?: string
  superseded_at?: string
  supersedes_draft_id?: string
  formal_chapter_path?: string
  updated_at: string
}

function statusJsonPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/status.json`
}

export async function statusRead(projectPath: string): Promise<StatusSchema> {
  if (!isTauri()) {
    const content = await readFile(statusJsonPath(projectPath))
    return JSON.parse(content) as StatusSchema
  }
  return invoke<StatusSchema>("status_read", { projectPath })
}

export async function statusWrite(projectPath: string, schema: StatusSchema): Promise<void> {
  if (!isTauri()) {
    await createDirectory(`${normalizePath(projectPath)}/.novel`).catch(() => {})
    await writeFile(statusJsonPath(projectPath), JSON.stringify(schema, null, 2))
    return
  }
  return invoke<void>("status_write", { projectPath, schema })
}
