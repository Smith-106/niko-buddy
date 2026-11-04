/**
 * confirmed-plan-store.ts — 章节计划原文的持久化（TASK-004 / DEC-R4=A）。
 *
 * ## 这是什么 / 这不是什么（先划线）
 *
 * 产品上**不存在**「用户确认过的计划」这一实体：计划协议只活在提示词文本里
 * （build-system-prompt-plugin 的 planBlueprint 段），相关插件零生产调用，也没有确认 UI。
 * 因此本模块持久化的**不是**「用户确认的计划」，而是「模型这次在 run_chapter_workflow
 * 的 tool_call 参数里自带的那份计划原文」——DEC-R4=A 只承诺「模型带过的计划被持久化
 * 以供复用」，不承诺任何确认语义。文件名/API 沿用既有 `planBlueprint` 口径，不夸大成确认。
 *
 * ## 边界声明：一处受控元数据写入例外
 *
 * 「深章工具零写盘」是既有边界——`run_chapter_workflow` 只生成正文，落盘一律交给
 * 写入工具 + 用户确认。本模块是给该边界引入的**受控元数据写入例外**，且是唯一一处：
 *   - 只写计划原文（Markdown 文本本身）；
 *   - 不写任何运行状态：无 ok/status/rounds/时间戳/章节正文/审稿结论/门禁结论，
 *     也没有任何字段参与后续生成链的输入决策；
 *   - 写失败不阻断生成（降级点唯一，在调用点 run-chapter-workflow 的 catch 里）。
 *
 * ## 落盘契约
 *
 *   路径：`{projectPath}/.novel/plans/chapter-<N>.md`
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
 * 保存一章的计划原文（原子覆盖写）。
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
): Promise<void> {
  if (!isValidChapterNumber(chapterNumber)) return
  if (typeof plan !== "string" || plan.trim() === "") return
  const dir = confirmedPlanDirPath(projectPath)
  await createDirectory(dir)
  // 原子写：临时文件 + rename，杜绝半写状态（覆盖写同章即整体替换）。
  await writeFileAtomic(`${dir}/chapter-${chapterNumber}.md`, plan)
}

/**
 * 读回一章的计划原文。
 *
 * 三种「读不到」统一降级为 undefined，且**不伪造**计划：
 *   - 章节号非法 → undefined（不拼路径、不读盘）；
 *   - 文件不存在 → undefined（正常情况：这一章还没被生成过，不是错误，故不记日志）；
 *   - 读取失败 / 内容为纯空白 → 记 warn 后 undefined（真异常不静默）。
 *
 * 返回的是文件原文（不 trim、不改写），保证中文/emoji/换行的往返逐字符一致。
 */
export async function loadConfirmedPlan(
  projectPath: string,
  chapterNumber: number,
): Promise<string | undefined> {
  if (!isValidChapterNumber(chapterNumber)) return undefined
  const path = confirmedPlanPath(projectPath, chapterNumber)
  try {
    if (!(await fileExists(path))) return undefined
    const raw = await readFile(path)
    if (raw.trim() === "") {
      console.warn(`[confirmed-plan-store] 计划文件为空白，按无计划降级: ${path}`)
      return undefined
    }
    return raw
  } catch (error) {
    console.warn(`[confirmed-plan-store] 读取计划失败（按无计划降级）: ${path}`, error)
    return undefined
  }
}
