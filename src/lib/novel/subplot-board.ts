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
