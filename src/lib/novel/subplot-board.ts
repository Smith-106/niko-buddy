import { createAtomicJsonStore } from "./projection-store"

/**
 * R4 (S4 / ANL-013): SubplotBoard projection —支线剧情进度板. ANL-013 G2
 * audit confirmed a PARTIAL gap: foreshadowing-tracker.ts tracks
 * 埋设-回收 (plant/advance/resolve) for伏笔, but支线剧情 (subplot — a
 * branching storyline with its own progress arc, linked characters, and
 * step-by-step progress log) has no projection. This fills that gap as a
 * character-state SAME-LAYER sibling (NOT a Truth Files module — ANL-013 C4
 * forbids a second truth source; ADR-26 + A23 must hold).
 *
 * Fold-rebuildable (S3 F-002): re-derivable from the committed snapshot
 * sequence. Persistence uses writeFileAtomic (fs.rs:1190 temp+fsync+rename)
 * — crash-safe, same contract as foreshadowing-tracker.ts.
 *
 * MAINT-002: save/load delegated to createAtomicJsonStore (shared boilerplate
 * with emotional-arcs / resource-ledger). Function-name exports preserved as
 * thin wrappers — chapter-ingest.ts imports them by name.
 */

export type SubplotStatus = "proposed" | "active" | "paused" | "resolved"

export interface Subplot {
  id: string
  title: string
  status: SubplotStatus
  startChapter: number
  resolvedChapter?: number
  relatedCharacters: string[]
  summary: string
  /** Per-chapter progress log entries (append-only). */
  progress: string[]
  notes: string
  /**
   * A19 连续性引擎休眠检测用: 该 subplot 最后一次在正文中出现的章号。
   * Additive optional — 旧 subplot-board.json 无此字段 load 时 undefined 不 throw
   * (createAtomicJsonStore.load JSON.parse 后字段缺失即为 undefined, backward compat)。
   * 由 updateSubplotLastSeenChapter writehook 增量更新 (每章 accept 后调) 或
   * deriveSubplotLastSeenChapter fold 一次性反推落盘。引擎 checkDormantThreads
   * 优先读此字段, undefined 产 data_gap finding (守 IC-02 不静默降级)。
   */
  lastSeenChapter?: number
  /**
   * ADR-31 Phase 3 deferred 升级: subplot 目标回收章号 (结构化逾期判定字段)。
   * Additive optional — 引擎对缺字段回退不抛错 (守 NFR-compat-001/ADR-31)。
   * 当前 detectOverdueThread 复用 analyzeForeshadowingDebt 产 foreshadowing 逾期,
   * subplot 逾期检测待 Phase 3 升级后激活; 缺此字段产 data_gap finding 不阻断。
   */
  targetResolutionChapter?: number
  /**
   * ADR-31 Phase 3 deferred 升级: subplot 显式标记废弃 (结构化状态字段)。
   * Additive optional — 引擎对缺字段回退不抛错 (守 NFR-compat-001/ADR-31)。
   */
  abandoned?: boolean
}

export interface SubplotBoardStore {
  items: Subplot[]
  lastUpdated: string
}

export function createEmptySubplotBoardStore(): SubplotBoardStore {
  return { items: [], lastUpdated: new Date().toISOString() }
}

// MAINT-002: shared atomic JSON store (createDirectory + writeFileAtomic /
// readFile + JSON.parse with emptyCtor fallback). Replaces duplicated
// save/load boilerplate.
const subplotBoardStore = createAtomicJsonStore<SubplotBoardStore>(
  "subplot-board.json",
  createEmptySubplotBoardStore,
)

export async function saveSubplotBoard(
  projectPath: string,
  store: SubplotBoardStore,
): Promise<void> {
  await subplotBoardStore.save(projectPath, store)
}

export async function loadSubplotBoard(
  projectPath: string,
): Promise<SubplotBoardStore> {
  return subplotBoardStore.load(projectPath)
}

/**
 * Render active/paused subplots (not resolved) as protected-tier context.
 * Resolved subplots are retained in the store for rebuild/audit but not
 * injected (mirrors foreshadowingToContextText's unresolved-only filter).
 */
export function subplotBoardToContextText(store: SubplotBoardStore): string {
  const active = store.items.filter((s) => s.status !== "resolved")
  if (active.length === 0) return ""
  return active
    .map((s) => {
      const statusLabel =
        s.status === "active" ? "进行中" : s.status === "paused" ? "暂停" : "提议"
      const chars = s.relatedCharacters.length > 0 ? `（关联：${s.relatedCharacters.join("、")}）` : ""
      const progressTail = s.progress.length > 0 ? `；进度：${s.progress[s.progress.length - 1]}` : ""
      return `- [${statusLabel}] ${s.title}${chars}：${s.summary}${progressTail}`
    })
    .join("\n")
}
