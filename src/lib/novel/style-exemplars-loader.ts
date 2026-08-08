/**
 * EPIC-001 / TASK-004 / ADR-29: Style Exemplars loader.
 *
 * F-001 将 de-ai 机制从单一反向排除（slop 词表）升级为双向：
 *   - Style Exemplars（正向锚点：用户标记的好段落）
 *   - slop（反向排除：de-ai-rules.ts 静态词表）
 *
 * exemplar 通过 contextPack 注入（buildContextPack → loadStyleExemplars），
 * de-ai-adapter 单次 pass 不变（ADR-29 选项 B：非新 LLM 调用）。
 *
 * HARD-2 Draft-first 例外（C-001 决议，ADR-29）：exemplar 是用户标记
 * 非 AI 产出，直接写入正式层 `.novel/style-exemplars.json`，不经 pending→accept
 * 流程。contextPack 注入从该正式层文件读取。
 *
 * PAT-DC1（CWE-532 日志脱敏）：损坏 JSON 抛脱敏异常（`style exemplars file
 * is corrupt`），不暴露 raw JSON 内容或文件路径。
 */
import { readFile, writeFileAtomic, createDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
// crypto.randomUUID 是 Web Crypto 全局 API，在渲染器（浏览器/Tauri webview）
// 与 vitest（Node ≥ 20）两端均可用，与 outline-chat-store.ts / analytics.ts
// 现有约定一致（无需 import）。

/**
 * exemplar 标记类型枚举（PAT-G2 镜像：与 markStyleExemplar 的 includes 检查一致）。
 * - `style`：整体文风好的段落
 * - `voice`：角色声线/对白毛边好的段落
 * - `pacing`：叙事节奏/停顿好的段落
 * - `thrill`：爽点兑现/压抑-释放好的段落（9 档语义锚）
 * - `pull`：追读引力/章末钩子/下一章承诺好的段落（9 档语义锚）
 */
export type StyleExemplarMarkType = "style" | "voice" | "pacing" | "thrill" | "pull" | "consistency"

/** style exemplar 单条记录。 */
export interface StyleExemplar {
  exemplarId: string
  chapterId: string
  text: string
  markType: StyleExemplarMarkType
  note?: string
  createdAt: string
}

/** exemplar 存储文件名（相对 .novel/）。 */
const STYLE_EXEMPLARS_FILENAME = "style-exemplars.json"

/** 单 exemplar 文本截断上限（token 预算保护，buildContextPack 注入前）。 */
export const STYLE_EXEMPLAR_TEXT_MAX_CHARS = 2000

/** 注入 contextPack 的 top-K exemplar 数量（覆盖 5 类 markType 多样性；ADR-29 token 预算仍受单条截断约束）。 */
export const STYLE_EXEMPLARS_TOP_K = 6

/** 合法 markType 集合（枚举校验）。 */
const VALID_MARK_TYPES: readonly StyleExemplarMarkType[] = ["style", "voice", "pacing", "thrill", "pull", "consistency"]

/**
 * 校验 markType 枚举值。非法值抛错（PAT-G2 镜像：枚举校验，防止
 * loadNovelDraftArtifact/loadNovelSessionStatus 同形 twin 漏检模式）。
 */
function assertValidMarkType(markType: string): asserts markType is StyleExemplarMarkType {
  if (!VALID_MARK_TYPES.includes(markType as StyleExemplarMarkType)) {
    throw new Error(`invalid markType: ${markType}`)
  }
}

/**
 * 解包装 exemplar 数据（FIX-2/EC-1：双格式兼容）。
 *
 * 接受两种合法形状：
 *   1. 裸数组（QMAI 自写格式）：[{exemplarId, chapterId, text, markType, note?, createdAt}]
 *   2. 包装对象（v1.0 人工/第三方版式）：{$schema, exemplars: [{id, chapterId, text, markType, note?, markedAt}]}
 *
 * 两者都不是 → 返回 null（调用方判 corrupt）。
 */
function unwrapExemplars(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { exemplars?: unknown[] }).exemplars)
  ) {
    return (parsed as { exemplars: unknown[] }).exemplars
  }
  return null
}

/**
 * 字段别名归一化（FIX-2/EC-1：v1.0 版式 id→exemplarId、markedAt→createdAt）。
 *
 * 新格式字段优先；旧格式（id/markedAt）映射补齐；其余字段原样保留。
 */
function normalizeExemplar(e: Record<string, unknown>): StyleExemplar {
  return {
    exemplarId: String(e.exemplarId ?? e.id ?? ""),
    chapterId: String(e.chapterId ?? ""),
    text: String(e.text ?? ""),
    markType: (VALID_MARK_TYPES.includes(String(e.markType)) ? String(e.markType) : e.markType) as StyleExemplarMarkType,
    note: typeof e.note === "string" ? e.note : undefined,
    createdAt: String(e.createdAt ?? e.markedAt ?? ""),
  }
}

/**
 * 加载项目级 style exemplars。
 *
 * - 缺失文件 → 返回 `[]`（优雅降级，非阻断 — 项目未标记过 exemplar 是常态）
 * - 损坏 JSON（解析失败或形状不合法）→ 抛脱敏异常（PAT-DC1：不暴露 raw JSON / 文件路径）
 * - 兼容裸数组与 {$schema, exemplars:[...]} 包装两种格式（FIX-2/EC-1）
 *
 * @param projectPath 项目根目录
 * @returns exemplar 列表（空项目返回空数组）
 */
export async function loadStyleExemplars(projectPath: string): Promise<StyleExemplar[]> {
  const pp = normalizePath(projectPath)
  const filePath = `${pp}/.novel/${STYLE_EXEMPLARS_FILENAME}`
  let raw: string
  try {
    raw = await readFile(filePath)
  } catch {
    // 缺失文件是常态（项目未标记过 exemplar）— 优雅降级返回空数组。
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // PAT-DC1（CWE-532 脱敏）：抛脱敏异常，不暴露 raw JSON 内容或文件路径。
    throw new Error("style exemplars file is corrupt")
  }
  const arr = unwrapExemplars(parsed)
  if (arr === null) {
    // 既非数组也非带 exemplars 字段的包装对象 — 视为损坏（PAT-DC1 脱敏）。
    throw new Error("style exemplars file is corrupt")
  }
  return arr.map((e) => normalizeExemplar(e as Record<string, unknown>))
}

/**
 * 标记一段文本为 style exemplar 并持久化（Draft-first 例外 C-001，直写正式层）。
 *
 * read-modify-write：读现有 exemplars，append 新 exemplar（exemplarId 用
 * crypto.randomUUID），原子写回。markType 枚举校验非法值抛错。
 *
 * @param projectPath 项目根目录
 * @param mark        exemplar 标记负载（chapterId / text / markType / note?）
 */
export async function markStyleExemplar(
  projectPath: string,
  mark: { chapterId: string; text: string; markType: StyleExemplarMarkType; note?: string },
): Promise<void> {
  assertValidMarkType(mark.markType)
  const pp = normalizePath(projectPath)
  const filePath = `${pp}/.novel/${STYLE_EXEMPLARS_FILENAME}`

  // read-modify-write：读取现有 exemplars（缺失文件视为空列表），append 新条目。
  // FIX-2/EC-1：读路径与 load 同解包装（裸数组 + {$schema, exemplars} 包装都认），
  // 避免把合法包装对象误判为损坏而重建覆盖（F2 数据丢失修复）。
  let existing: StyleExemplar[] = []
  try {
    const raw = await readFile(filePath)
    const parsed = JSON.parse(raw)
    const arr = unwrapExemplars(parsed)
    if (arr !== null) existing = arr.map((e) => normalizeExemplar(e as Record<string, unknown>))
  } catch {
    // 文件缺失或真正损坏（JSON 解析失败） — 视为空列表，重建存储（不阻断标记操作）。
    // 注意：损坏文件不抛错是因为用户标记是显式意图，重建是安全降级
    // （与 loadStyleExemplars 的损坏抛错不同：load 是被动消费，mark 是主动写入）。
    existing = []
  }

  const exemplar: StyleExemplar = {
    exemplarId: crypto.randomUUID(),
    chapterId: mark.chapterId,
    text: mark.text,
    markType: mark.markType,
    note: mark.note,
    createdAt: new Date().toISOString(),
  }

  const next = [...existing, exemplar]
  await createDirectory(`${pp}/.novel`)
  await writeFileAtomic(filePath, JSON.stringify(next, null, 2))
}

/**
 * 从 exemplar 列表选择 top-K（ADR-29 Consequences 负面项：exemplar 有效负载
 * MUST 在 token 预算内，否则挤占 plot/character 上下文）。
 *
 * 排名策略（markType 多样性优先）：
 *   1. 每个 markType 先取 1 个（按 createdAt desc 选最新），保证多样性
 *   2. 剩余配额按 createdAt desc 补齐至 top-K
 *   3. 单 exemplar text 截断至 STYLE_EXEMPLAR_TEXT_MAX_CHARS（2000 chars）
 *
 * 缺失 createdAt 按 epoch(0) 处理（旧数据兜底）。
 */
export function pickTopKExemplars(exemplars: StyleExemplar[], topK: number = STYLE_EXEMPLARS_TOP_K): StyleExemplar[] {
  if (exemplars.length === 0) return []

  const byType = new Map<StyleExemplarMarkType, StyleExemplar[]>()
  for (const ex of exemplars) {
    if (!VALID_MARK_TYPES.includes(ex.markType)) continue
    const bucket = byType.get(ex.markType) ?? []
    bucket.push(ex)
    byType.set(ex.markType, bucket)
  }

  // 每个 markType bucket 按 createdAt desc 排序（缺失 createdAt 排末尾）。
  const createdAtTs = (ex: StyleExemplar): number => {
    const t = Date.parse(ex.createdAt)
    return Number.isFinite(t) ? t : 0
  }
  for (const bucket of byType.values()) {
    bucket.sort((a, b) => createdAtTs(b) - createdAtTs(a))
  }

  // 第 1 轮：每个 markType 取最新 1 个（保证多样性），按 markType 声明顺序。
  const picked: StyleExemplar[] = []
  const remaining: StyleExemplar[] = []
  for (const markType of VALID_MARK_TYPES) {
    const bucket = byType.get(markType)
    if (!bucket || bucket.length === 0) continue
    picked.push(bucket[0])
    remaining.push(...bucket.slice(1))
  }
  // 剩余按 createdAt desc 补齐至 top-K。
  remaining.sort((a, b) => createdAtTs(b) - createdAtTs(a))
  for (const ex of remaining) {
    if (picked.length >= topK) break
    picked.push(ex)
  }

  // 截断文本（token 预算保护）+ 截断至 top-K。
  return picked.slice(0, topK).map((ex) => ({
    ...ex,
    text: ex.text.length > STYLE_EXEMPLAR_TEXT_MAX_CHARS
      ? ex.text.slice(0, STYLE_EXEMPLAR_TEXT_MAX_CHARS)
      : ex.text,
  }))
}
