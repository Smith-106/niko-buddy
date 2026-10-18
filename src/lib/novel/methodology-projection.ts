/**
 * 创作方法论生效可视化 —— 只读投影层（EPIC「创作方法论生效可视化」）。
 *
 * 真源只有一个：`novel-skill-hooks.ts` 的**进程内钩子注册表**
 * （`getNovelSkillHookRegistry()` / `listNovelSkillHooksForStage(stage)`）。
 * 本模块**不新建任何状态**、不写盘、不调 LLM、**不执行钩子**：只把注册表里已经声明的
 * 东西枚举成确定性表格（码点排序，可重复投影得到同一结果）。
 *
 * 诚实边界（缺真源的字段一律 `null` + `missingSources` 明示，不估算、不造 0）：
 * - **命中/触发次数**：注册表只声明钩子，不记录 `run` 历史 → `triggerCount` 恒 `null`。
 * - **promptHint 有无**：`NovelSkillHook` 上**没有** `promptHint` 字段（该名字只出现在
 *   `createGoldScaleReadinessHook(promptHint)` 的闭包参数与 `literary-gold-scale` 的结果对象上，
 *   注册表读不到）→ `hasPromptHint` 恒 `null`。注意 `null` = **无真源**，**不是** `false`：
 *   `false` 会谎称「确定没有」。
 * - **阶段实际注入的 promptFragments/notes**：只有真实 `NovelSkillContext` 跑一遍才会产生，
 *   只读投影不执行钩子，故不提供。
 * - **空注册表 → 空数组**：候选阶段只从「钩子声明过的 stage」里取，没有钩子就没有行，
 *   不造 0 行假装统计过。
 */

import {
  getNovelSkillHookRegistry,
  listNovelSkillHooksForStage,
  type NovelSkillStage,
} from "./novel-skill-hooks"

/** 码点稳定比较（**不用** `localeCompare`：locale/ICU 会影响顺序，投影必须可复现）。 */
function compareCodePoint(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * 已知阶段全集 —— `NovelSkillStage` 联合类型的**镜像**（不是新真源：真源是该联合本身）。
 * 只用于面板说明「联合里声明了 N 个阶段，当前注册表命中 M 个」，
 * 不参与造行（行只来自注册表里真实声明过的 stage）。
 */
const METHODOLOGY_STAGE_UNIVERSE = [
  "pre_outline_soft_gate",
  "pre_write_prompt",
  "post_draft_light_check",
  "pre_six_dim_review",
  "post_gate_literary_polish",
] as const satisfies ReadonlyArray<NovelSkillStage>

/** 漏镜像的阶段（正常为 `never`）。 */
type UnmirroredStage = Exclude<NovelSkillStage, (typeof METHODOLOGY_STAGE_UNIVERSE)[number]>

/**
 * 编译期穷尽断言（恒 `true`，无运行时含义）：`NovelSkillStage` 一旦新增成员却没同步进
 * `METHODOLOGY_STAGE_UNIVERSE`，`UnmirroredStage` 不再是 `never`，本行立刻编译报错 ——
 * 新阶段不会静默消失在面板之外。
 */
export const METHODOLOGY_STAGE_UNIVERSE_COMPLETE: UnmirroredStage extends never ? true : false = true

/** 本投影**缺**的真源清单（面板据此渲染显式 N/A，不伪装成已有功能）。 */
export const METHODOLOGY_MISSING_SOURCES = [
  "hook 触发/命中次数（无埋点真源：注册表只声明钩子，不记录 run 历史）",
  "每个钩子的 promptHint（NovelSkillHook 无 promptHint 字段，注册表读不到）",
  "阶段实际注入的 promptFragments/notes（需真实 NovelSkillContext 才会产生，只读投影不执行钩子）",
] as const

export interface MethodologyStageRow {
  /** 阶段（deep-chapter 挂载点，取自 `NovelSkillStage`）。 */
  readonly stage: NovelSkillStage
  /** 该阶段**实际会生效**的钩子数（`listNovelSkillHooksForStage`，已排除 `enabled: false`）。 */
  readonly hookCount: number
  /** 该阶段被**声明**的钩子数（含 `enabled: false`；`> hookCount` 说明有钩子未启用）。 */
  readonly declaredHookCount: number
  /** 生效钩子 id（码点升序）。 */
  readonly hookIds: readonly string[]
  /**
   * 该阶段是否有 promptHint：**恒 `null`** —— 无真源（`NovelSkillHook` 无该字段）。
   * `null` 表示「不知道」，不是「没有」。
   */
  readonly hasPromptHint: boolean | null
  /**
   * 命中/触发次数：**恒 `null`** —— 无埋点真源（不估算、不造 0）。
   */
  readonly triggerCount: number | null
}

export interface MethodologyProjection {
  /**
   * 每个「注册表里声明过钩子的 stage」一行，按 stage 码点升序。
   * 空注册表 → **空数组**（不造行）。
   */
  readonly stages: readonly MethodologyStageRow[]
  /** `NovelSkillStage` 联合里声明的全部阶段（码点升序），供面板显示「已知 N 个阶段」。 */
  readonly knownStages: readonly NovelSkillStage[]
  /** 注册表声明的钩子总数（含 `enabled: false`）。 */
  readonly declaredHookCount: number
  /** 实际会生效的钩子数（跨 stage 去重）。 */
  readonly enabledHookCount: number
  /** 缺真源清单（缺什么就写什么）。 */
  readonly missingSources: readonly string[]
}

/**
 * 把钩子注册表投影成只读表格。纯读，无副作用（不执行钩子、不改注册表）。
 */
export function projectMethodologyUsage(): MethodologyProjection {
  const registry = getNovelSkillHookRegistry()

  // 候选阶段只来自「钩子声明过的 stage」：空注册表自然得空数组，镜像常量不参与造行。
  const declaredStages = new Set<NovelSkillStage>()
  for (const hook of registry.hooks) {
    for (const stage of hook.stages) declaredStages.add(stage)
  }

  const stages = [...declaredStages]
    .sort(compareCodePoint)
    .map((stage): MethodologyStageRow => {
      const enabledHookIds = listNovelSkillHooksForStage(stage)
        .map((hook) => hook.id)
        .sort(compareCodePoint)
      const declaredHookCount = registry.hooks.filter((hook) => hook.stages.includes(stage)).length
      return {
        stage,
        hookCount: enabledHookIds.length,
        declaredHookCount,
        hookIds: enabledHookIds,
        hasPromptHint: null,
        triggerCount: null,
      }
    })

  const enabledHookIds = new Set<string>()
  for (const row of stages) {
    for (const hookId of row.hookIds) enabledHookIds.add(hookId)
  }

  return {
    stages,
    knownStages: [...METHODOLOGY_STAGE_UNIVERSE].sort(compareCodePoint),
    declaredHookCount: registry.hooks.length,
    enabledHookCount: enabledHookIds.size,
    missingSources: [...METHODOLOGY_MISSING_SOURCES],
  }
}
