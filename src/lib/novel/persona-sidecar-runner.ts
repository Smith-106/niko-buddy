/**
 * EPIC-005 / ADR-34 — multi-persona critique sidecar (S5).
 *
 * ADR-34 alignment: CONFIRMED ✅ (2026-08-20)
 * - Isolation contract (hard):
 *   - Reads ready/accepted draft content only (never pending).
 *   - Writes only `.novel/sidecars/personas/{personaId}.json`.
 *   - MUST NOT write `status.json` / `decision_gates`.
 *   - Single LLM transport (`streamChat`); sequential persona runs (no multi-LLM fan-out).
 *   - No Big Five / Dark Tetrad imports — QMAI-authored system prompts only.
 *   - Main-chain modules MUST NOT import this runner (firewall tests).
 * - Firewall: see `docs/epic-005-persona-sidecar-firewall.md` for full isolation boundary.
 * - Verified: runPersonaCritique is consultative (authority="advisory"), never touches gate state.
 */
import { createDirectory, writeFileAtomic } from "@/commands/fs"
import {
  combineAbortSignals,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  streamChat,
  type StreamCallbacks,
} from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import {
  loadNovelDraftArtifact,
  type NovelDraftArtifact,
} from "./novel-session-status"

export type PersonaId = "critic" | "empath" | "devil" | "reader"

export interface PersonaDefinition {
  id: PersonaId
  label: string
  systemPrompt: string
}

export interface PersonaCritiqueResult {
  personaId: PersonaId
  label: string
  status: "ok" | "error" | "skipped"
  summary?: string
  findings?: string[]
  error?: string
  writtenPath?: string
  updatedAt: string
}

export interface RunPersonaCritiqueInput {
  projectPath: string
  /** Draft / conversation id used by loadNovelDraftArtifact. */
  draftId: string
  personaIds?: PersonaId[]
  llmConfig: LlmConfig
  signal?: AbortSignal
  /**
   * Injectable LLM for unit tests. Production uses streamChat.
   * Signature mirrors a minimal streamChat subset.
   */
  llmCall?: (
    config: LlmConfig,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ) => Promise<void>
}

export interface RunPersonaCritiqueResult {
  ok: boolean
  reason?: "draft-not-ready" | "draft-missing" | "empty-personas"
  draftStatus?: string
  results: PersonaCritiqueResult[]
}

export const DEFAULT_PERSONA_IDS: readonly PersonaId[] = [
  "critic",
  "empath",
  "devil",
  "reader",
] as const

/** QMAI-authored personas — no ProseCreator Big Five / Dark Tetrad. */
export const PERSONA_CATALOG: Record<PersonaId, PersonaDefinition> = {
  critic: {
    id: "critic",
    label: "挑剔者",
    systemPrompt:
      "你是严苛的网文编辑。只评本章正文：逻辑漏洞、节奏拖沓、设定打架、对话假。输出简洁中文，不要改写全文。",
  },
  empath: {
    id: "empath",
    label: "共情者",
    systemPrompt:
      "你是共情读者。关注人物动机是否可信、情绪是否到位、读者是否会心疼/共鸣。输出简洁中文，不要改写全文。",
  },
  devil: {
    id: "devil",
    label: "魔鬼设师",
    systemPrompt:
      "你是反方质询者。专门找最容易被读者喷的点：爽点廉价、反派降智、巧合过多、承诺未兑现。输出简洁中文，不要改写全文。",
  },
  reader: {
    id: "reader",
    label: "读者代表",
    systemPrompt:
      "你是普通追更读者。用口语说出「会不会弃文」的理由与「想继续看」的钩子。输出简洁中文，不要改写全文。",
  },
}

export function personaSidecarDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/sidecars/personas`
}

export function personaSidecarPath(projectPath: string, personaId: PersonaId): string {
  return `${personaSidecarDir(projectPath)}/${personaId}.json`
}

/** Ready or accepted (formal path) only — pending rejected per ADR-34 Draft-first. */
export function isDraftEligibleForPersona(draft: NovelDraftArtifact | null): boolean {
  if (!draft) return false
  return draft.draft_status === "ready" || draft.draft_status === "accepted"
}

function buildUserPrompt(draft: NovelDraftArtifact): string {
  const chapter = draft.chapter_number != null ? `第${draft.chapter_number}章` : "本章"
  const body = draft.content.trim()
  const clipped = body.length > 12000 ? `${body.slice(0, 12000)}\n…(截断)` : body
  return [
    `请评论${chapter}草稿（咨询性，不改门控）。`,
    `用户请求：${draft.user_request}`,
    "",
    "## 正文",
    clipped,
    "",
    "请用 JSON 回答（不要代码围栏）：",
    `{"summary":"一句话总评","findings":["要点1","要点2"]}`,
  ].join("\n")
}

function parseCritiqueText(text: string): { summary: string; findings: string[] } {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fence ? fence[1].trim() : trimmed
  try {
    const parsed = JSON.parse(raw) as { summary?: unknown; findings?: unknown }
    const summary = typeof parsed.summary === "string" ? parsed.summary : trimmed.slice(0, 280)
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.filter((x): x is string => typeof x === "string")
      : []
    return { summary, findings }
  } catch {
    return { summary: trimmed.slice(0, 280) || "(empty)", findings: [] }
  }
}

async function callPersonaLlm(
  input: RunPersonaCritiqueInput,
  persona: PersonaDefinition,
  draft: NovelDraftArtifact,
): Promise<string> {
  const messages = [
    { role: "system" as const, content: persona.systemPrompt },
    { role: "user" as const, content: buildUserPrompt(draft) },
  ]
  let acc = ""
  const callbacks: StreamCallbacks = {
    onToken: (t) => {
      acc += t
    },
    onDone: () => {},
    onError: () => {},
  }
  const combined = combineAbortSignals(
    input.signal,
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS)
      : undefined,
  )
  const call = input.llmCall ?? streamChat
  await call(input.llmConfig, messages, callbacks, combined)
  return acc
}

/**
 * Run multi-persona critique for one draft.
 * Consultative only — never writes decision_gates / status.json.
 */
export async function runPersonaCritique(
  input: RunPersonaCritiqueInput,
): Promise<RunPersonaCritiqueResult> {
  const draft = await loadNovelDraftArtifact(input.projectPath, input.draftId)
  if (!draft) {
    return { ok: false, reason: "draft-missing", results: [] }
  }
  if (!isDraftEligibleForPersona(draft)) {
    return {
      ok: false,
      reason: "draft-not-ready",
      draftStatus: draft.draft_status,
      results: [],
    }
  }

  const ids = (input.personaIds?.length ? input.personaIds : [...DEFAULT_PERSONA_IDS]).filter(
    (id): id is PersonaId => id in PERSONA_CATALOG,
  )
  if (ids.length === 0) {
    return { ok: false, reason: "empty-personas", draftStatus: draft.draft_status, results: [] }
  }

  const dir = personaSidecarDir(input.projectPath)
  await createDirectory(dir)

  // Sequential single-LLM runs (ADR-34: no multi-LLM parallel fan-out).
  // Collect with allSettled-equivalent results for partial success reporting.
  const results: PersonaCritiqueResult[] = []
  for (const id of ids) {
    if (input.signal?.aborted) {
      results.push({
        personaId: id,
        label: PERSONA_CATALOG[id].label,
        status: "skipped",
        error: "aborted",
        updatedAt: new Date().toISOString(),
      })
      continue
    }
    const persona = PERSONA_CATALOG[id]
    const updatedAt = new Date().toISOString()
    try {
      const text = await callPersonaLlm(input, persona, draft)
      const parsed = parseCritiqueText(text)
      const payload = {
        schema_version: "1" as const,
        persona_id: id,
        label: persona.label,
        draft_id: draft.draft_id,
        draft_status: draft.draft_status,
        chapter_number: draft.chapter_number,
        summary: parsed.summary,
        findings: parsed.findings,
        raw: text,
        updated_at: updatedAt,
        // Consultative sidecar — never authority for product gates.
        authority: "advisory" as const,
      }
      const writtenPath = personaSidecarPath(input.projectPath, id)
      await writeFileAtomic(writtenPath, JSON.stringify(payload, null, 2))
      results.push({
        personaId: id,
        label: persona.label,
        status: "ok",
        summary: parsed.summary,
        findings: parsed.findings,
        writtenPath,
        updatedAt,
      })
    } catch (err) {
      // PAT-DC1: message only, no provider dumps.
      const message = err instanceof Error ? err.message : "persona-error"
      results.push({
        personaId: id,
        label: persona.label,
        status: "error",
        error: message,
        updatedAt,
      })
    }
  }

  return {
    ok: results.some((r) => r.status === "ok"),
    draftStatus: draft.draft_status,
    results,
  }
}
