/**
 * confirmed-plan-store.ts — 章节计划原文的持久化（TASK-004 / DEC-R4=A；RVF-01 补来源标记）。
 *
 * ## 这是什么 / 这不是什么（先划线）
 *
 * 产品上**不存在**「用户确认过的计划」这一实体：计划协议只活在提示词文本里
 * （build-system-prompt-plugin 的 planBlueprint 段），相关插件零生产调用，也没有确认 UI。
 * 因此本模块持久化的**不是**「用户确认的计划」，而是「模型这次在 run_chapter_workflow
 * 的 tool_call 参数里自带的那份计划原文」——DEC-R4=A 只承诺「模型带过的计划被持久化
 * 以供复用」，不承诺任何确认语义。文件名/API 沿用既有 `planBlueprint` 口径，不夸大成确认。
 *
 * ## RVF-01：来源必须随文本一起落盘（否则下游只能猜，而猜错的方向是伪造权威）
 *
 * 复核发现：落盘的真源是模型自拟散文，但消费端（deep-chapter-prompts 的计划段标题）
 * 把它一律标成「用户已确认的强制约束」。后果是一份从未被用户确认、可能已与上版正文
 * 无关的模型文本，在该章**每次**运行时被当硬约束锁死。修法是把「谁写的」作为**数据**
 * 落盘并回读，而不是由消费端假定：
 *
 *   source === "user"  → 才允许强口径（用户已确认的强制约束）
 *   source === "model" → 中性口径（上一轮模型自拟的参考，未经用户确认）
 *
 * 本模块目前**没有**写入 "user" 的生产调用点（没有确认 UI），`saveConfirmedPlan` 的
 * 缺省 source 就是 `"model"`——最弱的权威，也是唯一诚实的缺省。
 *
 * ## 落盘格式与向后兼容（不做破坏性迁移）
 *
 *   路径：`{projectPath}/.novel/plans/chapter-<N>.md`（不变）
 *   内容：极简 frontmatter + 正文原文
 *
 *     ---
 *     source: model
 *     savedAt: 2026-05-05T10:00:00.000Z
 *     ---
 *     <计划原文，逐字节保留>
 *
 *   **旧文件（没有 frontmatter）读成 `source: "model"`、`savedAt: ""`**：
 *   历史文件全是模型写进去的，按 "model" 归属才是事实；时间未知就留空，
 *   不伪造时间戳。识别 frontmatter 的条件刻意收紧（首行必须恰好是 `---`、
 *   后续行必须是已知 key 的 `key: value`、闭合行在前 5 行内），因此正文以 Markdown
 *   水平线 `---` 开头的旧文件不会被误切（未知 key 即判为旧格式，整份内容都是计划）。
 *
 * ## 边界声明：一处受控元数据写入例外
 *
 * 「深章工具零写盘」是既有边界——`run_chapter_workflow` 只生成正文，落盘一律交给
 * 写入工具 + 用户确认。本模块是给该边界引入的**受控元数据写入例外**，且是唯一一处：
 *   - 只写计划原文 + 两个描述性标记（source / savedAt）；
 *   - 不写任何运行状态：无 ok/status/rounds/章节正文/审稿结论/门禁结论，
 *     也没有任何字段参与后续生成链的输入决策（source 只影响措辞口径，不影响内容取舍，
 *     更不反过来把「模型自拟」升格成「用户已确认」——降级方向是单向的）；
 *   - 写失败不阻断生成（降级点唯一，在调用点 run-chapter-workflow 的 catch 里）。
 *
 * ## 落盘契约细节
 *
 *   写：`createDirectory` → `writeFileAtomic`（后端临时文件 + fsync + rename，
 *       因此不存在「读到半写文件」的状态；覆盖写同章即整体替换）
 *   读：`fileExists` → `readFile`；文件不存在 / 读取失败一律 undefined（不抛、不造假）
 *
 * 风格对齐既有先例：写路径参考 `main-control-trace.ts` 的 saveTraceSnapshot
 * （createDirectory → 写 → best-effort），但写入原语升级为 writeFileAtomic 以满足
 * 「原子写」要求；读路径参考同文件的 loadTraceSnapshot（读失败不抛、区分「没有」与「坏了」）。
 */
import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/** 计划原文目录（项目根下，相对路径）。 */
export const CONFIRMED_PLAN_DIR = ".novel/plans"

/**
 * 计划文本的来源（RVF-01）。
 *
 * - `"model"`：模型在 `run_chapter_workflow` 的 tool_call 里自带（或会话层从模型产物
 *   兜底取到）的散文。**未经用户确认**，消费端只能当参考。
 * - `"user"`：用户确认过的计划。当前没有生产写入点（无确认 UI），保留类型是为了让
 *   「谁能用强口径」由数据说话，而不是由消费端假定。
 */
export type ConfirmedPlanSource = "model" | "user"

/** 一章计划记录：原文 + 来源 + 保存时间。 */
export interface ConfirmedPlanRecord {
  /** 计划原文（逐字节保留，不 trim、不改写）。 */
  readonly plan: string
  /** 来源。旧文件（无标记）一律 `"model"`。 */
  readonly source: ConfirmedPlanSource
  /** ISO 保存时间；旧文件没有该字段时为 `""`（未知，不伪造）。 */
  readonly savedAt: string
}

const FRONTMATTER_DELIMITER = "---"
const FRONTMATTER_SOURCE_KEY = "source"
const FRONTMATTER_SAVED_AT_KEY = "savedAt"
/**
 * 头部最多扫几行。真实头部固定 2 行（source + savedAt）；放宽到 5 行只为容忍将来
 * 追加字段。超出即判「不是本模块的头部」——这是防误切的第二道闸。
 */
const MAX_FRONTMATTER_LINES = 5

/**
 * 章节号合法性：正整数。
 * 0 / 负数 / 小数 / NaN / Infinity 都不是合法章节，一律不写盘也不读盘
 * （否则会造出 `chapter-0.md` / `chapter-NaN.md` 这类无人消费的脏文件）。
 */
function isValidChapterNumber(chapterNumber: number): boolean {
  return typeof chapterNumber === "number" && Number.isInteger(chapterNumber) && chapterNumber > 0
}

function normalizedProjectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

/** 计划目录绝对路径（项目根下 `.novel/plans`）。 */
export function confirmedPlanDirPath(projectPath: string): string {
  return `${normalizedProjectRoot(projectPath)}/${CONFIRMED_PLAN_DIR}`
}

/** 单章计划文件路径：`.novel/plans/chapter-<N>.md`。 */
export function confirmedPlanPath(projectPath: string, chapterNumber: number): string {
  return `${confirmedPlanDirPath(projectPath)}/chapter-${chapterNumber}.md`
}

/**
 * 运行时兜底：任何非 "user" 的输入（含缺失 / 拼错 / 旧文件）都归为 "model"。
 * 降级方向单向——绝不会把模型自拟文本升格成「用户已确认」。
 */
function normalizeSource(source: string | undefined): ConfirmedPlanSource {
  return source === "user" ? "user" : "model"
}

/** 序列化：frontmatter + 原文（原文逐字节保留，含 CRLF / 前后空白）。 */
function serializePlanRecord(plan: string, source: ConfirmedPlanSource, savedAt: string): string {
  return [
    FRONTMATTER_DELIMITER,
    `${FRONTMATTER_SOURCE_KEY}: ${source}`,
    `${FRONTMATTER_SAVED_AT_KEY}: ${savedAt}`,
    FRONTMATTER_DELIMITER,
    "",
  ].join("\n") + plan
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line
}

/**
 * 解析落盘内容（RVF-01 的向后兼容核心）。
 *
 * 没有 frontmatter（旧文件）→ 整份内容都是计划，`source: "model"`、`savedAt: ""`。
 * 头部只要有一行不像已知 `key: value`（或闭合分隔线不在前 5 行内）→ 同样按旧格式处理。
 * 因此本函数永不会「吃掉」正文：最坏情况是把带头的文件整份当计划，那也只是保守（
 * 消费端仍按 model 的中性口径展示）。
 */
function parsePlanRecord(raw: string): ConfirmedPlanRecord {
  const legacy: ConfirmedPlanRecord = { plan: raw, source: "model", savedAt: "" }
  const firstNewline = raw.indexOf("\n")
  const firstLine = firstNewline < 0 ? raw : raw.slice(0, firstNewline)
  if (stripCarriageReturn(firstLine) !== FRONTMATTER_DELIMITER) return legacy
  if (firstNewline < 0) return legacy

  const fields = new Map<string, string>()
  let cursor = firstNewline + 1
  for (let scanned = 0; scanned < MAX_FRONTMATTER_LINES; scanned += 1) {
    const newline = raw.indexOf("\n", cursor)
    const lineEnd = newline < 0 ? raw.length : newline
    const line = stripCarriageReturn(raw.slice(cursor, lineEnd))
    const nextCursor = newline < 0 ? raw.length : newline + 1
    if (line === FRONTMATTER_DELIMITER) {
      // 一个字段也没读到（例如正文以连续两条 Markdown 水平线开头）→ 不是本模块的头，
      // 整份内容都是计划。宁可误判为旧格式（保守：不删任何正文），也不删用户正文。
      if (fields.size === 0) return legacy
      const body = raw.slice(nextCursor)
      return {
        plan: body,
        source: normalizeSource(fields.get(FRONTMATTER_SOURCE_KEY)),
        savedAt: fields.get(FRONTMATTER_SAVED_AT_KEY) ?? "",
      }
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!match) return legacy
    const key = match[1]
    if (key !== FRONTMATTER_SOURCE_KEY && key !== FRONTMATTER_SAVED_AT_KEY) return legacy
    fields.set(key, match[2].trim())
    if (newline < 0) return legacy
    cursor = nextCursor
  }
  return legacy
}

/**
 * 保存一章的计划原文（原子覆盖写）。
 *
 * RVF-01：`source` 缺省 `"model"`——本模块没有「用户确认」的写入路径，缺省值必须是
 * 最弱的权威。显式传 `"user"` 只在将来真有确认 UI 时才有意义。
 *
 * 守卫（任一命中即直接 return，不产生任何写盘动作）：
 *   - `chapterNumber` 非正整数；
 *   - `plan` 不是字符串、或为空/纯空白（空计划没有复用价值，写盘只会留下假工件）。
 *
 * 写盘失败**向上抛**：本模块不吞错，降级责任收在唯一调用点
 * （run-chapter-workflow 的 catch → 记 warn → 继续生成），避免「静默丢弃」。
 */
export async function saveConfirmedPlan(
  projectPath: string,
  chapterNumber: number,
  plan: string,
  source: ConfirmedPlanSource = "model",
): Promise<void> {
  if (!isValidChapterNumber(chapterNumber)) return
  if (typeof plan !== "string" || plan.trim() === "") return
  const dir = confirmedPlanDirPath(projectPath)
  await createDirectory(dir)
  const record = serializePlanRecord(plan, normalizeSource(source), new Date().toISOString())
  // 原子写：临时文件 + rename，杜绝半写状态（覆盖写同章即整体替换）。
  await writeFileAtomic(`${dir}/chapter-${chapterNumber}.md`, record)
}

/**
 * 读回一章的计划记录（原文 + 来源 + 保存时间）。
 *
 * 三种「读不到」统一降级为 undefined，且**不伪造**计划：
 *   - 章节号非法 → undefined（不拼路径、不读盘）；
 *   - 文件不存在 → undefined（正常情况：这一章还没被生成过，不是错误，故不记日志）；
 *   - 读取失败 / 正文为纯空白 → 记 warn 后 undefined（真异常不静默）。
 *
 * 返回的计划是正文原文（不 trim、不改写），保证中文/emoji/换行的往返逐字符一致。
 * 旧文件（无 frontmatter）读成 `source: "model"`、`savedAt: ""`（见 parsePlanRecord）。
 */
export async function loadConfirmedPlanRecord(
  projectPath: string,
  chapterNumber: number,
): Promise<ConfirmedPlanRecord | undefined> {
  if (!isValidChapterNumber(chapterNumber)) return undefined
  const path = confirmedPlanPath(projectPath, chapterNumber)
  try {
    if (!(await fileExists(path))) return undefined
    const raw = await readFile(path)
    const record = parsePlanRecord(raw)
    if (record.plan.trim() === "") {
      console.warn(`[confirmed-plan-store] 计划文件为空白，按无计划降级: ${path}`)
      return undefined
    }
    return record
  } catch (error) {
    console.warn(`[confirmed-plan-store] 读取计划失败（按无计划降级）: ${path}`, error)
    return undefined
  }
}

/**
 * 读回一章的计划原文（兼容入口：只要文本，不要来源）。
 *
 * 保留是因为它是本模块的既有公开签名；需要「谁写的」的调用点必须改用
 * `loadConfirmedPlanRecord`——只取文本就无法按来源区分口径（RVF-01）。
 */
export async function loadConfirmedPlan(
  projectPath: string,
  chapterNumber: number,
): Promise<string | undefined> {
  const record = await loadConfirmedPlanRecord(projectPath, chapterNumber)
  return record?.plan
}
