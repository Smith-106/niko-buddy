import { readFile, writeFileAtomic, createDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/**
 * MAINT-002: 统一的 .novel/ 投影 JSON 存储工厂。消散 emotional-arcs /
 * resource-ledger / subplot-board 三个投影各自重复的 save (createDirectory +
 * writeFileAtomic) / load (try readFile + JSON.parse, catch → emptyCtor) 样板。
 *
 * 契约 (不变, 与三个投影原实现一致):
 * - save: 先 createDirectory(.novel), 再 writeFileAtomic (temp + fsync + rename)
 *   — 写中途崩溃不留截断 .json, 与 character-state.ts / foreshadowing-tracker.ts
 *   一致 (S3 F-002 crash-safety)。
 * - load: try readFile + JSON.parse; 文件不存在或解析失败 → emptyCtor() (降级,
 *   非阻断 — 投影可从 committed snapshot 重建, fold_rebuildable)。
 * - 路径: `normalizePath(projectPath)/<relativePath>` (与 emotional-arcs.ts 等
 *   原实现一致)。
 *
 * 调用方若需在 load 时做 schema 校验 (如 inspiration-entry 的 schemaVersion/
 * entries 检查), 不应使用此工厂 — 保留各自 custom load。此工厂面向 "纯 JSON
 * 降级即足够" 的投影 (emotional-arcs / resource-ledger / subplot-board 三者
 * 的 store 形状简单, 任何缺失/损坏字段在渲染层已被 createEmpty*Store/empty
 * 数组兜底)。
 *
 * E-03 (run-execute-1, 双库架构蓝图): 工厂扩展为 schema 版本化 + fold 纯性
 * 支撑 (三模型共识 2026-09-04, deepseek-v4-flash + GLM-5.3-flash + hy3):
 * - `AtomicJsonStoreOptions`: currentVersion / migrations / onMissing / onCorrupt
 *   — save 时 stamp `fileVersion`, load 时 migrate-on-read, 未知新版本 fail-loud。
 * - `FoldContext`: fold 纯性的显式时钟注入 (fold 函数体内禁止 `new Date`)。
 * - `canonicalizeForHash` / `truthStoreHash`: truth_fold_drift 的可执行定义。
 * 既有调用方 (前两参) 零改动, 向后兼容。
 */

export interface AtomicJsonStore<T> {
  save: (projectPath: string, store: T) => Promise<void>
  load: (projectPath: string) => Promise<T>
}

/**
 * E-03: fold 纯性上下文。fold 函数禁止隐式时钟 (new Date) — 时间戳只经
 * 显式 `now` 写入; 缺省时 fold 不产生新时间戳 (保留输入 store 的既有值,
 * 新条目写 ""), 保证「同输入同输出」在无 ctx 时也成立。
 */
export interface FoldContext {
  /** 显式时间戳 (ISO 串)。缺省 → fold 不写时间戳 (保留输入值, 纯性优先)。 */
  now?: string
}

/**
 * E-03: 迁移步。forward/inverse 成对注册, 保证双向可逆 (验收④)。
 * 可逆性分级 (hy3 PRO-STO-08 落实):
 * - R0 无损可逆: 纯 additive 字段 + 默认值, 旧数据零变换 (inverse∘forward=identity)。
 * - R1 信息保全降级: 字段语义变更但不销毁信息 (旧字段移入 _legacy 还原)。
 * - R2 有损: 信息确实销毁, 禁止无痕 inverse (需显式 opt-in + audit trail)。
 */
export interface SchemaMigrationStep {
  from: number
  to: number
  forward: (raw: Record<string, unknown>) => Record<string, unknown>
  inverse: (raw: Record<string, unknown>) => Record<string, unknown>
  /** 可逆性级别; R2 需 allowLossy 显式开启。 */
  reversibility: "R0" | "R1" | "R2"
}

export interface AtomicJsonStoreOptions {
  /** 当前 schema 版本 (缺省 1)。save 时 stamp fileVersion。 */
  currentVersion?: number
  /** 迁移链: 每步 forward/inverse 成对, 按 to 升序。load 时 fileVersion < currentVersion 则顺序执行 forward。 */
  migrations?: SchemaMigrationStep[]
  /** 文件缺失行为 (缺省 "empty")。cognition 用 "null"。 */
  onMissing?: "empty" | "null" | "throw"
  /** JSON 损坏行为 (缺省 "empty")。character-state / cognition 用 "throw" (ISS-20260712-010)。 */
  onCorrupt?: "empty" | "throw"
  /** R2 有损迁移的显式 opt-in (缺省 false)。 */
  allowLossy?: boolean
  /**
   * 读错误分类谓词: 返回 true 视为「文件缺失」(按 onMissing 语义处理),
   * 返回 false 视为意外错误 (rethrow)。缺省恒 true (所有读错误按缺失降级)。
   * character-state 用 ENOENT 模式谓词复刻 ISS-20260712-010 的
   * 「missing → empty; 其它错误 → rethrow」语义。
   */
  isMissingError?: (err: unknown) => boolean
}

/**
 * 创建一个 .novel/<relativePath> JSON 投影存储。
 *
 * @param relativePath 相对 .novel/ 的文件名 (如 "emotional-arcs.json")
 * @param emptyCtor    返回空 store 的工厂 (用于 load 降级)
 * @param options      E-03 版本化选项 (currentVersion/migrations/onMissing/onCorrupt)
 */
export function createAtomicJsonStore<T>(
  relativePath: string,
  emptyCtor: () => T,
  options: AtomicJsonStoreOptions = {},
): AtomicJsonStore<T> {
  const currentVersion = options.currentVersion ?? 1
  const migrations = [...(options.migrations ?? [])].sort((a, b) => a.to - b.to)
  const onMissing = options.onMissing ?? "empty"
  const onCorrupt = options.onCorrupt ?? "empty"
  const isMissingError = options.isMissingError ?? (() => true)

  return {
    async save(projectPath: string, store: T): Promise<void> {
      const pp = normalizePath(projectPath)
      await createDirectory(`${pp}/.novel`)
      // F-002: atomic write (fs.rs:1190 temp+fsync+rename) — a truncated
      // projection .json would break ingest on next load. fold_rebuildable
      // via the committed snapshot sequence, but atomicity protects the
      // rebuild path itself.
      const payload = currentVersion > 1
        ? { ...(store as Record<string, unknown>), fileVersion: currentVersion }
        : store
      await writeFileAtomic(`${pp}/.novel/${relativePath}`, JSON.stringify(payload, null, 2))
    },
    async load(projectPath: string): Promise<T> {
      const pp = normalizePath(projectPath)
      let raw: string
      try {
        raw = await readFile(`${pp}/.novel/${relativePath}`)
      } catch (err) {
        // 读错误分类: 缺失 (按 onMissing 语义) vs 意外错误 (rethrow)。
        if (!isMissingError(err)) {
          throw err instanceof Error ? err : new Error(String(err))
        }
        // 文件不存在 — 按 onMissing 语义处理 (缺省降级为空 store)。
        if (onMissing === "throw") throw new Error(`Missing truth file: .novel/${relativePath}`)
        if (onMissing === "null") return null as T
        return emptyCtor()
      }
      if (!raw || !raw.trim()) {
        // 空文件 — 与 missing 同语义 (cognition 的 ISS-20260712-010: no-data)。
        if (onMissing === "throw") throw new Error(`Empty truth file: .novel/${relativePath}`)
        if (onMissing === "null") return null as T
        return emptyCtor()
      }
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        if (onCorrupt === "throw") {
          throw new Error(`Failed to parse ${relativePath}: ${detail}`)
        }
        // 文件损坏 (截断/撕裂) — 降级为空 store, 不抛。投影可从 committed
        // snapshot 重建 (fold_rebuildable)。
        return emptyCtor()
      }
      // E-03: schema 版本化 — 读 fileVersion (缺省 1 = 隐式 v1, 旧文件永不拒绝)。
      const fileVersion = typeof parsed.fileVersion === "number" ? parsed.fileVersion : 1
      if (fileVersion > currentVersion) {
        // 未知新版本 fail-loud: 降级 emptyCtor 会静默毁掉新数据, 违背可逆性。
        throw new Error(
          `Truth file .novel/${relativePath} has fileVersion ${fileVersion} > current ${currentVersion}; ` +
          `refusing to read (upgrade the reader or roll back the file)`,
        )
      }
      if (fileVersion < currentVersion) {
        let migrated = parsed
        for (const step of migrations) {
          if (step.from >= fileVersion && step.to <= currentVersion && step.from < step.to) {
            if (step.reversibility === "R2" && !options.allowLossy) {
              throw new Error(
                `Migration ${step.from}→${step.to} for ${relativePath} is lossy (R2) and not opted in`,
              )
            }
            migrated = step.forward(migrated)
          }
        }
        return migrated as T
      }
      return parsed as T
    },
  }
}

/**
 * E-03: 显式回滚入口 — 把 .novel/<relativePath> 沿 inverse 链降级到 targetVersion。
 * 供运维回滚脚本 (scripts/rollback-truth-files.mjs) 调用; 逻辑不重复。
 */
export async function migrateTruthFileBackward(
  projectPath: string,
  relativePath: string,
  targetVersion: number,
  options: AtomicJsonStoreOptions = {},
): Promise<{ from: number; to: number }> {
  const pp = normalizePath(projectPath)
  const currentVersion = options.currentVersion ?? 1
  if (targetVersion >= currentVersion) {
    throw new Error(`targetVersion ${targetVersion} must be < currentVersion ${currentVersion}`)
  }
  const raw = await readFile(`${pp}/.novel/${relativePath}`)
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const fileVersion = typeof parsed.fileVersion === "number" ? parsed.fileVersion : 1
  if (fileVersion <= targetVersion) {
    return { from: fileVersion, to: fileVersion }
  }
  const steps = [...(options.migrations ?? [])]
    .filter((s) => s.to > targetVersion && s.to <= fileVersion)
    .sort((a, b) => b.to - a.to)
  let migrated = parsed
  for (const step of steps) {
    if (step.reversibility === "R2" && !options.allowLossy) {
      throw new Error(`Inverse migration ${step.from}→${step.to} for ${relativePath} is lossy (R2) and not opted in`)
    }
    migrated = step.inverse(migrated)
  }
  const payload = targetVersion > 1
    ? { ...migrated, fileVersion: targetVersion }
    : stripFileVersion(migrated)
  await writeFileAtomic(`${pp}/.novel/${relativePath}`, JSON.stringify(payload, null, 2))
  return { from: fileVersion, to: targetVersion }
}

function stripFileVersion(raw: Record<string, unknown>): Record<string, unknown> {
  const { fileVersion: _fileVersion, ...rest } = raw
  return rest
}

/**
 * E-03: 稳定序列化 — 递归排序对象键 + 剔除易变元数据字段 (lastUpdated /
 * fileVersion / 任何 At$ 后缀墙钟字段), 供 truth_fold_drift 哈希比对。
 * 注意: 认识论字段 validAt/invalidAt/revealedAt 是数据而非易变戳, 不在剔除集
 * (GLM D-GLM2 裁决: 显式清单优于命名正则)。
 */
export function canonicalizeForHash<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForHash(item)) as T
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      if (isVolatileKey(key)) continue
      out[key] = canonicalizeForHash(record[key])
    }
    return out as T
  }
  return value
}

/** 易变元数据键: lastUpdated / fileVersion / 墙钟后缀 (At$ 结尾且非认识论字段)。 */
function isVolatileKey(key: string): boolean {
  if (key === "lastUpdated" || key === "fileVersion") return true
  // 认识论字段 (validAt/invalidAt/revealedAt) 是数据, 不剔除。
  if (key === "validAt" || key === "invalidAt" || key === "revealedAt") return false
  return /At$/.test(key)
}

/**
 * E-03: 真相文件状态哈希 — sha256 over canonicalizeForHash 的稳定 JSON。
 * 供 computeTruthFoldDrift 比对 live 盘上 store 与快照重放 store。
 */
export async function truthStoreHash(store: unknown): Promise<string> {
  const canonical = canonicalizeForHash(store)
  const bytes = new TextEncoder().encode(JSON.stringify(canonical))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
