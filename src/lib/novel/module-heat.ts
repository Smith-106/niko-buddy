/**
 * module-heat.ts — 运行热力：模块调用遥测的纯函数层（运动热力图数据面）。
 *
 * 定位：静态接线由 `module-atlas.generated.json` 提供（谁调用谁、谁没人调用），
 * 本模块只补「运行期热度」这一层——某模块被调用了多少次、最近一次什么时候、
 * 成功还是失败、耗时多少，以及可直接渲染的 session log 事件流。
 *
 * 依赖方向纪律（ADR-19）：本模块纯函数、零 IO、零时钟读取（时间由调用方传入），
 * 也不 import 任何 store。运行时由 `stores/module-heat-store.ts` 注册 sink 把
 * 命中事件收进 zustand；未注册 sink 时 recordModuleHit 是 no-op，测试与脚本可安全调用。
 *
 * @license MIT © Niko Buddy
 */

import type { ModuleAtlas, ModuleAtlasEntry } from "./module-atlas"

/** 单次模块命中。 */
export interface ModuleHit {
  /** 模块路径（与 atlas 的 p 字段一致，如 `src/lib/novel/campaign-runner.ts`）。 */
  path: string
  /** 命中时刻（epoch ms，由调用方传入）。 */
  at: number
  /** 成功/失败。 */
  ok: boolean
  /** 耗时 ms（可选）。 */
  ms?: number
  /** 人类可读补充（阶段名、章节号、缺口原因等）。 */
  detail?: string
}

/** 按模块聚合后的热度。 */
export interface ModuleHeat {
  count: number
  lastAt: number
  errors: number
  totalMs: number
  lastDetail?: string
}

/** session log 单行。 */
export interface HeatLogEntry {
  at: number
  path: string
  label: string
  ok: boolean
  ms?: number
  detail?: string
}

/** 默认环形缓冲容量（足够覆盖一次长程巡航，内存占用可忽略）。 */
export const DEFAULT_HEAT_CAPACITY = 2000

export type ModuleHeatSink = (hit: ModuleHit) => void

let sink: ModuleHeatSink | null = null

/** 注册/清除运行时 sink（store 在初始化时注册；测试可传 null 复位）。 */
export function setModuleHeatSink(next: ModuleHeatSink | null): void {
  sink = next
}

/**
 * 记录一次模块命中。未安装 sink 时静默丢弃（no-op），保证纯函数模块零副作用。
 * 调用方必须显式传入时间，避免隐藏时钟依赖。
 */
export function recordModuleHit(hit: ModuleHit): void {
  if (!sink) return
  try {
    sink(hit)
  } catch {
    // 遥测永不阻断主流程
  }
}

/** 便利封装：包住一段同步/异步工作，自动记录耗时与成败。 */
export async function withModuleHeat<T>(
  path: string,
  work: () => Promise<T>,
  options: { now: () => number; detail?: string; isOk?: (value: T) => boolean },
): Promise<T> {
  const startedAt = options.now()
  try {
    const value = await work()
    recordModuleHit({
      path,
      at: startedAt,
      ok: options.isOk ? options.isOk(value) : true,
      ms: options.now() - startedAt,
      ...(options.detail ? { detail: options.detail } : {}),
    })
    return value
  } catch (error) {
    recordModuleHit({
      path,
      at: startedAt,
      ok: false,
      ms: options.now() - startedAt,
      detail: options.detail
        ? `${options.detail}: ${error instanceof Error ? error.message : String(error)}`
        : error instanceof Error
          ? error.message
          : String(error),
    })
    throw error
  }
}

/** 把命中追加进环形缓冲（超容量丢最旧），返回新数组（不就地修改入参）。 */
export function appendHit(
  hits: readonly ModuleHit[],
  hit: ModuleHit,
  capacity = DEFAULT_HEAT_CAPACITY,
): ModuleHit[] {
  const next = hits.length >= capacity ? hits.slice(hits.length - capacity + 1) : hits.slice()
  next.push(hit)
  return next
}

/** 按模块聚合热度。 */
export function aggregateHeat(hits: readonly ModuleHit[]): Map<string, ModuleHeat> {
  const heat = new Map<string, ModuleHeat>()
  for (const hit of hits) {
    const current = heat.get(hit.path)
    if (current) {
      current.count += 1
      current.lastAt = Math.max(current.lastAt, hit.at)
      current.totalMs += hit.ms ?? 0
      if (!hit.ok) current.errors += 1
      if (hit.detail) current.lastDetail = hit.detail
    } else {
      heat.set(hit.path, {
        count: 1,
        lastAt: hit.at,
        errors: hit.ok ? 0 : 1,
        totalMs: hit.ms ?? 0,
        ...(hit.detail ? { lastDetail: hit.detail } : {}),
      })
    }
  }
  return heat
}

/** 热度归一化：把调用次数映射到 0..1（用于节点亮度/边框粗细）。 */
export function normalizeHeatLevel(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0
  const ratio = Math.log1p(count) / Math.log1p(maxCount)
  return Math.min(1, Math.max(0, ratio))
}

/** 最近的命中 → session log 行（新→旧，最多 limit 行）。 */
export function toHeatLog(
  hits: readonly ModuleHit[],
  labelOf: (path: string) => string,
  limit = 20,
): HeatLogEntry[] {
  const rows: HeatLogEntry[] = []
  for (let i = hits.length - 1; i >= 0 && rows.length < limit; i -= 1) {
    const hit = hits[i]
    rows.push({
      at: hit.at,
      path: hit.path,
      label: labelOf(hit.path),
      ok: hit.ok,
      ...(hit.ms === undefined ? {} : { ms: hit.ms }),
      ...(hit.detail ? { detail: hit.detail } : {}),
    })
  }
  return rows
}

/** 未接线分类。 */
export type UnwiredReason = "orphan" | "specOnly" | "unreachable"

export interface UnwiredModule {
  path: string
  stage: string
  reason: UnwiredReason
  loc: number
}

/**
 * 从静态地图派生「未接线」清单：
 * - orphan：没有任何非测试引用（连 barrel 都没有）
 * - specOnly：只有测试引用 —— 典型「写好了没接线」
 * - unreachable：有引用但从入口不可达（死分支）
 */
export function listUnwiredModules(atlas: ModuleAtlas): UnwiredModule[] {
  const out: UnwiredModule[] = []
  for (const entry of atlas.modules) {
    const reason = unwiredReason(entry)
    if (!reason) continue
    out.push({
      path: entry.p,
      stage: atlas.stages[entry.s]?.label ?? "其它",
      reason,
      loc: entry.l,
    })
  }
  return out.sort((a, b) => b.loc - a.loc)
}

function unwiredReason(entry: ModuleAtlasEntry): UnwiredReason | null {
  if (entry.x) return "specOnly"
  if (entry.o) return "orphan"
  if (!entry.r) return "unreachable"
  return null
}

/** 每个泳道（阶段）的覆盖率；用于顶部统计条与泳道标题。 */
export interface StageCoverage {
  stageId: string
  label: string
  modules: number
  hitModules: number
  calls: number
  unwired: number
}

export function stageCoverage(atlas: ModuleAtlas, heat: Map<string, ModuleHeat>): StageCoverage[] {
  const rows: StageCoverage[] = atlas.stages.map((stage) => ({
    stageId: stage.id,
    label: stage.label,
    modules: 0,
    hitModules: 0,
    calls: 0,
    unwired: 0,
  }))
  for (const entry of atlas.modules) {
    const row = rows[entry.s]
    if (!row) continue
    row.modules += 1
    if (unwiredReason(entry)) row.unwired += 1
    const moduleHeat = heat.get(entry.p)
    if (moduleHeat) {
      row.hitModules += 1
      row.calls += moduleHeat.count
    }
  }
  return rows
}

/** 顶部统计条。 */
export interface HeatTotals {
  modules: number
  wired: number
  unwired: number
  calledModules: number
  totalCalls: number
  errors: number
  coverage: number
}

export function heatTotals(atlas: ModuleAtlas, heat: Map<string, ModuleHeat>): HeatTotals {
  const modules = atlas.modules.length
  const unwired = atlas.modules.filter((entry) => unwiredReason(entry) !== null).length
  let calledModules = 0
  let totalCalls = 0
  let errors = 0
  for (const [path, moduleHeat] of heat) {
    if (!atlas.modules.some((entry) => entry.p === path)) continue
    calledModules += 1
    totalCalls += moduleHeat.count
    errors += moduleHeat.errors
  }
  return {
    modules,
    wired: modules - unwired,
    unwired,
    calledModules,
    totalCalls,
    errors,
    coverage: modules === 0 ? 0 : calledModules / modules,
  }
}
