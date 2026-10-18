/**
 * asset-library-store.ts — 资产库磁盘归口（EB-2：生成器产物 → 只读 → 守恒校验 → kb-health）。
 *
 * ## 职责
 *   - `.novel/asset-library/<libraryId>.json` 读 / 写（原子写，与 .novel 其他 store 同款）；
 *   - 读时跑 `probeLibraryHealth`（守恒 + 只读 + world_sample 约束 + 跨书隔离），
 *     报告随快照返回，**不静默丢违规**；
 *   - 文件缺失 → `present:false`（诚实空态，不造条目）；损坏 → fail-loud 抛错。
 *
 * ## 纪律
 *   - 单一真源：每库一个文件，路径由 `libraryId` 确定性派生；
 *   - 只读守卫在写入侧再跑一次 `assertArtifactImmutable`（手写产物不得绕过冻结）；
 *   - 纯 IO + 注入式 deps（单测不碰磁盘）。
 *
 * @license MIT © Niko Buddy
 */

import { readFile, writeFileAtomic, createDirectory } from "@/commands/fs"
import {
  LIBRARY_IDS,
  probeLibraryHealth,
  verifyLibraryConservation,
  ASSET_LIBRARY_SCHEMA_VERSION,
  type LibraryArtifact,
  type LibraryHealthReport,
  type LibraryId,
} from "./asset-library"

/** 资产库目录名（`.novel/asset-library/`）。 */
export const ASSET_LIBRARY_DIRNAME = "asset-library"

/** 单库文件路径：`{projectPath}/.novel/asset-library/{libraryId}.json`。 */
export function assetLibraryFilePath(projectPath: string, libraryId: LibraryId): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "")
  return `${trimmed}/.novel/${ASSET_LIBRARY_DIRNAME}/${libraryId}.json`
}

export interface AssetLibraryStoreDeps {
  readonly readText?: (path: string) => Promise<string | null>
  readonly writeText?: (path: string, text: string) => Promise<void>
  readonly ensureDir?: (dir: string) => Promise<void>
}

export interface AssetLibrarySnapshot {
  readonly libraryId: LibraryId
  /** 磁盘上是否存在该库产物（false = 诚实空态，entryCount 恒 0）。 */
  readonly present: boolean
  readonly entryCount: number
  readonly contentHash: string | null
  readonly schemaVersion: string | null
  /** 只读守恒校验（present=false 时 conserved 恒 false 且不参与判定）。 */
  readonly conserved: boolean
  readonly health: LibraryHealthReport | null
  /** 读取失败原因（present=false 且 error 存在 = 损坏/不可读，不臆造）。 */
  readonly error?: string
}

export class AssetLibraryStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AssetLibraryStoreError"
  }
}

function createFsDeps(): Required<AssetLibraryStoreDeps> {
  return {
    readText: async (path) => {
      try {
        return await readFile(path)
      } catch {
        return null
      }
    },
    writeText: async (path, text) => {
      await writeFileAtomic(path, text)
    },
    ensureDir: async (dir) => {
      await createDirectory(dir)
    },
  }
}

/** 深冻结（与 asset-library 的 deepFreeze 同语义；磁盘产物读入后先冻结再跑只读守卫）。 */
function deepFreezeValue<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreezeValue((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/** 读取单库快照（缺失 → present:false；损坏 → present:false + error，绝不造条目）。 */
export async function loadAssetLibrarySnapshot(
  projectPath: string,
  libraryId: LibraryId,
  deps: AssetLibraryStoreDeps = {},
): Promise<AssetLibrarySnapshot> {
  const io = { ...createFsDeps(), ...deps }
  const path = assetLibraryFilePath(projectPath, libraryId)
  const raw = await io.readText(path)
  if (raw === null || raw.length === 0) {
    return { libraryId, present: false, entryCount: 0, contentHash: null, schemaVersion: null, conserved: false, health: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      libraryId,
      present: false,
      entryCount: 0,
      contentHash: null,
      schemaVersion: null,
      conserved: false,
      health: null,
      error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const artifact = parsed as LibraryArtifact
  if (artifact.libraryId !== libraryId) {
    return {
      libraryId,
      present: false,
      entryCount: 0,
      contentHash: null,
      schemaVersion: null,
      conserved: false,
      health: null,
      error: `libraryId 不匹配：文件内为 ${String(artifact.libraryId)}`,
    }
  }
  const entries = Array.isArray(artifact.entries) ? artifact.entries : []
  const conservation = verifyLibraryConservation(artifact)
  // 信任边界：磁盘读入的产物先深冻结再跑只读守卫——冻结防的是「进程内被改」，
  // 而「磁盘上被手改」由上面的守恒校验检出（篡改必然 hash 失配，已在 spec 覆盖）。
  const frozen = deepFreezeValue(artifact)
  return {
    libraryId,
    present: true,
    entryCount: entries.length,
    contentHash: artifact.contentHash ?? null,
    schemaVersion: artifact.schemaVersion ?? null,
    conserved: conservation.conserved,
    health: probeLibraryHealth(frozen),
  }
}

/** 读取全部 5 库快照（顺序 = LIBRARY_IDS，固定在 UI 上不抖动）。 */
export async function loadAllAssetLibrarySnapshots(
  projectPath: string,
  deps: AssetLibraryStoreDeps = {},
): Promise<AssetLibrarySnapshot[]> {
  const out: AssetLibrarySnapshot[] = []
  for (const libraryId of LIBRARY_IDS) {
    out.push(await loadAssetLibrarySnapshot(projectPath, libraryId, deps))
  }
  return out
}

/** 写入单库产物（原子写；写前校验 schemaVersion 与只读不变量，防手写脏产物落盘）。 */
export async function saveAssetLibraryArtifact(
  projectPath: string,
  artifact: LibraryArtifact,
  deps: AssetLibraryStoreDeps = {},
): Promise<{ path: string; conserved: boolean }> {
  const io = { ...createFsDeps(), ...deps }
  if (artifact.schemaVersion !== ASSET_LIBRARY_SCHEMA_VERSION) {
    throw new AssetLibraryStoreError(
      `schemaVersion 不符：期望 ${ASSET_LIBRARY_SCHEMA_VERSION}，实际 ${String(artifact.schemaVersion)}`,
    )
  }
  const conservation = verifyLibraryConservation(artifact)
  if (!conservation.conserved) {
    throw new AssetLibraryStoreError(
      `守恒失配（疑似手工篡改）：expected=${conservation.expectedHash} actual=${conservation.actualHash}`,
    )
  }
  const path = assetLibraryFilePath(projectPath, artifact.libraryId)
  await io.ensureDir(`${projectPath.replace(/[\\/]+$/, "")}/.novel/${ASSET_LIBRARY_DIRNAME}`)
  await io.writeText(path, `${JSON.stringify(artifact, null, 2)}\n`)
  return { path, conserved: true }
}
