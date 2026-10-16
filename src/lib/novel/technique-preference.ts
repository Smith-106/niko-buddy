/**
 * technique-preference.ts — T3 技法偏好回灌最小版 (用户 accept/reject 反馈 → 技法选择偏好)。
 *
 * 范围 (最小版): 纯偏好记账 + 持久化 + 轮选，不接执行。
 * - recordFeedback / scorePreference / chooseTechniqueIndex 均为纯函数 (零 IO、零时钟)。
 * - PreferenceStore 读写 `${pp}/.novel/technique-preference.json`，
 *   读失败 (缺失/损坏/形状非法) 降级 {}，写经 writeFileAtomic 原子落盘
 *   (与 aura-evolution / canon-dual-write 同款 @/commands/fs 通道)。
 * - context-engine 侧仅 TODO 注释，不动执行 (见 loadTechniqueBlocks)。
 */

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/** 单个技法 id 的偏好计数 (accept=采纳次数, reject=拒绝次数)。 */
export interface TechniquePreference {
  accept: number
  reject: number
}

/** key=技法 id, value=偏好计数。 */
export type PreferenceMap = Record<string, TechniquePreference>

/** 带分数的候选项 (id 标识技法, score 为 scorePreference 结果)。 */
export interface ScoredTechnique {
  id: string
  score: number
}

/** 偏好持久化文件名 (.novel/ 下)。 */
const PREFERENCE_FILENAME = "technique-preference.json"

/** 偏好文件绝对路径 (`${pp}/.novel/technique-preference.json`)。 */
export function preferenceStorePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/${PREFERENCE_FILENAME}`
}

function emptyPreference(): TechniquePreference {
  return { accept: 0, reject: 0 }
}

/**
 * 记录一次用户反馈 (纯函数, 不修改入参 map, 返回新对象)。
 * accepted=true → accept+1, 否则 reject+1；缺失条目从 {accept:0, reject:0} 起算。
 */
export function recordFeedback(map: PreferenceMap, id: string, accepted: boolean): PreferenceMap {
  const prev = map[id] ?? emptyPreference()
  const next: TechniquePreference = accepted
    ? { accept: prev.accept + 1, reject: prev.reject }
    : { accept: prev.accept, reject: prev.reject + 1 }
  return { ...map, [id]: next }
}

/** 偏好分数 = accept - reject；条目缺失 (undefined) → 0。 */
export function scorePreference(p: TechniquePreference | undefined): number {
  if (!p) return 0
  return p.accept - p.reject
}

/**
 * 在 poolSize 个候选中选一个下标 (纯函数)。
 * prefs 非空且最高分 > 0 → 分数最高者 (并列取首个) 的下标；
 * prefs 为空或全部分数 ≤ 0 → 回退 cursor % poolSize (负 cursor 归一化到 [0, poolSize))；
 * poolSize ≤ 0 → 0。
 */
export function chooseTechniqueIndex(
  poolSize: number,
  cursor: number,
  prefs: ScoredTechnique[],
): number {
  if (!Number.isInteger(poolSize) || poolSize <= 0) return 0
  let best = -1
  for (let i = 0; i < prefs.length; i++) {
    if (best < 0 || prefs[i].score > prefs[best].score) best = i
  }
  if (best >= 0 && prefs[best].score > 0) return best
  return ((cursor % poolSize) + poolSize) % poolSize
}

/** 将未知 JSON 清洗为 PreferenceMap (形状非法处降级，不抛)。 */
function sanitizePreferenceMap(raw: unknown): PreferenceMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: PreferenceMap = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const rec = value as Record<string, unknown>
    const accept: unknown = rec["accept"]
    const reject: unknown = rec["reject"]
    out[id] = {
      accept: typeof accept === "number" ? accept : 0,
      reject: typeof reject === "number" ? reject : 0,
    }
  }
  return out
}

/** 偏好存储 (load/save)；读失败降级 {}，写经 writeFileAtomic。 */
export interface PreferenceStore {
  load: (projectPath: string) => Promise<PreferenceMap>
  save: (projectPath: string, map: PreferenceMap) => Promise<void>
}

export function createPreferenceStore(): PreferenceStore {
  return {
    async load(projectPath: string): Promise<PreferenceMap> {
      try {
        const raw = await readFile(preferenceStorePath(projectPath))
        if (!raw || !raw.trim()) return {}
        return sanitizePreferenceMap(JSON.parse(raw) as unknown)
      } catch {
        // 文件缺失 / 解析失败 / 形状非法 → 降级空偏好，不阻断。
        return {}
      }
    },
    async save(projectPath: string, map: PreferenceMap): Promise<void> {
      const pp = normalizePath(projectPath)
      await createDirectory(`${pp}/.novel`)
      // F-002 同款原子写 (temp + fsync + rename)，崩溃不留截断 JSON。
      await writeFileAtomic(preferenceStorePath(projectPath), JSON.stringify(map, null, 2))
    },
  }
}

/** 默认单例 store (与 aura-evolution 同款模块级 store 模式)。 */
export const preferenceStore: PreferenceStore = createPreferenceStore()
