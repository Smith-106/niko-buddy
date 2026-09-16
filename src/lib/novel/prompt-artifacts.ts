/**
 * prompt-artifacts.ts — 波1 模块 20 提示词工件化（版本化仓库 + 门-提示词血缘）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 模块 20，入波 1 的理由：
 * 门结果不带裁判版本则证据链（EB-1）与路由自检（AX-7）无法闭环——三路共识收敛）：
 *   - PromptArtifact：版本化提示词工件（template/vars/appliesTo/testRefs/contentHash）；
 *   - 版本不可变：同 (artifactId, version) 内容 hash 不同 → 拒绝（注册即冻结）；
 *   - 门-提示词血缘：LLM 中介的 gate-run 事件 100% 携带 promptArtifactId@version
 *     （checkPromptLineageCoverage，G1 硬门），FAIL 可跳转当时提示词版本；
 *   - 超越点：门-提示词血缘（B 无裁判版本概念）。
 *
 * 机械层（ADR-19）：纯函数 + zod；contentHash 为同步确定性 FNV-1a 32-bit
 * （非加密身份哈希，仅用于版本不可变判定与 diff 指纹；加密级 digest 见
 * checkpoint-digest.ts 的异步 SHA-256，按需另走）。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import type { GateKey } from "./audit-taxonomy"
import { eventsByReplayId, type RunEvent, type RunEventLedger } from "./run-event-ledger"

// ============================================================================
// 工件 zod 契约
// ============================================================================

/**
 * PromptArtifact 契约（strict）。appliesTo 建议键法：`gate:<key>` / `stage:<action>` /
 * `module:<id>`；testRefs 指向回归 fixture（门级重试差分与提示词回归的挂点）。
 */
export const PROMPT_ARTIFACT_SCHEMA = z
  .object({
    artifactId: z.string().min(1).max(128),
    version: z.string().min(1).max(32),
    template: z.string().min(1),
    /** 模板变量名清单（`${name}` 占位；登记用，渲染由调用方执行）。 */
    vars: z.array(z.string().min(1).max(64)).max(32).default([]),
    appliesTo: z.string().min(1).max(128),
    modelHint: z.string().min(1).max(128).optional(),
    testRefs: z.array(z.string().min(1).max(128)).max(64).default([]),
    /** 内容身份哈希（computePromptTemplateHash 产物；版本不可变判定键）。 */
    contentHash: z.string().min(1).max(64),
    /** 创建时间（调用方注入，零时钟）。 */
    createdAt: z.string().min(1).max(64).optional(),
  })
  .strict()

/** 提示词工件。 */
export type PromptArtifact = z.infer<typeof PROMPT_ARTIFACT_SCHEMA>

/** 工件输入（vars/testRefs 可省略）。 */
export type PromptArtifactInput = z.input<typeof PROMPT_ARTIFACT_SCHEMA>

// ============================================================================
// 身份哈希（同步确定性 FNV-1a 32-bit + 长度后缀）
// ============================================================================

/**
 * 模板身份哈希（非加密）：FNV-1a 32-bit hex + `-len<N>` 长度后缀。
 * 确定性：同输入恒同输出；仅用于版本不可变判定，不承担抗碰撞性主张。
 */
export function computePromptTemplateHash(template: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < template.length; i += 1) {
    hash ^= template.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const hex = hash.toString(16).padStart(8, "0")
  return `fnv1a-${hex}-len${template.length}`
}

// ============================================================================
// 版本化仓库（不可变注册）
// ============================================================================

/** 仓库 schema 版本。 */
export const PROMPT_ARTIFACT_REGISTRY_SCHEMA_VERSION = "prompt-artifacts/1.0"

/** 提示词工件仓库（冻结快照；注册返回新仓库，原仓库不变）。 */
export interface PromptArtifactRegistry {
  readonly schemaVersion: typeof PROMPT_ARTIFACT_REGISTRY_SCHEMA_VERSION
  readonly artifacts: readonly PromptArtifact[]
}

/** 创建空仓库。 */
export function createPromptArtifactRegistry(): PromptArtifactRegistry {
  return deepFreeze({ schemaVersion: PROMPT_ARTIFACT_REGISTRY_SCHEMA_VERSION, artifacts: [] })
}

/** 仓库错误基类。 */
export class PromptArtifactRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PromptArtifactRegistryError"
  }
}

/**
 * 注册工件（append-only 语义 + 版本不可变）：
 *   - schema 校验（strict，非法即抛）；
 *   - 同 (artifactId, version) 且 contentHash 相同 → 幂等（原仓库不变，返回原仓库）；
 *   - 同 (artifactId, version) 且 contentHash 不同 → 拒绝（版本不可变违反）；
 *   - 同 id 新版本 → 追加；返回**新**仓库（原仓库不变，深度冻结）。
 */
export function registerPromptArtifact(
  registry: PromptArtifactRegistry,
  artifact: PromptArtifactInput,
): PromptArtifactRegistry {
  let normalized: PromptArtifact
  try {
    normalized = PROMPT_ARTIFACT_SCHEMA.parse(artifact)
  } catch (err) {
    throw new PromptArtifactRegistryError(
      `prompt artifact 契约违反: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const existing = registry.artifacts.find(
    (a) => a.artifactId === normalized.artifactId && a.version === normalized.version,
  )
  if (existing) {
    if (existing.contentHash !== normalized.contentHash) {
      throw new PromptArtifactRegistryError(
        `版本不可变违反: ${normalized.artifactId}@${normalized.version} 已存在且 contentHash 不同（${existing.contentHash} != ${normalized.contentHash}）`,
      )
    }
    return registry
  }
  return deepFreeze({
    schemaVersion: PROMPT_ARTIFACT_REGISTRY_SCHEMA_VERSION,
    artifacts: [...registry.artifacts, normalized],
  })
}

/** 语义版本轻比较：按 '.' 分段，段内数值前缀优先降序；正式段 > 预发布段；非数值回退字典序。 */
export function comparePromptVersions(a: string, b: string): number {
  const pa = a.split(".")
  const pb = b.split(".")
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const segA = pa[i] ?? ""
    const segB = pb[i] ?? ""
    const ma = /^(\d+)(.*)$/.exec(segA)
    const mb = /^(\d+)(.*)$/.exec(segB)
    if (ma && mb) {
      const na = Number(ma[1])
      const nb = Number(mb[1])
      if (na !== nb) return na - nb
      // 段内后缀：空（正式）> 非空（预发布，如 1.0.0-beta < 1.0.0）
      const sufA = ma[2]
      const sufB = mb[2]
      if (sufA !== sufB) {
        if (sufA === "") return 1
        if (sufB === "") return -1
        return sufA < sufB ? -1 : 1
      }
      continue
    }
    if (segA !== segB) return segA < segB ? -1 : 1
  }
  return 0
}

/** 解析工件：version 省略 → 该 id 的最高版本（comparePromptVersions 序）。 */
export function resolvePromptArtifact(
  registry: PromptArtifactRegistry,
  artifactId: string,
  version?: string,
): PromptArtifact | null {
  const candidates = registry.artifacts.filter((a) => a.artifactId === artifactId)
  if (candidates.length === 0) return null
  if (version !== undefined) {
    return candidates.find((a) => a.version === version) ?? null
  }
  return candidates.reduce((best, cur) => (comparePromptVersions(cur.version, best.version) > 0 ? cur : best))
}

// ============================================================================
// 门-提示词血缘（EB-1 证据链必要条件）
// ============================================================================

/** 门-提示词血缘记录（门结果 → 裁判工件 id@version）。 */
export interface GatePromptLineage {
  readonly gate: GateKey
  readonly verdict: "pass" | "fail"
  readonly artifactId: string
  readonly artifactVersion: string
  readonly contentHash: string
}

/** 绑定一次门运行到其裁判提示词工件（证据链卡片 EB-1 的 promptArtifact@version 来源）。 */
export function bindGateRunLineage(input: {
  readonly gate: GateKey
  readonly verdict: "pass" | "fail"
  readonly artifact: PromptArtifact
}): GatePromptLineage {
  return {
    gate: input.gate,
    verdict: input.verdict,
    artifactId: input.artifact.artifactId,
    artifactVersion: input.artifact.version,
    contentHash: input.artifact.contentHash,
  }
}

/** 工件 → 事件字段投影（写入 gate-run 事件 promptArtifactId/Version 的便捷层）。 */
export function artifactToEventRefs(artifact: PromptArtifact): {
  readonly promptArtifactId: string
  readonly promptArtifactVersion: string
} {
  return { promptArtifactId: artifact.artifactId, promptArtifactVersion: artifact.version }
}

/** 血缘覆盖检查结果（G1：LLM 中介门 rate 必须 = 1.0）。 */
export interface PromptLineageCoverage {
  /** LLM 中介的 gate-run 事件数。 */
  readonly llmMediatedGateRuns: number
  /** 已携带 promptArtifactId@version 的事件数。 */
  readonly bound: number
  /** 未携带血缘的 LLM 中介门事件（违规清单，seq + eventId）。 */
  readonly unbound: readonly { readonly seq: number; readonly eventId: string }[]
  /** bound / total；total=0 时恒 1（无 LLM 中介门运行平凡覆盖）。 */
  readonly rate: number
}

/**
 * 门-提示词血缘覆盖：账本中 kind=gate-run 且 payload.llmMediated===true 的事件
 * 必须携带 promptArtifactId 与 promptArtifactVersion（门结果 100% 携带裁判版本）。
 * 机械门（llmMediated 非 true）不参与此约束。
 */
export function checkPromptLineageCoverage(
  ledger: RunEventLedger,
  match?: { readonly replayId?: string },
): PromptLineageCoverage {
  const relevant =
    match?.replayId !== undefined ? eventsByReplayId(ledger, match.replayId) : ledger.events
  let total = 0
  let bound = 0
  const unbound: { seq: number; eventId: string }[] = []
  for (const event of relevant) {
    if (event.kind !== "gate-run" || !event.payload) continue
    const payload = event.payload as { llmMediated?: unknown }
    if (payload.llmMediated !== true) continue
    total += 1
    if (event.promptArtifactId !== undefined && event.promptArtifactVersion !== undefined) {
      bound += 1
    } else {
      unbound.push({ seq: event.seq, eventId: event.eventId })
    }
  }
  return {
    llmMediatedGateRuns: total,
    bound,
    unbound,
    rate: total === 0 ? 1 : bound / total,
  }
}

/** testRefs 缺失清单（工件无回归挂点 → 提示（不拒绝注册，留人工补齐）。 */
export function missingTestRefs(registry: PromptArtifactRegistry): readonly string[] {
  return registry.artifacts.filter((a) => a.testRefs.length === 0).map((a) => `${a.artifactId}@${a.version}`)
}

/** 事件血缘 → 血缘记录（gate-run 事件 + 仓库查 contentHash；无 → null）。 */
export function lineageOfGateRunEvent(
  event: RunEvent,
  registry: PromptArtifactRegistry,
): GatePromptLineage | null {
  const payload = event.payload as { gate?: unknown; status?: unknown } | undefined
  if (
    event.kind !== "gate-run" ||
    event.promptArtifactId === undefined ||
    event.promptArtifactVersion === undefined ||
    typeof payload?.gate !== "string" ||
    (payload.status !== "pass" && payload.status !== "fail")
  ) {
    return null
  }
  const artifact = resolvePromptArtifact(
    registry,
    event.promptArtifactId,
    event.promptArtifactVersion,
  )
  return {
    gate: payload.gate as GateKey,
    verdict: payload.status,
    artifactId: event.promptArtifactId,
    artifactVersion: event.promptArtifactVersion,
    contentHash: artifact?.contentHash ?? "",
  }
}

// ============================================================================
// 内部工具
// ============================================================================

/** 深度冻结（与 rule-stack.ts deepFreeze 同型；函数值跳过）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (!Object.isFrozen(value)) {
      Object.freeze(value)
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}