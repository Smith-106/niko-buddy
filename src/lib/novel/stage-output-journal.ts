/**
 * stage-output-journal.ts — 编排面 LLM 工件缓存（T18 组件 1 / 蓝图 §6 T18）。
 *
 * ## 职责
 *   编排面（task-router / deep-chapter-generation 等主循环）对同一「指令 digest」的
 *   LLM 产物做去重缓存：同一条指令（稳定序列化后内容相同 → SHA-256 digest 相同）的
 *   输出工件落地 `.novel/journal/[digest].jsonl`，进程崩溃 / 重启 / 重复调用时
 *   **命中缓存直接复用，跳过昂贵的 LLM 重调用**。这是 T08 stage-output journal 工件的
 *   持久化背靠（checkpoint-digest.ts 的 ADR-19 说明中对该 usage 的落点）。
 *
 *   1. **指令 digest 键工件缓存**：以 T07 `computeCheckpointDigestOf(` + `stableStringify`
 *      派生的 SHA-256 digest 为幂等键；JSONL 每行一条工件记录。
 *   2. **命中 / 未命中 / TTL**：`loadJournalEntry` 在缓存文件中按 `digest + stage` 查找；
 *      找到且未过期（`expiresAt > now`，默认 T+1h）→ 返回命中记录（真正的 LLM 产物）；
 *      找不到 / 已过期 → 返回 `null`，调用方走 LLM 重新生产。
 *   3. **save 后崩溃命中跳过重调**：`saveJournalEntry` 原子写回缓存，随后进程崩溃 /
 *      重启，再以同一 digest 调用 `loadJournalEntry` 即命中，编排层不再重调 LLM。
 *
 * ## Draft-first
 *   本模块是纯机械/控制层（零 LLM、零网络，仅文件 IO + 缓存判定），不涉及 AI 写作，
 *   Draft-first 不适用。缓存只针对被调用方已确认的 LLM 产物做持久化留存。
 *
 * ## 可测性与依赖注入
 *   所有副作用（读/写/建目录）经 `StageJournalDeps` 注入；默认实现
 *   `defaultStageJournalDeps()` 走真实 `@/commands/fs`（原子写 + 建目录），单测用
 *   mock deps 覆盖全部分支。运行时路径在 `.novel/journal/`。
 *
 * 遵循 QMAI/CLAUDE.md：T18 组件 1 新增锚点，落 `src/lib/novel/`；运行期缓存 `.novel/`。
 */

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { computeCheckpointDigestOf } from "./checkpoint-digest"

// ──────────────────────────────────────────────────────────────────────────
// 常量 / 路径
// ──────────────────────────────────────────────────────────────────────────

/** `.novel/` 下的 journal 目录名。 */
export const JOURNAL_DIR_NAME = "journal"
/** 默认工件 TTL：T+1h。 */
export const JOURNAL_TTL_MS = 60 * 60 * 1000
/** 缓存记录 schema 版本号（用于日后兼容迁移）。 */
export const JOURNAL_SCHEMA_VERSION = 1

/**
 * 运行期 TTL 覆写值（ms）。默认 `null`（未覆写 → 用 `JOURNAL_TTL_MS`）。
 * 供配置面接线方经 `setJournalTtlMs` 写入；不写时行为与默认完全一致（零差异）。
 *
 * ⚠️ 技术债注记：[deep-chapter-generation.ts](/api/.../deep-chapter-generation.ts)
 * 是编排面唯一应接线 journal 的入口（他人 WIP 禁区，此处不予触碰）。后续接入点：
 *   `src/lib/novel/stage-output-journal.ts` 顶部调用 `setJournalTtlMs(config.ttlMs)`。
 * 现阶段以模块内 setter 作为安全接线面，任何配置对象解析都在该文件内完成，
 * 不把解析耦合进 `deep-chapter-generation.ts`。
 */
let journalTtlMsOverride: number | null = null

/** 安全接线面：设置编排面 cache TTL（ms）。传任意正数即全量生效；传 null 恢复默认。 */
export function setJournalTtlMs(ms: number | null): void {
  journalTtlMsOverride = ms
}

/** 生效 TTL：优先取配置覆写，未配置则回退默认 `JOURNAL_TTL_MS`（T+1h，零差异）。 */
export function effectiveJournalTtlMs(): number {
  return journalTtlMsOverride ?? JOURNAL_TTL_MS
}

/** 运行的 journal 目录：`{projectId}/.novel/journal/`。 */
export function journalDirPath(projectId: string): string {
  return `${normalizePath(projectId)}/.novel/${JOURNAL_DIR_NAME}`
}

/** 单条工件缓存文件：`{projectId}/.novel/journal/[digest].jsonl`。 */
export function journalFilePath(projectId: string, digest: string): string {
  return `${journalDirPath(projectId)}/${digest}.jsonl`
}

/** 取路径父目录（供 `createDirectory` 确保目录存在）。 */
export function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  return idx < 0 ? "." : p.slice(0, idx)
}

// ──────────────────────────────────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────────────────────────────────

/** 单条缓存工件记录（JSONL 一行）。 */
export interface StageOutputRecord {
  /** 指令 SHA-256 digest（幂等键）。 */
  digest: string
  /** 工件在指令流水线内的阶段/产物键（同一 digest 可含多个 stage 工件，互不覆盖）。 */
  stage: string
  /** 写入时 epoch ms。 */
  createdAt: number
  /** 过期时刻 epoch ms（createdAt + ttlMs）。 */
  expiresAt: number
  /** 生效 TTL ms（记录级，便于复现）。 */
  ttlMs: number
  /** schema 版本。 */
  schemaVersion: number
  /** LLM 产物本体（任意 JSON-compatible helmet 对象）。 */
  payload: unknown
}

/** 缓存 IO 依赖（全部副作用注入；默认实现见 `defaultStageJournalDeps`）。 */
export interface StageJournalDeps {
  /** 读文件（不存在/失败返回空串）。 */
  read: (path: string) => Promise<string>
  /** 原子写文件（先确保目录存在）。 */
  writeFile: (path: string, contents: string) => Promise<void>
  /** 建目录。 */
  createDirectory: (path: string) => Promise<void>
}

/**
 * 编排面缓存查询结果：`hit === true` → 直接使用 `record.payload`，跳 LLM；
 * `hit === false` → 未命中/已过期，调用方应重新生产后再 `saveJournalEntry` 落盘。
 */
export interface StageCacheLookup {
  hit: boolean
  /** 命中的记录（hit=true 时有值，且未过期）。 */
  record: StageOutputRecord | null
}

// ──────────────────────────────────────────────────────────────────────────
// 默认依赖（真实 fs 原子写）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 默认缓存依赖：真实 `@/fs` 原子写 + 建目录。
 * `read` 在文件不存在 / 读失败时吞掉返回空串（视为空缓存），与 projection-status-ledger
 * 同契约；`writeFile` 先建目录再原子写，崩溃不损坏缓存行。
 */
export function defaultStageJournalDeps(): StageJournalDeps {
  return {
    read: async (path: string): Promise<string> => {
      try {
        return await readFile(path)
      } catch {
        return ""
      }
    },
    writeFile: async (path: string, contents: string): Promise<void> => {
      await createDirectory(parentDir(path))
      await writeFileAtomic(path, contents)
    },
    createDirectory: async (path: string): Promise<void> => {
      await createDirectory(path)
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// digest 派生（T07 复用）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 由任意指令（内容对象，可含不稳定键序）派生 SHA-256 幂等键。
 * 复用 T07 `computeCheckpointDigestOf`（内部经 `stableStringify` 稳定化），
 * 同语义指令 → 同 digest → 命中同一缓存行。
 */
export async function computeInstructionDigest(instruction: unknown): Promise<string> {
  return computeCheckpointDigestOf(instruction)
}

// ──────────────────────────────────────────────────────────────────────────
// 记录构造 / 过期判定
// ──────────────────────────────────────────────────────────────────────────

/** 构造一条缓存记录：`expiresAt = createdAt + ttlMs`。 */
export function buildStageRecord(
  digest: string,
  stage: string,
  payload: unknown,
  now: number,
  ttlMs: number = effectiveJournalTtlMs(),
): StageOutputRecord {
  return {
    digest,
    stage,
    createdAt: now,
    expiresAt: now + ttlMs,
    ttlMs,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    payload,
  }
}

/** 过期判定：`expiresAt <= now` 视为过期（应视为未命中，重新走 LLM）。 */
export function isExpired(record: StageOutputRecord, now: number): boolean {
  return record.expiresAt <= now
}

// ──────────────────────────────────────────────────────────────────────────
// JSONL 解析
// ──────────────────────────────────────────────────────────────────────────

/**
 * 解析 JSONL 缓存内容为记录数组：跳过空行与畸形行（容错，坏行不阻断命中），
 * 校验基础字段（digest / stage / 数字时间戳）。返回按行序。
 */
export function parseJournalLines(raw: string): StageOutputRecord[] {
  const out: StageOutputRecord[] = []
  if (!raw) return out
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as StageOutputRecord
      if (
        parsed &&
        typeof parsed.digest === "string" &&
        typeof parsed.stage === "string" &&
        typeof parsed.createdAt === "number" &&
        typeof parsed.expiresAt === "number"
      ) {
        out.push(parsed)
      }
    } catch {
      // 畸形行：跳过（容错）
    }
  }
  return out
}

/**
 * 在解析出的记录集中查找 `digest + stage` 的最新（createdAt 最大）一条；无匹配返回 null。
 * 匹配后由 `loadJournalEntry` 再做 TTL 过期判定。
 */
export function findLatestRecord(
  records: StageOutputRecord[],
  digest: string,
  stage: string,
): StageOutputRecord | null {
  let latest: StageOutputRecord | null = null
  for (const r of records) {
    if (r.digest !== digest || r.stage !== stage) continue
    if (latest === null || r.createdAt > latest.createdAt) latest = r
  }
  return latest
}

// ──────────────────────────────────────────────────────────────────────────
// 写缓存（upsert 单行，保序）
// ──────────────────────────────────────────────────────────────────────────

/** JSONL 序列化一行。 */
export function serializeRecord(record: StageOutputRecord): string {
  return JSON.stringify(record)
}

/**
 * 以 `digest + stage` 为键 upsert 记录并写回 JSONL：先读现有文件（容错），解析，
 * 用新记录替换同 `digest + stage` 的旧行（保持其余行序），末尾补换行，原子写盘。
 * 返回写入后的行数。
 */
export async function saveJournalEntry(
  deps: StageJournalDeps,
  projectId: string,
  record: StageOutputRecord,
): Promise<number> {
  const file = journalFilePath(projectId, record.digest)
  const existing = parseJournalLines(await deps.read(file))
  const kept = existing.filter((r) => !(r.digest === record.digest && r.stage === record.stage))
  const rows = [...kept, record]
  const contents = rows.map(serializeRecord).join("\n") + "\n"
  await deps.writeFile(file, contents)
  return rows.length
}

// ──────────────────────────────────────────────────────────────────────────
// 读缓存（命中 / 未命中 / TTL）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 按 `digest + stage` 读缓存：
 *  - 文件缺失 / 空 → 未命中，返回 null（调用方走 LLM）。
 *  - 找到匹配但已过期（`expiresAt <= now`）→ 未命中，返回 null（重新走 LLM）。
 *  - 找到匹配且未过期 → 命中，返回该记录（工件直接复用，不重调 LLM）。
 */
export async function loadJournalEntry(
  deps: StageJournalDeps,
  projectId: string,
  digest: string,
  stage: string,
  now: number,
): Promise<StageOutputRecord | null> {
  const raw = await deps.read(journalFilePath(projectId, digest))
  const records = parseJournalLines(raw)
  const latest = findLatestRecord(records, digest, stage)
  if (latest === null) return null
  if (isExpired(latest, now)) return null
  return latest
}

// ──────────────────────────────────────────────────────────────────────────
// 编排面查询辅助
// ──────────────────────────────────────────────────────────────────────────

/**
 * 编排面单步 helper：尝试命中缓存，未命中则由 `producer` 生产并落盘，返回查询结果。
 * 便于 task-orchestrator / deep-chapter 薄编排组合：崩溃后同 digest 重入即命中
 * （`hit === true`），跳过 `producer`（即跳过 LLM 重调用）。
 */
export async function resolveStageOutput(
  deps: StageJournalDeps,
  projectId: string,
  digest: string,
  stage: string,
  producer: () => Promise<unknown>,
  now: number,
  ttlMs: number = effectiveJournalTtlMs(),
): Promise<StageCacheLookup> {
  const hit = await loadJournalEntry(deps, projectId, digest, stage, now)
  if (hit) return { hit: true, record: hit }
  const payload = await producer()
  const record = buildStageRecord(digest, stage, payload, now, ttlMs)
  await saveJournalEntry(deps, projectId, record)
  return { hit: false, record }
}