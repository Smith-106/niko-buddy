import { createAtomicJsonStore } from "./projection-store"

export interface CharacterState {
  characterName: string
  currentLocation: string
  status: string
  equipment: string[]
  abilities: string[]
  relationships: Record<string, string>
  lastUpdatedChapter: number
  lastUpdatedAt: string
  // A19 机械层零 LLM (NovelForge-v5 EmotionTracker 移植, ISS-20260715-emotion-ledger):
  // 当前情绪快照入 CharacterState, 历史 delta 累积入独立 EmotionLedgerStore
  // (.novel/emotion-ledger.json) — 职责分离避免双真源。可选字段保向后兼容
  // (旧 character-states.json 无 emotion 字段, load 时 undefined 不报错)。
  emotion?: EmotionState
  /**
   * ADR-31 Phase 2 已落地 (LE-2): 结构化死亡标记 (替代 status 自由文本正则匹配)。
   * 生产端 (chapter-ingest.ts applyCharacterStateChangesToStore) 在死亡事件发生时
   * 写入 isAlive=false + deathChapter=chapterNumber。Additive optional — 引擎
   * detectDeadCharacterState 先读此字段 (undefined 回退 deathChapter? → status 自由
   * 文本正则匹配 deadCharacterPatterns, 守 NFR-compat-001/ADR-31 引擎对缺字段回退不抛错)。
   * 旧 character-states.json 无此字段 load 时 undefined。
   */
  isAlive?: boolean
  /**
   * ADR-31 Phase 2 已落地 (LE-2): 结构化死亡章号。
   * 生产端 (chapter-ingest.ts applyCharacterStateChangesToStore) 在死亡事件发生时写入
   * deathChapter=chapterNumber。Additive optional — 引擎先读 deathChapter?
   * (undefined 回退 status 自由文本正则匹配)。
   */
  deathChapter?: number
  /**
   * ADR-31 Phase 4 已落地: 角色最后出现章号 (chapter-ingest.ts applyCharacterStateChangesToStore
   * 结构化写入, 不再依赖 fold 反推)。Additive optional — 引擎 detectAbsentCharacter 先读此字段
   * (undefined 回退 lastUpdatedChapter, 守 NFR-compat-001/ADR-31)。
   */
  lastSeenChapter?: number
}

// A19 机械层情绪维度: valence(效价 -1消极~1积极) / arousal(唤醒 -1平静~1激动) /
// dominance(支配 -1屈从~1掌控)。三轴均为 -1.0~1.0, 由确定性算术计算非 LLM 推断。
export interface EmotionState {
  valence: number
  arousal: number
  dominance: number
}

// EmotionLedgerEntry: 每角色一条, netValue 是当前情绪净值 (机械层计算),
// history 累积每章 delta 供 Circuit Breaker 判定情绪债务。
export interface EmotionHistoryEntry {
  chapter: number
  delta: number
  reason: string
}

export interface EmotionLedgerEntry {
  characterName: string
  netValue: number
  valence: number
  arousal: number
  dominance: number
  lastUpdatedChapter: number
  history: EmotionHistoryEntry[]
}

export interface EmotionLedgerStore {
  entries: EmotionLedgerEntry[]
  lastUpdated: string
}

export interface CharacterStateStore {
  characters: CharacterState[]
  lastUpdated: string
}

export function createEmptyCharacterStateStore(): CharacterStateStore {
  return { characters: [], lastUpdated: new Date().toISOString() }
}

// E-03 (run-execute-1, 双库架构蓝图): 直写迁移到 createAtomicJsonStore 工厂
// (三模型共识 2026-09-04)。load 语义保留 ISS-20260712-010: missing/empty →
// empty store; non-empty corrupt JSON → throw (error vs no-data) — 经
// onCorrupt:"throw" 选项精确复刻; 意外读错误 (非 ENOENT) rethrow 经
// isMissingError 谓词复刻, 零行为变化。
const store = createAtomicJsonStore<CharacterStateStore>(
  "character-states.json",
  createEmptyCharacterStateStore,
  {
    onCorrupt: "throw",
    isMissingError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      return /not found|ENOENT|does not exist|os error 2|系统找不到/i.test(message)
    },
  },
)

export async function saveCharacterStates(
  projectPath: string,
  storeData: CharacterStateStore,
): Promise<void> {
  await store.save(projectPath, storeData)
}

export async function loadCharacterStates(
  projectPath: string,
): Promise<CharacterStateStore> {
  return store.load(projectPath)
}

export function characterStatesToContextText(store: CharacterStateStore): string {
  if (store.characters.length === 0) return ""
  return store.characters
    .map(
      (c) =>
        `- ${c.characterName}：位于${c.currentLocation}，状态：${c.status}，装备：${c.equipment.join("、") || "无"}，能力：${c.abilities.join("、") || "无"}`,
    )
    .join("\n")
}