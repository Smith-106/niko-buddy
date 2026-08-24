/**
 * corpus-guard.mjs — 语料消费端守卫（N2/N3 落地，20260824 三模型共识）
 *
 * 职责分离：
 *   - manifest.json 是状态权威（indexed/quarantined/pending/blocked）
 *   - 各消费脚本的批次 pin 清单是实验设计权威（保持硬编码，保证报告可比性）
 *   - 本模块只做两者的 fail-closed 合取断言，不替实验做发现/决定
 *
 * 消费端接入约定：脚本启动时对全部将消费的批次调用 assertBatchesIndexed，
 * 任一批非 indexed 即 throw（退出码 1），不静默缩样。
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

/** manifest 中可被任何消费端打包/标定的唯一合法状态（允许表，非黑名单） */
export const CONSUMABLE_STATUS = "indexed"

/** genre 枚举（同源：ingest-authorized-corpus.mjs / manifest.template.json §4 / manifest corpus_meta.genres） */
export const GENRE_ENUM = [
  "yanqing", "gufeng", "xuanhuan", "xuanyi", "dushi", "kehuan",
  "xihuan", "lishi", "youxi", "qingxs", "qita",
]

/**
 * 断言 batchIds 全部存在于 manifest.batches 且 status === "indexed"。
 * - id 允许带或不带 "batch-" 前缀（内部归一化，manifest 权威形式带前缀）
 * - manifest 缺失 / JSON 损坏 / 任一批非 indexed → throw（fail-closed，不静默缩样）
 * - batchIds 为空数组 → no-op（调用方自行负责非空约束）
 */
export function assertBatchesIndexed(corpusRoot, batchIds) {
  if (!batchIds || batchIds.length === 0) return
  const manifestPath = resolve(corpusRoot, "manifest.json")
  if (!existsSync(manifestPath)) {
    throw new Error(`[corpus-guard] manifest 不存在，拒绝消费语料: ${manifestPath}`)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (err) {
    throw new Error(`[corpus-guard] manifest 解析失败，拒绝消费语料: ${err instanceof Error ? err.message : String(err)}`)
  }
  const statusById = new Map((manifest.batches ?? []).map((b) => [b.id, b.status]))
  const offenders = []
  for (const raw of batchIds) {
    const id = raw.startsWith("batch-") ? raw : `batch-${raw}`
    const status = statusById.get(id)
    if (status === undefined) offenders.push(`${id}: 不在 manifest`)
    else if (status !== CONSUMABLE_STATUS) offenders.push(`${id}: status=${status}（仅 indexed 可消费）`)
  }
  if (offenders.length > 0) {
    throw new Error(`[corpus-guard] 批次不可消费:\n  ${offenders.join("\n  ")}`)
  }
}
