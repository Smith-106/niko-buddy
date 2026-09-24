import { createAtomicJsonStore } from "./projection-store"
// 注：CompletionChecklistInput 定义在本文件（无须 import）；
// foreshadowing-tracker / subplot-board / story-thread-arcs / chapter-ingest
// 仅 collectCompletionChecklistInput（IO 层）使用，全部经函数内动态 import
// （leaf 约束：顶层只留 projection-store 静态 import，彻底零循环风险）。

/**
 * story-compass.ts — §GAP-89-01 滚动规划指南针 + 完结六项清单。
 *
 * 吸收 ainovel-cli `assets/prompts/architect-long.md` 滚动规划模式（229 行，
 * 指南针 + 视野按需展开 + 完结判定清单），落为 QMAI 主链纯函数 + additive
 * 持久 store：
 *
 *   - **指南针**：终局方向（ending_direction 主题性方向，非具体卷名/章数）+
 *     活跃长线（open_threads）+ 规模区间（estimated_scale 区间表达，非硬门槛，
 *     非定值）+ last_updated。首次落盘认真给，随创作经 updateCompass 上调/
 *     下调——随笔调整的罗盘，不是签死的合同。
 *   - **完结判定清单**（complete_book / 宣告收官卷前逐项核对，共 6 条）：
 *     1. 规模锚点（证据项，非否决项） 2. 终局达成 3. 长线收束 4. 伏笔归零
 *     5. 角色命运 6. 用户预期对照；配双向陷阱提醒（过早收笔 / 拖戏注水）。
 *   - **收官卷**：`"final": true` 宣告，写完自动完结，禁止在收官卷埋新钩子。
 *
 * ## P0 硬护栏（成败关键，不得破坏）
 *   1. **门控优先级固定**：本模块产出 review finding 的 type 恒为 `"contract"`，
 *      归 consistency 门（与 CORR108_LEGACY_CONSISTENCY_REVIEW_TYPES 一致）——
 *      Quality 不得覆盖 Consistency 失败。本模块只做清单核对，不产出门控 verdict。
 *   2. **Draft-first**：本模块不写正文、不回填正式记忆；落盘仅指南针/完结判定
 *      记录（.novel/story-compass.json），与 .novel/status.json 分层写入——
 *      禁止新建第二份会话状态文件替代 status.json（QMAI 禁止做法 #2）。
 *   3. **机械层零 LLM**：全部纯函数，同输入同输出；now 由调用方注入。
 *   4. 契约管下限不管上限：清单缺项出 finding（warning/error），不挡文学性上限。
 *
 * 模式来源（reference/ 只读，不整仓迁移）：
 *   - `拆解/ainovel-cli/assets/prompts/architect-long.md`（完结判定清单 6 条 +
 *     双向陷阱提醒 + final 收官卷语义 + "open_threads 非空时 complete_book 被
 *     工具层直接拒绝——豁免必须显式落盘"）。
 */

// ============================================================================
// 指南针 store
// ============================================================================

/**
 * StoryCompass — 长篇滚动规划指南针。
 *
 * estimated_scale 必须用区间表达（"预计 8-12 卷"），不要写死单一数字——
 * 给中期调整留余地（ainovel 原文 §"Story Compass"）。类型上仍为 string，
 * 区间语义由 updateCompassWiden/Narrow + evaluateCompletionChecklist 第 1 条
 * 承载（机械只比对区间端点，不做自然语言解析）。
 */
export interface StoryCompass {
  /** 主题性终局描述（如"主角在权力与良知之间抉择"），不是具体卷名/章数。 */
  endingDirection: string
  /** 活跃长线（open_threads）：未收束前 complete_book 被硬拒绝。 */
  openThreads: string[]
  /** 规模区间（如"预计 4-6 卷"）：证据项，非硬门槛。 */
  estimatedScale: string
  /** 是否已宣告收官卷（final_volume 存在即已宣告，不重复宣告）。 */
  finalVolumeDeclared: boolean
  /** 收官卷卷号（finalVolumeDeclared=true 时有效）。 */
  finalVolumeNumber?: number
  lastUpdated: string
}

export function createEmptyStoryCompass(now = ""): StoryCompass {
  return {
    endingDirection: "",
    openThreads: [],
    estimatedScale: "",
    finalVolumeDeclared: false,
    lastUpdated: now,
  }
}

const compassStore = createAtomicJsonStore<StoryCompass>(
  "story-compass.json",
  createEmptyStoryCompass,
  { arrayFieldCaps: { openThreads: 100 } },
)

export async function saveStoryCompass(
  projectPath: string,
  compass: StoryCompass,
): Promise<void> {
  await compassStore.save(projectPath, compass)
}

export async function loadStoryCompass(projectPath: string): Promise<StoryCompass> {
  return compassStore.load(projectPath)
}

// ============================================================================
// 指南针更新（update_compass 语义）
// ============================================================================

export interface CompassUpdate {
  endingDirection?: string
  /** 收束掉的长线（从 openThreads 移除）。 */
  resolvedThreads?: string[]
  /** 新增的长线（追加进 openThreads，去重）。 */
  newThreads?: string[]
  /** 规模区间调整（如"约 38-42 章"）。 */
  estimatedScale?: string
  /** 宣告收官卷（final=true 语义）：置 finalVolumeDeclared + 卷号。 */
  declareFinalVolume?: number
}

/**
 * update_compass：移除已收束 open_threads、添加新长线、调整 estimated_scale、
 * 宣告收官卷时收窄规模区间。immutable（不原地改写入参）。now 可注入。
 *
 * 豁免必须显式落盘（ainovel 原文）："作者有意留白"不构成收束——要豁免某条
 * 长线，调用方必须经 resolvedThreads 把它移除落盘，不能只写在论述里。
 */
export function updateCompass(
  compass: StoryCompass,
  update: CompassUpdate,
  opts: { now?: string } = {},
): StoryCompass {
  const now = opts.now ?? new Date().toISOString()
  const open = new Set(compass.openThreads)
  for (const t of update.resolvedThreads ?? []) open.delete(t)
  for (const t of update.newThreads ?? []) {
    const trimmed = t.trim()
    if (trimmed) open.add(trimmed)
  }
  const next: StoryCompass = {
    ...compass,
    endingDirection: update.endingDirection ?? compass.endingDirection,
    openThreads: [...open],
    estimatedScale: update.estimatedScale ?? compass.estimatedScale,
    lastUpdated: now,
  }
  if (update.declareFinalVolume !== undefined) {
    next.finalVolumeDeclared = true
    next.finalVolumeNumber = update.declareFinalVolume
  }
  return next
}

// ============================================================================
// 完结判定清单（complete_book / 宣告收官卷前逐项核对）
// ============================================================================

/** 完结清单 6 条目的 id（固定顺序，与 ainovel 原文一致）。 */
export type CompletionChecklistItemId =
  | "scale_anchor"
  | "ending_achieved"
  | "threads_closed"
  | "foreshadowing_zero"
  | "character_fates"
  | "user_expectation"

export const COMPLETION_CHECKLIST_IDS: readonly CompletionChecklistItemId[] = [
  "scale_anchor",
  "threads_closed",
  "foreshadowing_zero",
  "character_fates",
  "user_expectation",
  "ending_achieved",
]

/** 逐项核对输入（全部由调用方从既有真源采集，本模块不读盘）。 */
export interface CompletionChecklistInput {
  /** 已完成章数（completion_signals.completed_chapters）。 */
  completedChapters: number
  /** 规模区间解析后的端点（调用方把 estimated_scale 区间转为数字；解析不出传 null）。 */
  scaleRange?: { min: number; max: number } | null
  /** 终局命题是否已在本卷叙事中正面回答（仅"主角进入稳态"不算回答）。 */
  endingAnswered: boolean
  /** compass.open_threads 快照（未收束条目）。 */
  openThreads: string[]
  /** 活跃伏笔数（completion_signals.active_foreshadow_count）。 */
  activeForeshadowCount: number
  /** 主角与重要配角最终选择/命运/关系定位是否已明确（仅"日常稳态"不算）。 */
  characterFatesClear: boolean
  /** 用户启动 prompt 的目标长度/结局姿态是否相符（无明确预期传 null=跳过）。 */
  userExpectationMet?: boolean | null
}

export interface CompletionChecklistItem {
  id: CompletionChecklistItemId
  /** true=通过，false=未通过（第 1 条规模锚点恒为证据项，不否决）。 */
  passed: boolean
  /** 是否为否决项（第 1 条 false——证据项，非否决项）。 */
  blocking: boolean
  detail: string
}

export interface CompletionChecklistResult {
  items: CompletionChecklistItem[]
  /** 六条全过（第 1 条只计证据，不计入全过判定——全过 = 2-6 条全 passed）。 */
  allPassed: boolean
  /** 建议动作：complete_book（六条全过）/ declare_finale（2-5 大体成立或一卷可收束）/ continue（继续续卷）。 */
  recommendation: "complete_book" | "declare_finale" | "continue"
}

/**
 * 逐项核对完结清单。纯函数，零 LLM。
 *
 * 规模锚点（第 1 条）恒为证据项：若 2-5 全过而仅规模未达，recommendation 照给
 * complete_book/declar_finale 倾向，并在 detail 注明"禁止为凑规模注水"
 * （ainovel 原文第 1 条）。
 */
export function evaluateCompletionChecklist(
  input: CompletionChecklistInput,
): CompletionChecklistResult {
  const scaleDetail = (() => {
    if (!input.scaleRange) return "规模区间未解析：仅作证据记录，不否决"
    const { min, max } = input.scaleRange
    if (input.completedChapters >= min && input.completedChapters <= max) {
      return `规模 ${input.completedChapters} 章落在区间 ${min}-${max} 内`
    }
    if (input.completedChapters < min) {
      return `规模 ${input.completedChapters} 章未达区间下限 ${min}（证据项：若第 2-5 条全过，禁止为凑规模注水，应宣告收官提前收束）`
    }
    return `规模 ${input.completedChapters} 章超出区间上限 ${max}（证据项：核对是否拖戏注水）`
  })()
  // 第 1 条恒 passed=true（证据项永不否决），差距只进 detail。
  const scaleAnchor: CompletionChecklistItem = {
    id: "scale_anchor",
    passed: true,
    blocking: false,
    detail: scaleDetail,
  }

  const items: CompletionChecklistItem[] = [
    scaleAnchor,
    {
      id: "ending_achieved",
      passed: input.endingAnswered,
      blocking: true,
      detail: input.endingAnswered
        ? "终局命题已正面回答"
        : "终局命题尚未正面回答（仅稳态不算回答）",
    },
    {
      id: "threads_closed",
      passed: input.openThreads.length === 0,
      blocking: true,
      detail: input.openThreads.length === 0
        ? "长线已全部收束"
        : `未收束长线 ${input.openThreads.length} 条：${input.openThreads.slice(0, 5).join("、")}${input.openThreads.length > 5 ? "…" : ""}`,
    },
    {
      id: "foreshadowing_zero",
      passed: input.activeForeshadowCount <= 0,
      blocking: true,
      detail: input.activeForeshadowCount <= 0
        ? "伏笔已归零"
        : `活跃伏笔 ${input.activeForeshadowCount} 条未归零`,
    },
    {
      id: "character_fates",
      passed: input.characterFatesClear,
      blocking: true,
      detail: input.characterFatesClear
        ? "主角与重要配角命运已明确"
        : "角色命运尚未明确（仅日常稳态不算）",
    },
    {
      id: "user_expectation",
      passed: input.userExpectationMet !== false,
      blocking: false,
      detail: input.userExpectationMet === null || input.userExpectationMet === undefined
        ? "用户无明确长度/结局预期：跳过对照"
        : input.userExpectationMet
          ? "用户预期相符"
          : "与用户预期不符（证据项：核对目标长度/结局姿态）",
    },
  ]

  // 全过 = 2-6 条中 blocking 项全 passed（第 1 条证据项、第 6 条非 blocking 不计入）。
  const blockingItems = items.filter((i) => i.blocking)
  const allPassed = blockingItems.every((i) => i.passed)
  const failedBlocking = blockingItems.filter((i) => !i.passed).length

  let recommendation: CompletionChecklistResult["recommendation"]
  if (allPassed) {
    recommendation = "complete_book"
  } else if (failedBlocking <= 2) {
    // 大体成立（一卷之内可把剩余项全部收束）→ 规划收官卷。
    recommendation = "declare_finale"
  } else {
    recommendation = "continue"
  }
  return { items, allPassed, recommendation }
}

// ============================================================================
// complete_book 硬门（工具层硬校验）
// ============================================================================

export interface CompleteBookVerdict {
  allowed: boolean
  /** 拒绝原因（allowed=false 时非空）。 */
  reason: string
}

/**
 * complete_book 工具层硬校验（ainovel 原文）：
 * `open_threads` 非空时直接拒绝——确认已全部收束，必须先 update_compass
 * 清空落盘。收束与否是语义裁量，但豁免必须显式落盘。
 *
 * 另：final 卷已宣告（finalVolumeDeclared）时重复 complete_book 属重复宣告，
 * 同样拒绝（应等待收官卷写完自动完结）。
 */
export function checkCompleteBookAllowed(compass: StoryCompass): CompleteBookVerdict {
  if (compass.openThreads.length > 0) {
    return {
      allowed: false,
      reason: `open_threads 非空（${compass.openThreads.length} 条未收束）：complete_book 被拒绝，先 update_compass 清空落盘`,
    }
  }
  if (compass.finalVolumeDeclared) {
    return {
      allowed: false,
      reason: "收官卷已宣告（final_volume 存在）：不要重复宣告，等待收官卷写完自动完结",
    }
  }
  return { allowed: true, reason: "" }
}

// ============================================================================
// 双向陷阱提醒（文案常量，供 prompt 注入）
// ============================================================================

/** 过早收笔陷阱提醒（ainovel 原文）。 */
export const PREMATURE_ENDING_TRAP =
  "过早收笔：主角达成精神成长 + 主要矛盾稳态化 ≠ 全书完结。把开放式日常收尾判为终点前，必须先正面通过终局达成与长线收束两条，不是被本卷尾章的稳态氛围带走。"

/** 拖戏注水陷阱提醒（ainovel 原文）。 */
export const PADDING_TRAP =
  "拖戏注水：终局已答、长线已收，仅因章数没到 estimated_scale 就硬开新冲突，是对读者更大的背叛。故事到了终点就宣告收官卷体面收束。"

/** 收官卷禁令：收官卷落盘后禁止再埋新钩子。 */
export const FINALE_NO_NEW_HOOKS =
  "收官卷禁令：收官卷（final:true）的叙事功能是收束与兑现，不再开新长线、不埋新钩子；弧结构必须把 open_threads 与活跃伏笔全部分配到各弧回收。"

// ============================================================================
// 完结清单输入采集（IO 层：从既有真源组装 CompletionChecklistInput）
// ============================================================================

export interface CompletionInputCollectOptions {
  /** 规模区间（调用方把 estimated_scale 区间转为数字；解析不出传 null）。 */
  scaleRange?: { min: number; max: number } | null
  /** 终局命题是否已正面回答（语义裁量，调用方/LLM 判定）。 */
  endingAnswered?: boolean
  /** 角色命运是否已明确（语义裁量，调用方/LLM 判定）。 */
  characterFatesClear?: boolean
  /** 用户预期是否相符（无明确预期传 null=跳过）。 */
  userExpectationMet?: boolean | null
  /** compass.open_threads 快照（显式传入时优先于 store 派生）。 */
  openThreads?: string[]
}

/**
 * collectCompletionChecklistInput：从既有真源采集清单机械项（IO 层）。
 *
 * 机械项（本函数采集，零 LLM）：
 *   - completedChapters ← listSnapshots 正章号计数（outline 负号项排除）；
 *   - activeForeshadowCount ← foreshadowing-tracker planted/advanced 计数
 *     （与 foreshadowingToContextText 同过滤口径）；
 *   - openThreads ← 未显式传入时由 subplot 6 态派生（deriveAllThreadArcStates
 *     未终结弧 title，去重；story-thread-arcs 纯函数复用，零平行实现）。
 * 语义项（调用方传入）：endingAnswered / characterFatesClear /
 *   userExpectationMet / scaleRange。
 *
 * 失败语义：各源 load 失败降级（快照→0、伏笔→0、支线→[]），绝不整体抛错
 * （与 buildChapterPlan 逐维降级同哲学）；缺失 store 即视为空（lenient）。
 */
/** collectCompletionChecklistInput 可注入依赖（测试缝：默认动态 import 路径，生产零行为变化）。 */
export interface CompletionInputCollectDeps {
  /** 快照清单函数（默认动态 import chapter-ingest.listSnapshots）。 */
  listSnapshots?: (projectPath: string) => Promise<number[]>
}

export async function collectCompletionChecklistInput(
  projectPath: string,
  currentChapter: number,
  options: CompletionInputCollectOptions = {},
  deps: CompletionInputCollectDeps = {},
): Promise<CompletionChecklistInput> {
  // listSnapshots / tracker load 全部经动态 import（chapter-ingest 为巨型模块；
  // foreshadowing/subplot/story-thread 虽是 leaf，同样动态 import 把依赖推迟到
  // 调用时，本模块顶层只留 projection-store + type-only import，彻底零循环风险）。
  // deps.listSnapshots 测试缝：注入后跳过巨型模块加载，消除全量并发下冷加载
  // 击穿 15s testTimeout 的 flaky（根因见 #92：T18 冷加载 ~7.2s 实证）。
  const listSnapshotsFn =
    deps.listSnapshots ?? (await import("./chapter-ingest")).listSnapshots
  const { loadForeshadowingTracker } = await import("./foreshadowing-tracker")
  const { loadSubplotBoard } = await import("./subplot-board")
  const { deriveAllThreadArcStates } = await import("./story-thread-arcs")
  const snapshots = await listSnapshotsFn(projectPath).catch(() => [] as number[])
  const completedChapters = snapshots.filter((n) => n > 0).length

  const fore = await loadForeshadowingTracker(projectPath).catch(() => null)
  const activeForeshadowCount = fore
    ? fore.items.filter((f) => f.status === "planted" || f.status === "advanced").length
    : 0

  let openThreads = options.openThreads
  if (openThreads === undefined) {
    const board = await loadSubplotBoard(projectPath).catch(() => null)
    if (board) {
      const derived = deriveAllThreadArcStates(board.items, currentChapter)
      const openTitles = derived
        .filter((d) => d.arcState !== "Resolved" && d.arcState !== "Unresolved")
        .map((d) => d.title)
      openThreads = [...new Set(openTitles)]
    } else {
      openThreads = []
    }
  }

  return {
    completedChapters,
    scaleRange: options.scaleRange ?? null,
    endingAnswered: options.endingAnswered ?? false,
    openThreads,
    activeForeshadowCount,
    characterFatesClear: options.characterFatesClear ?? false,
    userExpectationMet: options.userExpectationMet ?? null,
  }
}
