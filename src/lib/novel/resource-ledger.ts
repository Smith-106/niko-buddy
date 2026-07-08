import { createAtomicJsonStore } from "./projection-store"

/**
 * R4 (S4 / ANL-013): ResourceLedger projection —物品归属转移时序账本.
 * ANL-013 G2 audit confirmed a real gap: graph-adapter.ts has an `item` node
 * type (物品作 graph 节点) + chapter-ingest `resources: string` 摘要 +
 * ItemDetail{holder, previousHolders}, but there is no时序账本 tracking
 * who-held-what / when-transferred / current-归属 across chapters. This
 * projection fills that gap as a character-state SAME-LAYER sibling (NOT a
 * Truth Files module — ANL-013 C4 forbids a second truth source; ADR-26 +
 * A23 must hold).
 *
 * Fold-rebuildable (S3 F-002): re-derivable from the committed snapshot
 * sequence — ItemDetail.holder folds into transferHistory deterministically.
 * Persistence uses writeFileAtomic (fs.rs:1190 temp+fsync+rename) —
 * crash-safe, same contract as character-state.ts.
 *
 * MAINT-002: save/load delegated to createAtomicJsonStore (shared boilerplate
 * with emotional-arcs / subplot-board). Function-name exports preserved as
 * thin wrappers — chapter-ingest.ts imports them by name.
 */

export interface ResourceTransfer {
  /** Chapter number at which the transfer occurred. */
  fromChapter: number
  /** Prior holder (canonical name); empty if first acquisition. */
  fromHolder: string
  /** New holder (canonical name). */
  toHolder: string
}

export interface ResourceEntry {
  /** Item name (canonical, as surfaced in snapshot.items / ItemDetail). */
  item: string
  /** Current holder (canonical character name); empty if unowned. */
  currentHolder: string
  /** Chapter at which the item was first acquired/recorded. */
  acquiredChapter: number
  /** Prior holder at acquisition time (empty if first owner). */
  transferredFrom?: string
  /** Append-only transfer history (oldest first). */
  transferHistory: ResourceTransfer[]
}

export interface ResourceLedgerStore {
  entries: ResourceEntry[]
  lastUpdated: string
}

export function createEmptyResourceLedgerStore(): ResourceLedgerStore {
  return { entries: [], lastUpdated: new Date().toISOString() }
}

// MAINT-002: shared atomic JSON store (createDirectory + writeFileAtomic /
// readFile + JSON.parse with emptyCtor fallback). Replaces duplicated
// save/load boilerplate.
const resourceLedgerStore = createAtomicJsonStore<ResourceLedgerStore>(
  "resource-ledger.json",
  createEmptyResourceLedgerStore,
)

export async function saveResourceLedger(
  projectPath: string,
  store: ResourceLedgerStore,
): Promise<void> {
  await resourceLedgerStore.save(projectPath, store)
}

export async function loadResourceLedger(
  projectPath: string,
): Promise<ResourceLedgerStore> {
  return resourceLedgerStore.load(projectPath)
}

/**
 * Render the current holder of each tracked item as protected-tier context.
 * Full transfer history is retained in the store for rebuild/audit but only
 * the current-归属 line is injected (avoids context bloat; the latest
 * transfer is the canon-current state).
 */
export function resourceLedgerToContextText(store: ResourceLedgerStore): string {
  if (store.entries.length === 0) return ""
  return store.entries
    .map((e) => {
      if (!e.currentHolder) return `- ${e.item}：无主`
      const last = e.transferHistory[e.transferHistory.length - 1]
      const since = last ? `（第${last.fromChapter}章转手）` : `（第${e.acquiredChapter}章获得）`
      return `- ${e.item}：持有者 ${e.currentHolder}${since}`
    })
    .join("\n")
}
