/**
 * canon-precision-filter.ts — 图谱抽取精度过滤（Roadmap 批次 A7 / write 模式）。
 *
 * ## 背景
 *   图谱边/实体（`snapshot.graphEdges`）来自单次 LLM 抽取，无二次过滤——幻觉边
 *   （实体名未在源文出现、自环、空字段、超长乱串）直入实体页。本模块对抽取关系
 *   做两层**逐条核验 + degraded 降级**：
 *
 *   ① 机械零 LLM 预筛（先跑，恒开）——实体名在源文出现校验 / 自环 / 空字段 / 超长；
 *   ② 可选注入 `verify` 函数的 LLM 批量核验层（后置）——未注入函数 = **degraded**，
 *     仅机械层通过即放行；注入后仅对机械层幸存者跑一次批量核验，核验拒绝的关系
 *     一并出局。
 *
 *   > 模式借鉴 lore-weave `pass2_filter.py::apply_precision_filter`（逐条核验源文本 +
 *   > degraded 降级），AGPL 只借模式不抄码——本项目为独立 TS 实现，不含其代码。
 *
 * ## 双层契约
 *   - 输入关系 `ExtractedRelation { source, target, relation }`：source/target 为实体名
 *     （可含 `character:`/`location:` 前缀），relation 为关系标签（英式枚举或中文均可）。
 *   - 机械层各拒绝原因见 `PrecisionRejectReason`；同一关系按「先机械后 LLM」顺序，
 *     一旦被判拒不再进下一层。
 *   - 输出 `{ kept, rejected, degraded }`：`rejected` 逐条携带 `relation` + `reason`。
 *
 * ## 接线点（A7 本轮仅交付文档，未接线）
 *   已实读定位 "ingest 后、写库前" 的实际函数；接入方应在落库前把抽取边的候选集
 *   交给 `filterExtractedRelations`。推荐接线点（file:line 随代码漂移会失效，接前须复核）：
 *
 *   - `src/lib/novel/chapter-ingest.ts:519`（`writeSnapshotToWiki(pp, snapshot)`，ingest
 *     主路径：把 snapshot 写为实体页）。承接两侧均在此**单峰**调用：先
 *     `filterExtractedRelations(edges, sourceText)` 再交 `writeSnapshotToWiki`。
 *     同文件 `:1065`、`:1227`、`:1840` 为 rebuild/restore/delete 派生写路径，同样位置。
 *   - `src/lib/novel/graph-adapter.ts:227`（`snapshotToGraphEdges`）+ `:581`（`writeSnapshotToWiki`
 *     内部 `const edges = snapshotToGraphEdges(...)`）：边的解析/产出点，也即边对象
 *     `NovelGraphEdge { source, target, relation }` 形成处；在 :581 处拦截即覆盖
 *     `writeSnapshotToWiki` 全部调用方。
 *   - `src/lib/novel/chapter-ingest-output.ts:254`（`buildGraphDerivation` 内
 *     `snapshotToGraphEdges(snapshot).map(...)`）：图谱投影候选（graphDerivation）产出点。
 *
 *   > 注意：本模块**不含生产调用方也未接线** —— 本轮只实现纯函数 + 测试 + 交付接线文档。
 *   > WIP 文件（`canon-dual-write.ts` / `canon-reconcile.ts`）与 `graph-adapter.ts` /
 *   > `chapter-ingest.ts` 一律不改。
 *
 * 遵循 QMAI/CLAUDE.md：零 LLM 机械层 + 可注入核验，纯函数无副作用，Draft-first 不适用。
 */

/** 单条被抽取的关系候选（与 `NovelGraphEdge` 三要素同构，保持本模块独立、无反向依赖）。 */
export interface ExtractedRelation {
  /** 来源实体（可含类型前缀，如 `character:菜月昴`；或不带前缀的裸名）。 */
  source: string
  /** 目标实体（同上）。 */
  target: string
  /** 关系标签：中文原文（如 `敌对`）或枚举（如 `ENEMY_OF`）。 */
  relation: string
  /** 可选可信分（1-100），机械层/核验层可参考，不改变判定规则。 */
  confidence?: number
  /** 可选证据片段（抽取源行），仅透传与审计，不影响 weeding。 */
  evidence?: string
}

/** 拒绝原因枚举（机械层各项 + LLM/核验层拒绝）。 */
export type PrecisionReason =
  | "empty_source"
  | "empty_target"
  | "empty_relation"
  | "self_loop"
  | "source_not_in_text"
  | "target_not_in_text"
  | "oversized_source"
  | "oversized_target"
  | "oversized_relation"
  | "verify_rejected"

/** 单条被拒关系 + 拒绝原因。 */
export interface RejectedRelation {
  relation: ExtractedRelation
  reason: PrecisionReason
  /** verify 层自定义原因（当 `reason === "verify_rejected"` 时有值）。 */
  detail?: string
}

/** LLM/核验层对 batch 的逐条结论（与入参 batch 一一对应）。 */
export interface RelationVerdict {
  /** true = 认可（计入 kept）；false = 拒绝（reason 标 verify_rejected）。 */
  accepted: boolean
  /** 拒绝时的可读理由（写入 `RejectedRelation.detail`）。 */
  detail?: string
}

/** `filterExtractedRelations` 的可调参数。 */
export interface PrecisionFilterOptions {
  /** 实体名/关系标签的最大字符长度阈值（超出计超长）。默认 60。 */
  maxEntityLength?: number
  /** 关系标签最大字符长度阈值。默认 40。 */
  maxRelationLength?: number
  /**
   * 是否要求 source/target 裸名出现在 `sourceText`（实体名源文校验）。
   * 默认 true。若置 false 跳过该检查（用于源文本缺失的降级入口）。
   */
  requireSourcePresence?: boolean
  /**
   * 可选注入的 LLM 批量核验函数。**未注入 => degraded**（仅机械层放行即结束）。
   * 注入后仅对机械层幸存的关系跑**一次**批量核验；函数须返回与入参一一对应的结论。
   */
  verify?: (relations: readonly ExtractedRelation[], sourceText: string) => Promise<RelationVerdict[]>
}

/** 过滤结果。 */
export interface PrecisionFilterResult {
  /** 通过全部 active 层的关系（机械层必然执行；verify 注入时亦通过核验）。 */
  kept: ExtractedRelation[]
  /** 被拒绝的关系逐条 + 原因。 */
  rejected: RejectedRelation[]
  /** true 当且仅当未注入 verify（仅机械层生效：degraded）。 */
  degraded: boolean
}

/** 默认长度阈值。 */
const DEFAULT_MAX_ENTITY_LENGTH = 60
const DEFAULT_MAX_RELATION_LENGTH = 40

/**
 * 清洗实体名：去掉类型前缀（`character:` / `location:` 等），返回用于源文匹配的裸名。
 * 无前缀则原样返回；名称为空返回空串。
 */
export function entityBareName(raw: string): string {
  const trimmed = raw.trim()
  const idx = trimmed.indexOf(":")
  if (idx > 0) return trimmed.slice(idx + 1).trim()
  return trimmed
}

/**
 * 图层 ①：机械零 LLM 预筛。返回 null={通过} 或 {reason}。
 * 检查顺序：空字段 → 自环 → 超长 → 实体名源文校验。
 */
export function mechanicalVerdict(
  relation: ExtractedRelation,
  sourceText: string,
  opts: Required<Pick<PrecisionFilterOptions, "maxEntityLength" | "maxRelationLength" | "requireSourcePresence">>,
): PrecisionReason | null {
  const source = relation.source?.trim() ?? ""
  const target = relation.target?.trim() ?? ""
  const rel = relation.relation?.trim() ?? ""

  if (!source) return "empty_source"
  if (!target) return "empty_target"
  if (!rel) return "empty_relation"

  const bareSource = entityBareName(source)
  const bareTarget = entityBareName(target)
  if (bareSource && bareTarget && bareSource === bareTarget) return "self_loop"

  if (source.length > opts.maxEntityLength || bareSource.length > opts.maxEntityLength) return "oversized_source"
  if (target.length > opts.maxEntityLength || bareTarget.length > opts.maxEntityLength) return "oversized_target"
  if (rel.length > opts.maxRelationLength) return "oversized_relation"

  if (opts.requireSourcePresence) {
    if (bareSource && !sourceText.includes(bareSource)) return "source_not_in_text"
    if (bareTarget && !sourceText.includes(bareTarget)) return "target_not_in_text"
  }

  return null
}

/**
 * 双层精度过滤主入口。
 *
 * 流程：
 *   1. 每个关系先过机械层（零 LLM）；首个命中原因即拒绝，不回逆。
 *   2. 全部机械层放行的幸存者：若注入 `verify`，一次性批量核验；被拒的理由标
 *      `verify_rejected`。若未注入 => degraded，直接返回机械层幸存者。
 *   3. 输出 `{ kept, rejected, degraded }`。
 *
 * 纯函数无副作用；`verify` 是否为 LLM 由调用方注入决定，本模块不直接触碰 LLM 客户端。
 */
export async function filterExtractedRelations(
  relations: readonly ExtractedRelation[],
  sourceText: string,
  opts: PrecisionFilterOptions = {},
): Promise<PrecisionFilterResult> {
  const maxEntityLength = opts.maxEntityLength ?? DEFAULT_MAX_ENTITY_LENGTH
  const maxRelationLength = opts.maxRelationLength ?? DEFAULT_MAX_RELATION_LENGTH
  const requireSourcePresence = opts.requireSourcePresence ?? true
  const mechOpts = { maxEntityLength, maxRelationLength, requireSourcePresence }

  const rejected: RejectedRelation[] = []
  const mechanicalKept: ExtractedRelation[] = []

  for (const relation of relations) {
    const reason = mechanicalVerdict(relation, sourceText, mechOpts)
    if (reason) rejected.push({ relation, reason })
    else mechanicalKept.push(relation)
  }

  // 未注入 verify => degraded，机械层幸存者即最终幸存者。
  if (!opts.verify) {
    return { kept: mechanicalKept, rejected, degraded: true }
  }

  // 注入 verify：对机械层幸存者跑一次批量核验（一一对应）。
  let verdicts: RelationVerdict[]
  try {
    verdicts = await opts.verify(mechanicalKept, sourceText)
  } catch {
    // verify 抛错视为全部拒绝（防幻觉入页的前置原则：宁可少出）。
    verdicts = mechanicalKept.map(() => ({ accepted: false, detail: "verify-threw" }))
  }

  const kept: ExtractedRelation[] = []
  for (let i = 0; i < mechanicalKept.length; i += 1) {
    const relation = mechanicalKept[i]
    const verdict = verdicts[i]
    if (verdict && verdict.accepted) {
      kept.push(relation)
    } else {
      rejected.push({ relation, reason: "verify_rejected", detail: verdict?.detail })
    }
  }

  return { kept, rejected, degraded: false }
}