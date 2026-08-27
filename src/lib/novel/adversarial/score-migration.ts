/**
 * score-migration.ts — v2.6.5 D2: 旧分迁移（保留 + legacy 标记，不重算不追溯）
 *
 * 蓝图 `docs/p0/blueprint-v265-20260826.md` D2：
 *   - 旧分保留 + legacy 标记（不重算——新基线只作用新章节）
 *   - schemaVersion 递增
 *   - 迁移纯函数（同入同出、禁副作用）
 *
 * 作者承诺（7 团队共识）：永不追溯降分、永不上调旧章门槛。
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 评分记录（旧/新）。 */
export interface ScoreRecord {
  chapterId: string
  /** 六维 overall。 */
  overall: number
  /** 各维分数。 */
  dimensions: Record<string, number>
  /** 基线版本（如 "v2.6.4"）。 */
  baselineVersion: string
  /** legacy 标记（true = 旧基线评分，不重算）。 */
  legacy: boolean
}

/** 迁移结果。 */
export interface MigrationResult {
  /** 迁移后记录（旧分保留 + legacy 标记）。 */
  records: ScoreRecord[]
  /** 新 schemaVersion。 */
  schemaVersion: string
  /** 迁移统计。 */
  stats: { total: number; legacyMarked: number; unchanged: number }
}

/** 当前 schema 版本。 */
export const SCHEMA_VERSION = "score-schema-v2"

// ============================================================================
// 迁移（纯函数——同入同出、禁副作用）
// ============================================================================

/**
 * 迁移旧评分记录：
 *   - 旧记录保留原分 + legacy=true（不重算）
 *   - 新记录（baselineVersion 已是新版本）原样保留
 *   - 纯函数：无 IO、无随机、同输入同输出
 */
export function migrateScores(records: ScoreRecord[], fromSchemaVersion: string): MigrationResult {
  const migrated = records.map((r) => {
    if (r.legacy) return r // 已标记——幂等
    if (r.baselineVersion === fromSchemaVersion) {
      return { ...r, legacy: true } // 旧基线 → 标记 legacy，保留原分
    }
    return r // 已是新基线——原样
  })
  return {
    records: migrated,
    schemaVersion: SCHEMA_VERSION,
    stats: {
      total: records.length,
      legacyMarked: migrated.filter((r) => r.legacy).length,
      unchanged: migrated.filter((r) => !r.legacy).length,
    },
  }
}

/**
 * 新章节评分（新基线——不追溯旧章节）。
 * 纯函数：输入新基线记录，输出非 legacy 记录。
 */
export function scoreWithNewBaseline(record: Omit<ScoreRecord, "legacy">): ScoreRecord {
  return { ...record, legacy: false }
}
