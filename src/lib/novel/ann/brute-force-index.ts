/**
 * ann/brute-force-index.ts — B3-b 精确暴力参考实现（批准计划 r3 §T6）。
 *
 * 用途（**仅参考，不是可用性证据**）：
 *   - 作为 `AnnIndex` 接口的一致性靶子（任何近似实现须与本实现同 schema、同名次口径）；
 *   - 作为延迟基线与未来近似实现的**回归地板**（recall 只允许向上、延迟只允许向下）。
 *
 * 口径：
 *   - 打分：`cosine` = 余弦相似度（零范数 → 0）；`l2` = 负欧氏距离（保证「越大越优」单调）。
 *   - 全序：score desc → id asc（确定性 tie-break；同分不依赖插入顺序）。
 *
 * 硬边界：纯计算，零 IO / 零时钟 / 零模型调用；不改变 `ANN_PLAN.implemented=false`。
 *
 * @license MIT © QMAI
 */
import {
  ANN_DESCRIPTOR_SCHEMA,
  ANN_HIT_SCHEMA,
  ANN_QUERY_SCHEMA,
  ANN_VECTOR_SCHEMA,
  AnnIndexError,
  type AnnDescriptor,
  type AnnHit,
  type AnnIndex,
  type AnnMetric,
  type AnnQuery,
  type AnnVector,
} from "./ann-index"

export interface ExactAnnIndexOptions {
  metric?: AnnMetric
  /** 能力/限制声明（缺省给出口径声明：精确 1.0 不构成 ANN 可用性证据）。 */
  note?: string
}

const DEFAULT_NOTE =
  "精确暴力参考实现：recall@k 相对自身恒 1.0，不构成 ANN 可用性证据；价值=接口一致性 + 延迟基线"

function scoreOf(metric: AnnMetric, a: readonly number[], b: readonly number[]): number {
  if (metric === "cosine") {
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      const x = a[i] ?? 0
      const y = b[i] ?? 0
      dot += x * y
      na += x * x
      nb += y * y
    }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    sum += d * d
  }
  return -Math.sqrt(sum)
}

/** 创建精确暴力索引（`exact: true`）。 */
export function createExactAnnIndex(options: ExactAnnIndexOptions = {}): AnnIndex {
  const metric: AnnMetric = options.metric ?? "cosine"
  const note = options.note ?? DEFAULT_NOTE
  let vectors: AnnVector[] = []
  let dimension = 0

  return {
    build(input: readonly AnnVector[]): void {
      const parsed: AnnVector[] = []
      const ids = new Set<string>()
      let dim = 0
      for (const raw of input) {
        const result = ANN_VECTOR_SCHEMA.safeParse(raw)
        if (!result.success) {
          throw new AnnIndexError(`向量非法：${result.error.message}`)
        }
        const vector = result.data
        if (ids.has(vector.id)) throw new AnnIndexError(`向量 id 重复：${vector.id}`)
        ids.add(vector.id)
        if (dim === 0) dim = vector.values.length
        else if (vector.values.length !== dim) {
          throw new AnnIndexError(
            `向量维度不一致：${vector.id} 为 ${vector.values.length}，索引维度为 ${dim}`,
          )
        }
        parsed.push(vector)
      }
      vectors = parsed
      dimension = dim
    },

    search(query: AnnQuery): AnnHit[] {
      const parsed = ANN_QUERY_SCHEMA.safeParse(query)
      if (!parsed.success) throw new AnnIndexError(`查询非法：${parsed.error.message}`)
      if (vectors.length === 0) return []
      if (dimension !== 0 && parsed.data.values.length !== dimension) {
        throw new AnnIndexError(
          `查询维度不一致：${parsed.data.values.length} ≠ 索引维度 ${dimension}`,
        )
      }
      const scored = vectors.map((v) => ({
        id: v.id,
        score: scoreOf(metric, parsed.data.values, v.values),
      }))
      scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      return scored.slice(0, parsed.data.k).map((s, i) =>
        ANN_HIT_SCHEMA.parse({ id: s.id, score: s.score, rank: i + 1 }),
      )
    },

    descriptor(): AnnDescriptor {
      return ANN_DESCRIPTOR_SCHEMA.parse({
        kind: "exact",
        metric,
        dimension: dimension === 0 ? 1 : dimension,
        size: vectors.length,
        exact: true,
        note,
      })
    },

    size(): number {
      return vectors.length
    },
  }
}
