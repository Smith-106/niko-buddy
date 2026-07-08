import { createAtomicJsonStore } from "./projection-store"

/**
 * R4 (S4 / ANL-013): EmotionalArcs projection — per-chapter character
 * emotional beats (emotion / intensity / trigger). ANL-013 G2 audit
 * confirmed a real gap: character-state.ts CharacterState carries
 * currentLocation/status/equipment/abilities/relationships but NO emotional
 * / mood / arc field. This projection fills that gap as a character-state
 * SAME-LAYER sibling (not a Truth Files module — ANL-013 C4 forbids a
 * second truth source; ADR-26 artifact/raw layering + A23 status.json
 * single-source must hold).
 *
 * Fold-rebuildable (S3 F-002): re-derivable from the committed snapshot
 * sequence — `arcChange`/`characterStateChanges` lines fold deterministically.
 * Persistence uses writeFileAtomic (fs.rs:1190 temp+fsync+rename) so a crash
 * mid-write never leaves a truncated emotional-arcs.json that would break
 * ingest on next load (same crash-safety contract as character-state.ts).
 *
 * MAINT-002: save/load delegated to createAtomicJsonStore (shared boilerplate
 * with resource-ledger / subplot-board). Function-name exports preserved as
 * thin wrappers — chapter-ingest.ts imports them by name.
 */

export interface EmotionalArcBeat {
  /** Canonical character name (normalized via resolveCanonicalName upstream). */
  character: string
  /** Chapter number this beat was recorded at. */
  chapterNumber: number
  /** Emotion label (e.g. 喜/怒/哀/惧/惊/惑/决意). */
  emotion: string
  /** Intensity 0..1 (best-effort; 0 when unspecified). */
  intensity: number
  /** What triggered the emotion (free text). */
  trigger: string
  /** Free-form notes. */
  notes: string
}

export interface EmotionalArcStore {
  beats: EmotionalArcBeat[]
  lastUpdated: string
}

export function createEmptyEmotionalArcStore(): EmotionalArcStore {
  return { beats: [], lastUpdated: new Date().toISOString() }
}

// MAINT-002: shared atomic JSON store (createDirectory + writeFileAtomic /
// readFile + JSON.parse with emptyCtor fallback). Replaces duplicated
// save/load boilerplate.
const emotionalArcsStore = createAtomicJsonStore<EmotionalArcStore>(
  "emotional-arcs.json",
  createEmptyEmotionalArcStore,
)

export async function saveEmotionalArcs(
  projectPath: string,
  store: EmotionalArcStore,
): Promise<void> {
  await emotionalArcsStore.save(projectPath, store)
}

export async function loadEmotionalArcs(
  projectPath: string,
): Promise<EmotionalArcStore> {
  return emotionalArcsStore.load(projectPath)
}

/**
 * Render the most recent emotional beat per character as protected-tier
 * context text. Only the latest beat per character is included (emotional
 * state is canon-current; history is retained in the store for rebuild but
 * not injected wholesale to avoid context bloat).
 */
export function emotionalArcsToContextText(store: EmotionalArcStore): string {
  if (store.beats.length === 0) return ""
  const latestByCharacter = new Map<string, EmotionalArcBeat>()
  for (const beat of store.beats) {
    const existing = latestByCharacter.get(beat.character)
    if (!existing || beat.chapterNumber >= existing.chapterNumber) {
      latestByCharacter.set(beat.character, beat)
    }
  }
  return [...latestByCharacter.values()]
    .map(
      (b) =>
        `- ${b.character}：${b.emotion}（强度${b.intensity.toFixed(2)}）${b.trigger ? `，触发：${b.trigger}` : ""}`,
    )
    .join("\n")
}
