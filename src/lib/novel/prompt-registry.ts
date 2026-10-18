/**
 * 提示词注册表（EPIC「提示词注册表 + 场景组合预览」的第一步：**只读登记**）。
 *
 * 真源就是 `PROMPTS`（`prompt-templates.ts`）——本模块不复制、不改写提示词，
 * 只做确定性枚举：键名、场景分组、**探测到的槽位数**、哨兵渲染预览。
 *
 * 诚实边界（每一条都对应一次审查发现）：
 * - `declaredParams`（`Function.length`）**不等于**参数个数：默认参数/剩余参数会被吞掉。
 *   因此另给 `slotCount`——用「多传一个哨兵是否改变输出」探测，能抓到默认参数槽位。
 * - 预览是**一次哨兵渲染**的结果，不代表所有分支：truthy 哨兵会绕过空值分支，
 *   读取全局 store 的片段（如输出语言指令）也会出现在预览里。这两点在面板上明示。
 * - 截断时列出窗口内**没出现**的槽位（`missingSlots`），不让人误以为提示词就这些字。
 * - 使用点统计与场景组合预览**没有**真源，故不提供，面板显式 N/A。
 */
import { PROMPTS } from "./prompt-templates"

/** 渲染预览时使用的哨兵（一眼能看出是占位符）。 */
export const PROMPT_PREVIEW_SENTINEL = (index: number) => `«arg${index + 1}»`

/** 预览最大字符数（注册表是索引，不是提示词全文存档）。 */
export const PROMPT_PREVIEW_MAX = 400

/** 槽位探测上限：超过这个数量就认为模板用了剩余参数，不再试探。 */
export const PROMPT_SLOT_PROBE_LIMIT = 8

export interface PromptRegistryEntry {
  /** `PROMPTS` 的键（稳定 id）。 */
  readonly id: string
  /** 场景分组（键名首段，如 `chapter` / `deep`）。 */
  readonly scene: string
  /** `Function.length`（会被默认参数/剩余参数低估；仅作参考）。 */
  readonly declaredParams: number
  /** 探测到的槽位数（多传一个哨兵输出会变 → 撞到新槽位）。 */
  readonly slotCount: number
  /** 是否存在被 `declaredParams` 低估的槽位。 */
  readonly slotCountExceedsDeclared: boolean
  /** 达到探测上限（可能还有更多，剩余参数）。 */
  readonly slotProbeCapped: boolean
  /** 哨兵渲染预览；渲染失败为 null（不造空串）。 */
  readonly preview: string | null
  readonly truncated: boolean
  /** 截断窗口内没出现的槽位（如 `«arg4»`）。 */
  readonly missingSlots: readonly string[]
  readonly error: string | null
}

export interface PromptRegistryGroup {
  readonly scene: string
  readonly entries: readonly PromptRegistryEntry[]
}

const SCENE_LABEL_FALLBACK = "misc"

type PromptSource = Record<string, ((...args: unknown[]) => unknown) | undefined>

/** 键名 → 场景分组（`chapterGeneration` → `chapter`；无驼峰前缀 → `misc`）。 */
export function promptSceneOf(id: string): string {
  const match = /^([a-z]+)[A-Z]/.exec(id)
  return match?.[1] ?? SCENE_LABEL_FALLBACK
}

/** 用 n 个哨兵渲染；抛错 → `{ ok:false, message }`（保留真实原因，不吞成 null）。 */
function renderWith(
  fn: (...args: unknown[]) => unknown,
  n: number,
): { ok: true; text: string } | { ok: false; message: string } {
  try {
    const args = Array.from({ length: n }, (_unused, index) => PROMPT_PREVIEW_SENTINEL(index))
    const rendered = fn(...args)
    if (typeof rendered === "string") return { ok: true, text: rendered }
    return { ok: true, text: rendered === undefined ? "" : String(rendered) }
  } catch (caught) {
    return { ok: false, message: caught instanceof Error ? caught.message : String(caught) }
  }
}

/**
 * 探测槽位数：从 `Function.length` 起，每多传一个哨兵看输出是否变化。
 * 变化说明该位置是**默认参数**（未被 length 计入）；不变化说明已到真末尾。
 */
export function probeSlotCount(fn: (...args: unknown[]) => unknown): { slotCount: number; capped: boolean } {
  const declared = fn.length
  const first = renderWith(fn, declared)
  if (!first.ok) return { slotCount: declared, capped: false }
  let current = first.text
  let slotCount = declared
  for (let n = declared + 1; n <= PROMPT_SLOT_PROBE_LIMIT; n += 1) {
    const next = renderWith(fn, n)
    if (!next.ok) break
    if (next.text === current) break
    slotCount = n
    current = next.text
  }
  return { slotCount, capped: slotCount === PROMPT_SLOT_PROBE_LIMIT }
}

/** 枚举注册表（key 码点排序稳定；不读磁盘、不调 LLM）。 */
export function listPromptRegistry(source: PromptSource = PROMPTS as unknown as PromptSource): PromptRegistryEntry[] {
  const entries: PromptRegistryEntry[] = []
  for (const id of Object.keys(source).sort()) {
    const fn = source[id]
    if (typeof fn !== "function") continue
    const { slotCount, capped } = probeSlotCount(fn)
    let preview: string | null = null
    let error: string | null = null
    const rendered = renderWith(fn, slotCount)
    if (!rendered.ok) {
      error = `哨兵渲染抛错：${rendered.message}`
    } else if (rendered.text.length === 0) {
      error = "哨兵渲染结果为空字符串"
    } else {
      preview = rendered.text.slice(0, PROMPT_PREVIEW_MAX)
    }
    const truncated = rendered.ok && rendered.text.length > PROMPT_PREVIEW_MAX
    const missingSlots = truncated
      ? Array.from({ length: slotCount }, (_unused, index) => PROMPT_PREVIEW_SENTINEL(index)).filter(
          (sentinel) => !(preview ?? "").includes(sentinel),
        )
      : []
    entries.push({
      id,
      scene: promptSceneOf(id),
      declaredParams: fn.length,
      slotCount,
      slotCountExceedsDeclared: slotCount > fn.length,
      slotProbeCapped: capped,
      preview,
      truncated,
      missingSlots,
      error,
    })
  }
  return entries
}

/** 按场景分组（组与组内均按 id 码点排序，UI 不抖动）。 */
export function groupPromptRegistry(entries: readonly PromptRegistryEntry[]): PromptRegistryGroup[] {
  const byScene = new Map<string, PromptRegistryEntry[]>()
  for (const entry of entries) {
    const bucket = byScene.get(entry.scene)
    if (bucket) bucket.push(entry)
    else byScene.set(entry.scene, [entry])
  }
  const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return [...byScene.entries()]
    .sort((a, b) => byCodePoint(a[0], b[0]))
    .map(([scene, group]) => ({ scene, entries: [...group].sort((a, b) => byCodePoint(a.id, b.id)) }))
}
