/**
 * R-narrative-1 (27 号评估落地): NarrativeState — 双时态叙事声明与信息差可见性.
 *
 * 吸收来源：underworld-graph (MIT) src/types.ts（StateDeclaration 双时态 +
 * Modality 三模态）+ src/character-view.ts（五步过滤 + inferVisibility
 * located_in 扩散，含幂等与撤销回填保护）。GPL 的 pi-narrative-engine 仅作
 * 语义参照，未拷贝任何代码。
 *
 * 27 号评估采纳优先级第一名（bi-temporal 双时态）与第三名（信息差过滤）。
 * 定位：世界条目的时态化声明层——world-blueprint 管结构骨架（层→条目），
 * 本模块管「谁在何时知道什么」（时态 + 认识论 + 视角隔离），正交互补。
 * 确定性纯函数实现（不引入 better-sqlite3/sqlite-vec——ANL-004-A4）。
 */

/** 认识论地位三模态（吸收 underworld-graph Modality）。 */
export type NarrativeModality = "fact" | "belief" | "hypothesis"

/** 实体类型四类几何（character/location/item/concept）。 */
export type NarrativeEntityType = "character" | "location" | "item" | "concept"

/** validTo 未闭合哨兵（吸收 underworld-graph INFINITY 语义）。 */
export const TEMPORAL_OPEN = "Infinity"

import { createAtomicJsonStore } from "./projection-store"

/** 双时态状态声明：故事时间轴 [validFrom, validTo) + 事务时间轴 recordedAt。 */
export interface NarrativeDeclaration {
  declarationId: string
  entityId: string
  entityType: NarrativeEntityType
  property: string
  description: string
  modality: NarrativeModality
  /** 故事时间起（ISO 8601 或故事时间标识）。 */
  validFrom: string
  /** 故事时间止；TEMPORAL_OPEN = 未闭合。 */
  validTo: string
  /** 事务时间（写入时点），支持 retcon 隔离读取。 */
  recordedAt: string
}

/** 角色对某声明的可见性（独立时态；source 区分显式/目击/推断；recordedAt 支圐 retcon 隔离）。 */
export interface VisibilityDeclaration {
  declarationId: string
  characterId: string
  state: "known" | "unknown"
  source: "explicit" | "witnessed" | "inferred"
  validFrom: string
  validTo: string
  isExplicit: boolean
  /** 写入事务时点（可选；缺省视为最早，不参与 retcon 截断）。 */
  recordedAt?: string
}

/** located_in 关系（信息差位置扩散依据）。 */
export interface LocatedInRelation {
  sourceId: string
  targetId: string
  validFrom: string
  validTo: string
}

export function isTemporallyCovering(from: string, to: string, at: string): boolean {
  if (to === TEMPORAL_OPEN) return from <= at
  return from <= at && at < to
}

/**
 * character_view 五步过滤（吸收 underworld-graph 2026-07-22「知识持续」语义）：
 * 1) 全量声明（含已闭合——知识不因闭合/实体死亡而消失）
 * 2) 角色在 storyTime 持有的可见性（validFrom <= storyTime < validTo）
 * 3) 有效起点 = max(vis.validFrom, decl.validFrom)（不能先于声明存在而知晓）
 * 4) 有效终点 = vis.validTo（知识持续持有直到显式撤销）
 * 5) state==="known" && start <= storyTime && modalityFilter 命中
 * recordedAsOf：声明与可见性都重建到该事务时点（retcon 隔离——之后补写不可见）。
 */
export function characterView(
  declarations: NarrativeDeclaration[],
  visibilities: VisibilityDeclaration[],
  characterId: string,
  storyTime: string,
  opts: { modalityFilter?: NarrativeModality[]; recordedAsOf?: string } = {},
): NarrativeDeclaration[] {
  const cutoff = opts.recordedAsOf
  const decls = cutoff
    ? declarations.filter((d) => d.recordedAt <= cutoff)
    : declarations
  const vis = visibilities.filter(
    (v) =>
      v.characterId === characterId &&
      (v.recordedAt === undefined || cutoff === undefined || v.recordedAt <= cutoff),
  )

  const visible: NarrativeDeclaration[] = []
  for (const decl of decls) {
    const v = vis.find((x) => x.declarationId === decl.declarationId)
    if (!v) continue
    if (v.state !== "known") continue
    const start = v.validFrom > decl.validFrom ? v.validFrom : decl.validFrom
    if (!(start <= storyTime)) continue
    if (!isTemporallyCovering(v.validFrom, v.validTo, storyTime)) continue
    if (opts.modalityFilter && !opts.modalityFilter.includes(decl.modality)) continue
    visible.push(decl)
  }
  return visible
}

/**
 * 位置可见性扩散（吸收 inferVisibility）：遍历 storyTime 的 located_in 关系，
 * 把地点实体的全部有效声明标记为角色 witnessed 可见；validFrom 取
 * max(进入时间, 声明时间)。幂等（已可见不重复）；撤销回填保护
 * （曾撤销过 → 新记录 validFrom 取当前推断时刻，不静默覆盖撤销区间）。
 * 纯函数：返回新增可见性列表（含已有时不产生重复）。
 */
export function inferLocationVisibility(
  declarations: NarrativeDeclaration[],
  existingVisibilities: VisibilityDeclaration[],
  locatedInRelations: LocatedInRelation[],
  storyTime: string,
): VisibilityDeclaration[] {
  const additions: VisibilityDeclaration[] = []
  const activeRels = locatedInRelations.filter((r) => isTemporallyCovering(r.validFrom, r.validTo, storyTime))

  for (const rel of activeRels) {
    const targetDecls = declarations.filter(
      (d) => d.entityId === rel.targetId && isTemporallyCovering(d.validFrom, d.validTo, storyTime),
    )
    for (const decl of targetDecls) {
      const mine = existingVisibilities.filter((v) => v.declarationId === decl.declarationId)
      // 幂等：storyTime 已可见 → 跳过
      if (mine.some((v) => v.validFrom <= storyTime && isTemporallyCovering(v.validFrom, v.validTo, storyTime))) {
        continue
      }
      // 撤销回填保护：曾撤销过（存在 validTo <= storyTime 的闭合记录）→ 从当前时刻起
      let validFrom = rel.validFrom > decl.validFrom ? rel.validFrom : decl.validFrom
      if (mine.some((v) => v.validTo !== TEMPORAL_OPEN && v.validTo <= storyTime)) {
        validFrom = storyTime
      }
      if (validFrom > storyTime) continue
      additions.push({
        declarationId: decl.declarationId,
        characterId: rel.sourceId,
        state: "known",
        source: "witnessed",
        validFrom,
        validTo: TEMPORAL_OPEN,
        isExplicit: false,
      })
    }
  }
  return additions
}

/** 构造显式可见性（作者声明角色知道/不知道某声明）。 */
export function declareVisibility(input: {
  declarationId: string
  characterId: string
  state: "known" | "unknown"
  validFrom: string
}): VisibilityDeclaration {
  return {
    ...input,
    source: "explicit",
    validTo: TEMPORAL_OPEN,
    isExplicit: true,
  }
}

/** 双时态校验后新增：持久化门面（激活 live 接入，同 reference-binding 先例）。 */
export interface NarrativeStateStore {
  declarations: NarrativeDeclaration[]
  visibilities: VisibilityDeclaration[]
  locatedInRelations: LocatedInRelation[]
  events: Array<{ eventId: string; type: string; storyTime: string; entityId: string; causedBy?: string; summary?: string }>
  lastUpdated: string
}

export function createEmptyNarrativeStateStore(): NarrativeStateStore {
  return { declarations: [], visibilities: [], locatedInRelations: [], events: [], lastUpdated: new Date().toISOString() }
}

const narrativeStore = createAtomicJsonStore<NarrativeStateStore>(
  "narrative-state.json",
  createEmptyNarrativeStateStore,
)

/** 持久化叙事状态（.novel/narrative-state.json，原子写；非第二真源——内容数据层，会话状态仍在 status.json）。 */
export async function saveNarrativeState(projectPath: string, store: NarrativeStateStore): Promise<void> {
  await narrativeStore.save(projectPath, store)
}

export async function loadNarrativeState(projectPath: string): Promise<NarrativeStateStore> {
  return narrativeStore.load(projectPath)
}

/**
 * 他盲修复写回算子（吸收 pi knowledge-mapper「角色从他者公开行为学习状态」语义，自研实现）：
 * 观察者列表在 storyTime 起知晓公开声明（source=inferred，isExplicit=false）。
 * 幂等且不降级：已持 known（任意来源）的观察者跳过；持 unknown（显式否认）的尊重显式声明跳过。
 * 确定性：同输入同输出。
 */
export function observePublicDeclaration(
  existing: VisibilityDeclaration[],
  input: { declarationId: string; observerIds: string[]; storyTime: string },
): VisibilityDeclaration[] {
  const additions: VisibilityDeclaration[] = []
  for (const observerId of input.observerIds) {
    const mine = existing.filter((v) => v.declarationId === input.declarationId && v.characterId === observerId)
    // 幂等：已 known 跳过；生效期内的显式 unknown 尊重作者声明跳过（已闭合的不再阻断）
    if (mine.some((v) => v.state === "known" && isTemporallyCovering(v.validFrom, v.validTo, input.storyTime))) continue
    if (mine.some((v) => v.isExplicit && v.state === "unknown" && isTemporallyCovering(v.validFrom, v.validTo, input.storyTime))) continue
    additions.push({
      declarationId: input.declarationId,
      characterId: observerId,
      state: "known",
      source: "inferred",
      validFrom: input.storyTime,
      validTo: TEMPORAL_OPEN,
      isExplicit: false,
    })
  }
  return additions
}

/**
 * 双时态校验后新增：死亡实体可见性级联（hy3 V5 value4 worth）。
 * inferLocationVisibility 应跳过死亡角色（死者不再习得新知）；
 * 输入死亡角色 id 集合 + 死亡故事时间，过滤 located_in 关系中已死亡的角色。
 */
export function filterDeceasedObservers(
  relations: LocatedInRelation[],
  deaths: Array<{ entityId: string; storyTime: string }>,
  storyTime: string,
): LocatedInRelation[] {
  const dead = new Set(deaths.filter((d) => d.storyTime <= storyTime).map((d) => d.entityId))
  return relations.filter((r) => !dead.has(r.sourceId))
}

/** 双时态结构校验：validFrom <= validTo（未闭合除外）。 */
export function validateTemporalOrder(
  declarations: NarrativeDeclaration[],
): string[] {
  const errors: string[] = []
  for (const d of declarations) {
    if (d.validTo !== TEMPORAL_OPEN && d.validFrom > d.validTo) {
      errors.push(`声明 ${d.declarationId} 时态倒置：validFrom ${d.validFrom} > validTo ${d.validTo}`)
    }
  }
  return errors
}
