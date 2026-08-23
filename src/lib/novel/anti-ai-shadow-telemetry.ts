/**
 * anti-ai-shadow-telemetry.ts — T24-01 影子遥测接线（#34 ≥200 章累积钟）
 *
 * 定位：生产评审调用方层（runFullReviewWithSixDim）跑 mech 四因子仅供 sink 记录，
 *      **不并入 reviewResults/gate**——门裁语义零变更（影子模式）。
 *      强制态（四因子 findings 进 anti_ai 门）待 ≥200 章遥测数据验证后再接。
 *
 * node:fs 地雷隔离（ISS-020 同类）：AntiAiCandidatePool 运行时依赖 node:fs +
 *      import.meta.url 解析语料路径。本模块用 **动态 import** 把池构造隔离到独立
 *      chunk，静态导入本模块不会拖入 node:fs（保 deep-chapter-generation 主链干净）。
 *      生产打包无 docs/p0/corpus → loadCorpus 失败被 try/catch 吞 → 池降级空语料，
 *      analyze() 仍跑（n-gram/标点因子返回中性，PL CV/熵正常算）。
 *
 * 语料降级说明：合成种子 batch-20260821-001 未随包（Tauri bundle 仅含 skills/），
 *      故生产侧仅 PL CV + sentenceEntropy 两因子产真值；n-gram/标点因子中性直至
 *      「语料打包策略」落地（bundle synthetic seeds 或 IPC 预加载）。
 */
import { combinePacks, runRuleStack } from "./rule-stack"
import { composeCoreRulePacks } from "./packs/shared-text-features"
import { getAntiAiTelemetrySink, recordPoolReport } from "./anti-ai-telemetry-sink"
import type { AntiAiAnalysisReport } from "./anti-ai-candidate-pool"

// 池单例：undefined=未初始化, null=构造/载入失败, AntiAiCandidatePool=可用
type PoolLike = { analyze(text: string): AntiAiAnalysisReport; loadCorpus(): unknown }
let _shadowPool: PoolLike | null | undefined

/**
 * 影子遥测记录：fire-and-forget，永不抛、永不阻塞主评审流。
 * 仅当 F-34 同意（sink 已 init）且池可用时才真正记录。
 */
export async function recordAntiAiShadowTelemetry(
  content: string,
  chapterNumber: number | undefined,
): Promise<void> {
  const sink = getAntiAiTelemetrySink()
  if (!sink) return // F-34 未同意 → 不记
  const pool = await getShadowPool()
  if (!pool) return // 池构造失败 → 不记（非致命）

  let captured: AntiAiAnalysisReport | null = null
  const packs = composeCoreRulePacks({
    chapterContent: content,
    origin: "ai_draft",
    pool: pool as never, // PoolLike 满足 AntiAiPoolLike 的 analyze 契约
    onPoolReport: (r) => {
      captured = r
    },
  })
  // 跑规则栈触发 mech 包规则求值 → getPoolReport memo → onPoolReport 回调
  runRuleStack(combinePacks(packs), { isFinale: false })
  if (captured) {
    recordPoolReport(captured, {
      chapter: chapterNumber ?? 0,
      text: content,
    })
  }
}

/** 动态 import 池模块（隔离 node:fs），best-effort 构造 + 载入语料。 */
async function getShadowPool(): Promise<PoolLike | null> {
  if (_shadowPool !== undefined) return _shadowPool
  try {
    const mod = await import("./anti-ai-candidate-pool")
    const pool = new mod.AntiAiCandidatePool()
    try {
      pool.loadCorpus() // 生产无 corpus → 抛错被吞 → 空语料降级（因子中性）
    } catch {
      /* 语料不可用：池仍可 analyze（PL/熵正常，n-gram/标点中性） */
    }
    _shadowPool = pool as PoolLike
  } catch {
    _shadowPool = null // 模块 import 失败（node:fs 不可达）→ 永久降级
  }
  return _shadowPool
}

/** 仅测试用：重置池单例。 */
export function __resetShadowPoolForTest(): void {
  _shadowPool = undefined
}
