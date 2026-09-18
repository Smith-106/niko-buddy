/**
 * MIG-002 治理：`.novel/` 投影文件注册表。
 *
 * 背景：swarm 架构分析发现 `.novel/` 下投影文件无统一目录——哪些是孤岛
 * （写了不进主链 context pack）、哪些喂 context，只能逐个 grep 判定，
 * 资源管理困难。本注册表显式声明每个投影的写者/读者/消费面/孤岛标记，
 * 让孤岛可见、协作链路可审计。
 *
 * 定位：治理文档/轻量数据（非运行时依赖）。新增投影须登记；
 * orphan=true 仅允许内部状态投影（生命周期独立、不喂 context 是设计而非缺陷）。
 */

export type ProjectionConsumer =
  | "context-pack" // 进 buildContextPack 注入生成
  | "graph" // 喂图谱节点/边
  | "ui-panel" // 面板直接读
  | "orchestrator" // director/管线状态机读
  | "canon" // canon 账本/对齐消费
  | "internal" // 仅本模块内部状态（允许孤岛但须声明）

export interface ProjectionEntry {
  /** 投影文件名（.novel/<file>）。 */
  file: string
  /** 写者模块（产物方）。 */
  writer: string
  /** 主要读者/消费方（模块或语义描述）。 */
  readers: string[]
  /** 消费面。 */
  consumer: ProjectionConsumer
  /** 孤岛标记：写了但不进主链（context-pack/graph/canon 均不消费）。 */
  orphan: boolean
  /** 说明。 */
  note?: string
}

/**
 * `.novel/` 投影注册表。consumer=context-pack/graph/canon 的是主链投影；
 * consumer=internal + orphan=true 的是声明的内部状态（合法孤岛）。
 */
export const PROJECTIONS_REGISTRY: ProjectionEntry[] = [
  // ── 主链投影（进 context pack / graph / canon）─────────────────
  {
    file: "snapshots/",
    writer: "chapter-ingest",
    readers: ["context-engine", "corkboard-view", "chapter-utils"],
    consumer: "context-pack",
    orphan: false,
    note: "章节快照目录（非单文件）——主链枢纽",
  },
  {
    file: "facts.json",
    writer: "chapter-ingest",
    readers: ["context-engine"],
    consumer: "context-pack",
    orphan: false,
    note: "章节事实/人物状态——context-engine L1424/1462 直读",
  },
  {
    file: "emotional-arcs.json",
    writer: "character-state",
    readers: ["context-engine"],
    consumer: "context-pack",
    orphan: false,
    note: "角色情感弧——context-engine L1061",
  },
  {
    file: "character-states.json",
    writer: "character-state",
    readers: ["context-engine", "ui-panel"],
    consumer: "context-pack",
    orphan: false,
  },
  {
    file: "cognition-state.json",
    writer: "character-cognition",
    readers: ["context-engine"],
    consumer: "context-pack",
    orphan: false,
  },
  {
    file: "chapter-summaries.json",
    writer: "chapter-summaries",
    readers: ["context-engine"],
    consumer: "context-pack",
    orphan: false,
  },
  {
    file: "foreshadowing-tracker.json",
    writer: "chapter-ingest",
    readers: ["context-engine"],
    consumer: "context-pack",
    orphan: false,
    note: "伏笔追踪——context pack foreshadowingStates",
  },
  {
    file: "canon-pending.json",
    writer: "canon-dual-write",
    readers: ["canon-reconcile", "canon-backfill"],
    consumer: "canon",
    orphan: false,
    note: "canon 待写队列——对账消费",
  },
  {
    file: "canon-legacy.json",
    writer: "canon-dual-write",
    readers: ["canon-reconcile"],
    consumer: "canon",
    orphan: false,
  },
  // ── 迁移模块投影（本次接线后进 context pack）─────────────────
  {
    file: "world-blueprint.json",
    writer: "world-blueprint / director-view(deriveAndSave)",
    readers: ["context-engine", "director-orchestrator"],
    consumer: "context-pack",
    orphan: false,
    note: "MIG-002 已接线——ContextPack.worldBlueprint L2 段注入",
  },
  {
    file: "director-pipeline.json",
    writer: "director-pipeline-store",
    readers: ["director-orchestrator", "director-view"],
    consumer: "orchestrator",
    orphan: false,
    note: "开书导演状态机——orchestrator 消费（不直接进 context，属管线状态）",
  },
  // ── 声明的内部状态投影（合法孤岛——生命周期独立不喂 context）───
  {
    file: "narrative-state.json",
    writer: "narrative-state",
    readers: ["event-causality", "context-engine"],
    consumer: "context-pack",
    orphan: false,
    note: "叙事信息差可见性——MIG-003 已接 ContextPack.narrativeVisibility L2 段（视角可见性防剧透）；event-causality 读事件日志",
  },
  {
    file: "scenes.json",
    writer: "scene-breakdown",
    readers: ["chapter-structure-plan", "deep-chapter-generation", "review-adapter", "character-cognition"],
    consumer: "orchestrator",
    orphan: false,
    note: "场景分解产物——scene-breakdown 模块已被 chapter-structure-plan/deep-chapter-generation/review-adapter/character-cognition 消费；scenes.json 文件本身 draft-first 产物（pending→ready→accept）",
  },
  {
    file: "literary-gold-anchors.json",
    writer: "literary-gold-scale",
    readers: ["dimension-review-adapter", "consensus-review", "novel-skill-hooks"],
    consumer: "orchestrator",
    orphan: false,
    note: "文学金标量程锚——已接 dimension-review-adapter:431 buildGoldScaleReviewBlock + loadGoldScaleMaterials 评审链（不进 context pack，属评审治理产物）",
  },
  {
    file: "emotion-ledger.json",
    writer: "character-state",
    readers: ["character-state"],
    consumer: "internal",
    orphan: true,
    note: "情感账本内部状态——character-state 自消费，emotional-arcs 才进 context",
  },
  {
    file: "continuity-overrides.json",
    writer: "continuity-overrides-store",
    readers: ["deterministic-continuity-engine"],
    consumer: "internal",
    orphan: true,
    note: "连贯性覆盖——引擎内部状态",
  },
  {
    file: "metrics.json",
    writer: "deep-chapter-generation",
    readers: [],
    consumer: "internal",
    orphan: true,
    note: "生成度量——诊断遥测非主链",
  },
  {
    file: "continuity-metrics.json",
    writer: "deep-chapter-generation",
    readers: [],
    consumer: "internal",
    orphan: true,
    note: "连贯性度量——诊断遥测",
  },
  {
    file: "aura-evolution.json",
    writer: "aura-evolution",
    readers: ["aura-evolution"],
    consumer: "internal",
    orphan: true,
    note: "aura 演化内部状态",
  },
  {
    file: "encounter-matrix.json",
    writer: "chapter-ingest",
    readers: ["context-engine"],
    consumer: "context-pack",
    orphan: false,
    note: "相遇矩阵——context pack 角色关系",
  },
  {
    file: "chapter-workspace.json",
    writer: "deep-chapter-generation",
    readers: ["deep-chapter-generation"],
    consumer: "internal",
    orphan: true,
    note: "章节工作区草稿态",
  },
  // ── arch-risk W6 残余孤岛判定：补登记真实引擎投影（非 orphan——有消费者）──
  {
    file: "promotions.json",
    writer: "promotion-bridge",
    readers: ["promotion-bridge", "kb-governance", "canon"],
    consumer: "canon",
    orphan: false,
    note: "晋升事件 record——record=唯一原子提交点，promotion-events.jsonl 是其 append 日志",
  },
  {
    file: "promotion-events.jsonl",
    writer: "promotion-bridge",
    readers: ["promotion-bridge", "kb-observability"],
    consumer: "canon",
    orphan: false,
    note: "晋升事件 append 日志——promotions.json 的写前审计轨",
  },
  {
    file: "audit-findings.jsonl",
    writer: "review-adapter",
    readers: ["review-adapter", "kb-observability"],
    consumer: "orchestrator",
    orphan: false,
    note: "审查 findings append 日志——auditChapter 编排层零写句柄例外",
  },
  {
    file: "inspirations.json",
    writer: "inspiration-entry",
    readers: ["inspiration-entry", "outline-wizard"],
    consumer: "ui-panel",
    orphan: false,
    note: "灵感集合——桌面端导入移动端记录，outline-wizard 消费",
  },
]

/** 主链投影（进 context pack/graph/canon）。 */
export function mainChainProjections(): ProjectionEntry[] {
  return PROJECTIONS_REGISTRY.filter((e) => !e.orphan)
}

/** 声明的孤岛投影（internal 状态，orphan=true）。 */
export function orphanProjections(): ProjectionEntry[] {
  return PROJECTIONS_REGISTRY.filter((e) => e.orphan)
}
