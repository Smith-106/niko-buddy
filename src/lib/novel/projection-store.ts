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
 */
export interface AtomicJsonStore<T> {
  save: (projectPath: string, store: T) => Promise<void>
  load: (projectPath: string) => Promise<T>
}

/**
 * 创建一个 .novel/<relativePath> JSON 投影存储。
 *
 * @param relativePath 相对 .novel/ 的文件名 (如 "emotional-arcs.json")
 * @param emptyCtor    返回空 store 的工厂 (用于 load 降级)
 */
export function createAtomicJsonStore<T>(
  relativePath: string,
  emptyCtor: () => T,
): AtomicJsonStore<T> {
  return {
    async save(projectPath: string, store: T): Promise<void> {
      const pp = normalizePath(projectPath)
      await createDirectory(`${pp}/.novel`)
      // F-002: atomic write (fs.rs:1190 temp+fsync+rename) — a truncated
      // projection .json would break ingest on next load. fold_rebuildable
      // via the committed snapshot sequence, but atomicity protects the
      // rebuild path itself.
      await writeFileAtomic(`${pp}/.novel/${relativePath}`, JSON.stringify(store, null, 2))
    },
    async load(projectPath: string): Promise<T> {
      const pp = normalizePath(projectPath)
      try {
        const raw = await readFile(`${pp}/.novel/${relativePath}`)
        return JSON.parse(raw) as T
      } catch {
        // 文件不存在或解析失败 (截断/损坏) — 降级为空 store, 不抛。
        // 投影可从 committed snapshot 重建 (fold_rebuildable)。
        return emptyCtor()
      }
    },
  }
}
