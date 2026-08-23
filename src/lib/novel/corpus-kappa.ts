/**
 * corpus-kappa.ts — T01b 语料标注 Cohen's κ 盲标质量门 (A-21.2 / A-23.2)
 *
 * 职责 (T01b 蓝图 §6 P0):
 *   计算双标注者 (或单执行者间隔重标) 的 Cohen's κ 系数, 评判语料标注一致性,
 *   作为 P2 反 AI 标定 (T19/T20) 与 A-21/A-23 黄金集验收的授权前提。
 *
 * 定位与边界:
 *   - 机械层零 LLM (ADR-19): 本模块不调用任何 LLM / IO / Tauri invoke,
 *     κ 计算仅算术 (混淆矩阵 → 观测一致率 Po → 期望一致率 Pe → κ = (Po-Pe)/(1-Pe))。
 *   - 与 offline-replay-config.ts 同型态: 纯数据类型 + 纯算术函数, 无运行时依赖。
 *   - Draft-first (ADR-08): κ 结果本身也先进 pending 草稿, accept 后才用于正式验收。
 *
 * κ 达标线 (T01b-2 蓝图原文 + A-21.2/A-23.2):
 *   κ ≥ 0.7 为黄金集合格线 (substantial agreement)。
 *   单执行者近似: 自我重标 + 间隔盲标 ≥ 2 周; 或降级单标注 + 构造夹具验证兜底。
 *   κ 不达标不阻塞语料入库, 但 A-21/A-23 正式验收必须以 κ≥0.7 正式集为准。
 *
 * κ 级别映射 (Landis-Koch 1977):
 *   < 0.0   = poor
 *   0.0-0.2 = slight
 *   0.21-0.40 = fair
 *   0.41-0.60 = moderate
 *   0.61-0.80 = substantial
 *   0.81-1.0  = almost-perfect
 */

/** 二元标注 (0 = 非 AI / 人写, 1 = AI 嫌疑) */
export type BinaryLabel = 0 | 1

/** 两个标注者在单篇样本上的标注对 */
export interface LabelPair {
  docId: string
  labelA: BinaryLabel
  labelB: BinaryLabel
}

/** 混淆矩阵 (用于 Cohen's κ 计算) */
export interface ConfusionMatrix {
  n00: number // A=0, B=0 (都标人写)
  n01: number // A=0, B=1 (分歧)
  n10: number // A=1, B=0 (分歧)
  n11: number // A=1, B=1 (都标 AI)
}

/** Cohen's κ 计算结果 */
export interface CohenKappa {
  kappa: number // (Po - Pe) / (1 - Pe), [-1, 1]
  po: number // 观测一致率 = (n00 + n11) / N
  pe: number // 期望一致率 = (rowA0*colB0 + rowA1*colB1) / N²
  n: number // 样本量
  agreement: KappaAgreementLevel
}

/** κ 级别 (Landis-Koch 1977) */
export type KappaAgreementLevel =
  | 'poor'
  | 'slight'
  | 'fair'
  | 'moderate'
  | 'substantial'
  | 'almost-perfect'

/** 黄金集合格线 (T01b-2 / A-21.2) */
export const GOLD_QUALIFIED_KAPPA = 0.7

/**
 * 从 LabelPair 数组构建混淆矩阵 (纯函数)
 */
export function buildConfusionMatrix(pairs: LabelPair[]): ConfusionMatrix {
  const cm: ConfusionMatrix = { n00: 0, n01: 0, n10: 0, n11: 0 }
  for (const p of pairs) {
    if (p.labelA === 0 && p.labelB === 0) cm.n00++
    else if (p.labelA === 0 && p.labelB === 1) cm.n01++
    else if (p.labelA === 1 && p.labelB === 0) cm.n10++
    else cm.n11++
  }
  return cm
}

/**
 * 将 κ 数值映射到 Landis-Koch 级别
 */
export function kappaLevel(kappa: number): KappaAgreementLevel {
  if (kappa < 0.0) return 'poor'
  if (kappa <= 0.2) return 'slight'
  if (kappa <= 0.4) return 'fair'
  if (kappa <= 0.6) return 'moderate'
  if (kappa <= 0.8) return 'substantial'
  return 'almost-perfect'
}

/**
 * Cohen's κ 计算 (纯函数, 零依赖)
 *
 * 公式: κ = (Po - Pe) / (1 - Pe)
 *   Po = (n00 + n11) / N           — 观测一致率
 *   Pe = (rowA0*colB0 + rowA1*colB1) / N²  — 期望一致率(随机也一致的基线)
 *
 * 边界:
 *   - N = 0 (空输入): 抛错 (κ 对空集无定义)
 *   - N = 1 (单样本): Pe 退化, κ 仅在两者一致时为 1, 不一致时为 0 (约定)
 *   - Pe = 1 (完美边际对齐, 分母 0): 约定 κ = 1 (两标注者分布完全相同)
 */
export function computeCohenKappa(pairs: LabelPair[]): CohenKappa {
  if (pairs.length === 0) {
    throw new Error('computeCohenKappa: empty pairs (κ undefined for N=0)')
  }

  const cm = buildConfusionMatrix(pairs)
  const n = pairs.length

  const po = (cm.n00 + cm.n11) / n

  // 边际: A 标 0 的总数 = n00+n01; A 标 1 的总数 = n10+n11
  //       B 标 0 的总数 = n00+n10; B 标 1 的总数 = n01+n11
  const rowA0 = cm.n00 + cm.n01
  const rowA1 = cm.n10 + cm.n11
  const colB0 = cm.n00 + cm.n10
  const colB1 = cm.n01 + cm.n11

  const pe = (rowA0 * colB0 + rowA1 * colB1) / (n * n)

  // 分母退化: Pe = 1 意味两标注者分布完全相同 → κ = 1 (完美一致)
  const denominator = 1 - pe
  const kappa = Math.abs(denominator) < 1e-12 ? 1.0 : (po - pe) / denominator

  return {
    kappa,
    po,
    pe,
    n,
    agreement: kappaLevel(kappa),
  }
}

/**
 * 盲标样本条目 (待标注 — 从语料抽取后 label 字段为空)
 */
export interface BlindSample {
  docId: string
  layer: 'human' | 'ai'
  genre: string // 言情 / 古风 / 玄幻 / 悬疑 ...
  filePath: string
  labelA?: BinaryLabel // 第 1 轮标注者 A
  labelB?: BinaryLabel // 第 1 轮标注者 B (或同一人间隔≥2周重标)
}

/**
 * 盲标样本抽取结果
 */
export interface BlindSampleSet {
  generatedAt: string
  perGenre: number
  samples: BlindSample[]
}

/**
 * 标注完成判定: 样本是否两端都已标注 (可计算 κ 的前提)
 */
export function isFullyLabeled(s: BlindSample): boolean {
  return s.labelA !== undefined && s.labelB !== undefined
}

/**
 * 将已完成的 BlindSample[] 转为 LabelPair[] (供 computeCohenKappa)
 * 跳过未完成标注的样本
 */
export function toLabelPairs(samples: BlindSample[]): LabelPair[] {
  return samples
    .filter(isFullyLabeled)
    .map((s) => ({
      docId: s.docId,
      labelA: s.labelA!,
      labelB: s.labelB!,
    }))
}

/**
 * 质量门判定: κ 是否达黄金集合格线 (GOLD_QUALIFIED_KAPPA = 0.7)
 */
export function isGoldQualified(result: CohenKappa): boolean {
  return result.kappa >= GOLD_QUALIFIED_KAPPA
}
