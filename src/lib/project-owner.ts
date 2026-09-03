/**
 * project-owner.ts — 项目占用锁（防跨应用 `.qmai/` / `.novel/` 互相覆盖）。
 *
 * 背景（54 号设计隐患 1）：QMAI 引擎的项目内目录 `.qmai/`（novel-config.json、
 * source-watch-config.json、rerank-config.json、review.json 等）、`.novel/status.json`
 * （运行时唯一真源）与 `QM/` 是引擎级共用命名。若另一款基于同一引擎的应用
 * （QMaiWrite）打开同一项目目录，两个应用会同时写这些文件并互相覆盖。
 *
 * 本模块实现**协同协议**：打开项目时写 `.qmai/owner.json`（应用标识 + 实例 token +
 * 时间戳），冲突判定 = 异主且新鲜（STALE 窗口内）。双方都实现本协议才能互检；
 * QMAI 侧先行落地，未来引擎共用方升级后协议自动生效。
 *
 * 语义（additive，不破坏现有行为）：
 *   - 无 owner 记录 / 同主（本应用，含崩溃遗留）→ 刷新并接管，正常打开。
 *   - 异主且新鲜 → 返回冲突（调用方提示用户风险；不强制只读，避免范围爆炸）。
 *   - 异主且超过 STALE 窗口（进程已退出或长时间未活动）→ 自动接管。
 *   - 同应用多实例竞争由 tauri-plugin-single-instance（lib.rs:78）拦截，
 *     本模块不重复处理。
 */

import { readFile, writeFileAtomic } from "@/commands/fs"

/** 本应用标识（owner.json 的 app 字段）。 */
export const APP_OWNER_ID = "niko-buddy"

/** 项目占用锁文件（引擎级共用命名，QMAI 侧先行实现协议）。 */
export const PROJECT_OWNER_FILE = ".qmai/owner.json"

/** 异主记录的过期窗口（毫秒）：超过视为进程已退出，允许接管。 */
export const OWNER_STALE_MS = 15 * 60 * 1000

export interface ProjectOwnerRecord {
  schema: "project-owner/1.0"
  app: string
  /** 实例 token（同应用内区分会话，随机生成）。 */
  instance: string
  /** 最近一次打开/刷新时刻（epoch ms，用于 stale 判定）。 */
  startedAt: number
  /** 本应用退出/切项目时置 true，供他方立即接管。 */
  released?: boolean
}

export interface OwnershipClaim {
  ok: boolean
  /** 冲突 = 异主且新鲜。 */
  conflict: boolean
  /** 接管了异主遗留记录（stale 或 released）。 */
  tookOver: boolean
  /** 冲突时的占用方记录（供提示）。 */
  occupant?: ProjectOwnerRecord
}

export interface OwnerDeps {
  readFile: typeof readFile
  writeFileAtomic: typeof writeFileAtomic
  now?: () => number
  randomToken?: () => string
}

export function defaultOwnerDeps(): OwnerDeps {
  return {
    readFile,
    writeFileAtomic,
    now: () => Date.now(),
    randomToken: () =>
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `inst-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  }
}

/** 解析 owner.json（容错：畸形/空 → null）。 */
export function parseOwnerRecord(raw: string): ProjectOwnerRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectOwnerRecord> | null
    if (
      parsed &&
      typeof parsed.app === "string" &&
      parsed.app.length > 0 &&
      typeof parsed.startedAt === "number"
    ) {
      return parsed as ProjectOwnerRecord
    }
    return null
  } catch {
    return null
  }
}

/**
 * 打开项目时声明占用。返回 claim：
 *   - ok=true 且 conflict=false → 正常打开（新写/刷新/接管 stale 遗留）。
 *   - ok=false 且 conflict=true → 异主新鲜占用，调用方应提示风险。
 */
export async function claimProjectOwnership(
  projectPath: string,
  deps: OwnerDeps = defaultOwnerDeps(),
): Promise<OwnershipClaim> {
  const now = deps.now ? deps.now() : Date.now()
  const lockPath = `${projectPath}/${PROJECT_OWNER_FILE}`
  let existing: ProjectOwnerRecord | null = null
  try {
    const raw = await deps.readFile(lockPath)
    existing = parseOwnerRecord(raw)
  } catch {
    // 无 owner.json → 首次打开
  }

  if (existing) {
    if (existing.released) {
      // 对方已释放 → 立即接管
    } else if (existing.app !== APP_OWNER_ID) {
      const fresh = now - existing.startedAt < OWNER_STALE_MS
      if (fresh) {
        return { ok: false, conflict: true, tookOver: false, occupant: existing }
      }
    }
    // 同主（自愈刷新）或异主过期（接管）→ 落到下方写入
  }

  const record: ProjectOwnerRecord = {
    schema: "project-owner/1.0",
    app: APP_OWNER_ID,
    instance: (deps.randomToken ? deps.randomToken() : `inst-${now}`),
    startedAt: now,
  }
  await deps.writeFileAtomic(lockPath, JSON.stringify(record, null, 2))
  return {
    ok: true,
    conflict: false,
    tookOver: existing !== null && existing.app !== APP_OWNER_ID,
  }
}

/**
 * 切换项目/退出时释放占用（仅释放本应用的记录，绝不删异主记录）。
 */
export async function releaseProjectOwnership(
  projectPath: string,
  deps: OwnerDeps = defaultOwnerDeps(),
): Promise<void> {
  const lockPath = `${projectPath}/${PROJECT_OWNER_FILE}`
  let existing: ProjectOwnerRecord | null = null
  try {
    const raw = await deps.readFile(lockPath)
    existing = parseOwnerRecord(raw)
  } catch {
    return // 无记录无需释放
  }
  if (!existing || existing.app !== APP_OWNER_ID) return
  await deps.writeFileAtomic(
    lockPath,
    JSON.stringify({ ...existing, released: true, startedAt: existing.startedAt }, null, 2),
  )
}
