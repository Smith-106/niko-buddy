/**
 * kb-shadow-wiring.ts — R5 影子期双臂采集挂接层（镜像 anti-ai-telemetry-wiring）。
 *
 * 职责（collector 为纯模块，本层为运行时接线）：
 *   - defaultKbShadowDeps：真实落盘 deps（`@/commands/fs` IPC，避开 renderer node:fs 的
 *     ISS-020 地雷；镜像 defaultTelemetrySinkDeps 的子集）。
 *   - runKbShadowArmRetrieval：单臂检索执行器 —— 快照 store novelConfig 三 flag
 *     （dualKbRoutingEnabled / hardInjectEnabled / usefulnessRerankEnabled）→ 按臂翻转 →
 *     经注入 retrieve 取结构化命中 path[] → finally 恢复。
 *   - runKbShadowArmsIfConsented：F-34 同意门（复用 antiAiTelemetryConsent 键，默认 false
 *     = 零 IO）+ 模块级互斥（进行中采集未完成前后续触发排队，避免 flag 翻转串扰并发检索）
 *     → recordKbShadowArms（fire-and-forget，永不抛）。
 *
 * 隐私口径（与 anti-ai-telemetry 一致）：仅本地匿名落盘 JSONL，不进门裁；默认关。
 * 触发权保持显式（组合根不在项目打开时自动全量双跑——110 案×双臂为重负载；由调用方按
 * SOP docs/p0/gov-seed/README.md §四 决定时机）。
 */
import {
  readFile,
  writeFileAtomic,
  createDirectory,
  listDirectory,
} from "@/commands/fs"
import { useWikiStore, type NovelConfig } from "@/stores/wiki-store"
import { loadAntiAiTelemetryConsent } from "./anti-ai-telemetry-wiring"
import {
  recordKbShadowArms,
  type KbShadowCollectorDeps,
  type KbShadowFlags,
} from "./kb-shadow-collector"
import { novelMixedSearch } from "./search-adapter"

/** KbShadowFlags（collector/gate 命名）→ store NovelConfig 键名映射。 */
const SHADOW_FLAG_TO_STORE_KEY: ReadonlyArray<readonly [keyof KbShadowFlags, keyof NovelConfig]> = [
  ["dualKbRoutingEnabled", "dualKbRoutingEnabled"],
  ["hardInjectEnabled", "hardInjectEnabled"],
  ["usefulnessRerank", "usefulnessRerankEnabled"],
]

/** 真实落盘 deps（经 @/commands/fs IPC）。 */
export function defaultKbShadowDeps(): KbShadowCollectorDeps {
  return {
    readFile: (p) => readFile(p),
    writeFile: (p, c) => writeFileAtomic(p, c),
    createDirectory: (p) => createDirectory(p),
    listFiles: (dir) => listDirectory(dir).then((xs) => xs.map((x) => x.name)),
    now: () => new Date(),
  }
}

/** 单臂检索执行器：按臂翻转 store 三 flag → 注入 retrieve → finally 恢复。 */
export async function runKbShadowArmRetrieval(
  query: string,
  flags: KbShadowFlags,
  retrieve: (
    query: string,
    flags: KbShadowFlags,
  ) => Promise<{ hitIds: string[] }> | { hitIds: string[] },
): Promise<{ hitIds: string[] }> {
  const store = useWikiStore.getState()
  const snapshot = new Map<keyof NovelConfig, unknown>()
  for (const [, storeKey] of SHADOW_FLAG_TO_STORE_KEY) {
    snapshot.set(storeKey, store.novelConfig[storeKey])
  }
  const patch: Partial<NovelConfig> = {}
  for (const [flagKey, storeKey] of SHADOW_FLAG_TO_STORE_KEY) {
    ;(patch as Record<string, unknown>)[storeKey] = flags[flagKey]
  }
  store.setNovelConfig?.(patch as Partial<NovelConfig>)
  try {
    return await retrieve(query, flags)
  } finally {
    const restore: Partial<NovelConfig> = {}
    for (const [, storeKey] of SHADOW_FLAG_TO_STORE_KEY) {
      ;(restore as Record<string, unknown>)[storeKey] = snapshot.get(storeKey)
    }
    // 检索期间 config 可能被其他路径整体替换（罕见）；仅在 setNovelConfig 可用时恢复，避免回滚他人变更
    useWikiStore.getState().setNovelConfig?.(restore as Partial<NovelConfig>)
  }
}

/** 默认检索：novelMixedSearch（结构化三源命中 → hitIds = 命中的 path 列表）。 */
export function defaultKbShadowRetrieve(
  projectPath: string,
): (query: string, flags: KbShadowFlags) => Promise<{ hitIds: string[] }> {
  return async (query) => {
    const results = await novelMixedSearch({ projectPath, query, topK: 5 })
    return { hitIds: results.map((r) => r.path) }
  }
}

// 常驻串行队列：进行中采集完成前，后续触发排队（flag 翻转期间不被并发检索串扰）。
// 链节 settle 后即无引用，内存恒量；无需清理。
let queue: Promise<void> = Promise.resolve()

/**
 * 同意门 + 串行互斥 + 双臂采集（fire-and-forget 语义：永不抛，失败记 retrieval_error 行）。
 * @param retrieve 可选注入（测试或自定义路由）；缺省 = defaultKbShadowRetrieve(projectPath)。
 * @returns { written, failed, skipped } skipped=true 表示同意未开（零 IO，无采集）。
 */
export async function runKbShadowArmsIfConsented(
  projectPath: string,
  sid8: string,
  cases: ReadonlyArray<{
    caseId: string
    query: string
    obligationCoverage: number | null
    scaleViolation: boolean
  }>,
  deps: KbShadowCollectorDeps = defaultKbShadowDeps(),
  retrieve?: (query: string, flags: KbShadowFlags) => Promise<{ hitIds: string[] }> | { hitIds: string[] },
): Promise<{ written: number; failed: number; skipped: boolean }> {
  const consent = await loadAntiAiTelemetryConsent()
  if (!consent) return { written: 0, failed: 0, skipped: true }
  const innerRetrieve = retrieve ?? defaultKbShadowRetrieve(projectPath)
  const run = (): Promise<{ written: number; failed: number }> =>
    recordKbShadowArms(deps, projectPath, sid8, cases, (query, flags) =>
      runKbShadowArmRetrieval(query, flags, innerRetrieve),
    )
  const task = queue.then(run, run)
  queue = task.then(
    () => undefined,
    () => undefined,
  )
  try {
    const { written, failed } = await task
    return { written, failed, skipped: false }
  } catch {
    // recordKbShadowArms 内部全量 try/catch 永不抛；此处兜底，不向调用方冒泡
    return { written: 0, failed: 0, skipped: false }
  }
}
