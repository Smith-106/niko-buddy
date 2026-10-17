/**
 * module-atlas.ts — 静态模块地图的类型化读取层。
 *
 * 真源：`module-atlas.generated.json`（由 `npm run gen:atlas` 生成，`gen:check` 门禁校验，
 * 禁止手工编辑）。本文件只做类型声明与索引/标签等派生查询，零 IO。
 *
 * @license MIT © Niko Buddy
 */

import rawAtlas from "./module-atlas.generated.json"

/** 生成物里的紧凑模块记录（键名保持单字母以压体积）。 */
export interface ModuleAtlasEntry {
  /** 路径（仓内相对，正斜杠） */
  p: string
  /** 泳道序号（对应 ModuleAtlas.stages 下标） */
  s: number
  /** 行数 */
  l: number
  /** 入口可达 */
  r: boolean
  /** 孤立：无任何非测试引用（含 barrel） */
  o: boolean
  /** 仅测试引用（写好了没接线的典型） */
  x: boolean
  /** 出边模块序号 */
  i: number[]
  /** 外部依赖包名 */
  e?: string[]
}

export interface ModuleAtlasStage {
  id: string
  label: string
}

export interface ModuleAtlas {
  schemaVersion: number
  generator: string
  stages: ModuleAtlasStage[]
  stats: Record<string, number>
  modules: ModuleAtlasEntry[]
}

/** 全量地图（构建期折叠进产物，运行时零解析成本）。 */
export const MODULE_ATLAS = rawAtlas as ModuleAtlas

/** 路径 → 记录。 */
export function buildAtlasIndex(atlas: ModuleAtlas = MODULE_ATLAS): Map<string, ModuleAtlasEntry> {
  return new Map(atlas.modules.map((entry) => [entry.p, entry]))
}

/** 模块短名（去掉目录与扩展名），用于节点标题与 session log。 */
export function moduleLabel(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const base = normalized.slice(normalized.lastIndexOf("/") + 1)
  return base.replace(/\.(tsx?|mts|json)$/, "")
}

/** 模块所属泳道标签。 */
export function moduleStageLabel(path: string, atlas: ModuleAtlas = MODULE_ATLAS): string {
  const entry = buildAtlasIndex(atlas).get(path)
  if (!entry) return "未收录"
  return atlas.stages[entry.s]?.label ?? "其它"
}

/** 出边模块路径（供视图画连线）。 */
export function moduleEdges(path: string, atlas: ModuleAtlas = MODULE_ATLAS): string[] {
  const index = buildAtlasIndex(atlas)
  const entry = index.get(path)
  if (!entry) return []
  return entry.i
    .map((target) => atlas.modules[target]?.p)
    .filter((target): target is string => typeof target === "string")
}
