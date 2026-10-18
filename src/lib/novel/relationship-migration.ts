/**
 * Wave 3B 存量迁移：把 `character-states.json` 的自由文本关系一次性升级为
 * `.novel/asset-library/relationship_edge.json`（有 schema 的边）。
 *
 * 诚实边界（迁移不撒谎）：
 * - 已存在同名产物且内容与推导一致 → `noop`（幂等，不重写时间戳）。
 * - 已存在但内容不同 → `conflict`，**不覆盖**（可能是人工补全过的强度/类型），由调用方决定。
 * - 真源无关系 → `empty`（不写空产物制造"已迁移"假象）。
 * - 只写关系库这一份产物，不碰其余五库。
 */
import {
  buildLibraryArtifact,
  verifyLibraryConservation,
  type LibraryArtifact,
  type RelationshipEdgeEntry,
} from "./asset-library"
import { assetLibraryFilePath, loadAssetLibrarySnapshot, saveAssetLibraryArtifact } from "./asset-library-store"
import { deriveRelationshipEntries } from "./setting-projection"
import { loadCharacterStates } from "./character-state"

export type RelationshipMigrationStatus = "written" | "noop" | "conflict" | "empty"

export interface RelationshipMigrationResult {
  readonly status: RelationshipMigrationStatus
  readonly path: string
  readonly entryCount: number
  readonly existingHash: string | null
  readonly derivedHash: string
}

export interface RelationshipMigrationDeps {
  readonly loadStates?: (projectPath: string) => Promise<{ characters: readonly unknown[] }>
  readonly now?: () => Date
}

/** 迁移一次（幂等；冲突不覆盖）。 */
export async function migrateRelationshipLibrary(
  projectPath: string,
  deps: RelationshipMigrationDeps = {},
): Promise<RelationshipMigrationResult> {
  const loadStates = deps.loadStates ?? ((p: string) => loadCharacterStates(p))
  const raw = await loadStates(projectPath)
  const entries: RelationshipEdgeEntry[] = deriveRelationshipEntries(
    { characters: raw.characters as never },
    { projectId: undefined },
  )
  const derived: LibraryArtifact = buildLibraryArtifact({
    libraryId: "relationship_edge",
    entries,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    generatorVersion: "relationship-derive/1.0",
  })
  const path = assetLibraryFilePath(projectPath, "relationship_edge")
  const existing = await loadAssetLibrarySnapshot(projectPath, "relationship_edge")
  const existingHash = existing.present ? existing.contentHash : null

  // 只有「守恒且 hash 一致」才算已经迁移过；手改过条目但没更新 hash（conserved=false）
  // 同样是人工内容，必须走 conflict，不能被当成 noop 悄悄放过。
  if (existing.present && existing.conserved && existing.contentHash === derived.contentHash) {
    return { status: "noop", path, entryCount: entries.length, existingHash, derivedHash: derived.contentHash }
  }
  // 文件存在但解析失败 / libraryId 不符：快照是 present:false 且带 error，
  // 这**不是**「没有文件」——覆盖会毁掉人类可修的内容。
  if (existing.present || existing.error) {
    return { status: "conflict", path, entryCount: entries.length, existingHash, derivedHash: derived.contentHash }
  }
  if (entries.length === 0) {
    return { status: "empty", path, entryCount: 0, existingHash, derivedHash: derived.contentHash }
  }
  const conservation = verifyLibraryConservation(derived)
  if (!conservation.conserved) {
    throw new Error(`关系库守恒失配：expected=${conservation.expectedHash} actual=${conservation.actualHash}`)
  }
  await saveAssetLibraryArtifact(projectPath, derived)
  return { status: "written", path, entryCount: entries.length, existingHash, derivedHash: derived.contentHash }
}
