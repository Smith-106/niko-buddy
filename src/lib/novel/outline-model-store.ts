/**
 * outline-model-store.ts — `.novel/outline-model.json` 侧车（sidecar）磁盘归口。
 *
 * ## 职责
 *   - `{projectPath}/.novel/outline-model.json` 读 / 写（原子写）；
 *   - 读时按 `schemaVersion` 跑 v1→v2 迁移链，迁移**在校验之前**；
 *   - 写前先校验，schemaVersion 不符直接抛错（不写坏文件）。
 *
 * ## 纪律（四条，破坏任一条都是数据事故）
 *   1. **纯 IO + 注入式 deps**（照 asset-library-store.ts:40-80）：所有磁盘动作经
 *      `OutlineModelStoreDeps` 的 readText/writeText/ensureDir，单测零磁盘。
 *      本文件是 outline-model 家族唯一的 IO 归口 —— outline-model.ts 保持零 IO。
 *   2. **迁移在校验之前**：`validateOutlineModel` 对 `schemaVersion !== 常量` 直接报错，
 *      先校验会把刚迁移的 v2 当非法，所以顺序固定为 parse → migrate → validate。
 *   3. **损坏返回 `model: null` + error，绝不降级为空模型**（D4）：大纲是权威内容，
 *      静默覆盖最危险；消费方以 `model === null` 作为「回退旧文本路径」的判据。
 *   4. **序列化不带尾随换行**（D5）：`JSON.stringify(model, null, 2)` 原样写入，
 *      不拼 `\n`；digest 与往返比对对字节差异敏感，spec 已固化该字节形态。
 *
 * 不复用 `createAtomicJsonStore` 工厂（D3）：工厂的 migrations 生产零调用、arrayFieldCaps
 * 会静默截断大纲数组（大纲不可截断）、且无法注入 deps 做迁移单测。
 *
 * @license MIT © Niko Buddy
 */

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { toErrorMessage } from "@/lib/utils"
import { OUTLINE_MODEL_SCHEMA_VERSION, validateOutlineModel, type OutlineModel } from "./outline-model"

/** 侧车文件名（`.novel/outline-model.json`）。 */
export const OUTLINE_MODEL_FILENAME = "outline-model.json"

/** 侧车文件路径：`{projectPath}/.novel/outline-model.json`（尾斜杠裁剪）。 */
export function outlineModelFilePath(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "")
  return `${trimmed}/.novel/${OUTLINE_MODEL_FILENAME}`
}

/** 注入式 deps：缺省实现走 @/commands/fs，单测注入内存实现即可零磁盘。 */
export interface OutlineModelStoreDeps {
  readonly readText?: (path: string) => Promise<string | null>
  readonly writeText?: (path: string, text: string) => Promise<void>
  readonly ensureDir?: (dir: string) => Promise<void>
}

export class OutlineModelStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OutlineModelStoreError"
  }
}

function createFsDeps(): Required<OutlineModelStoreDeps> {
  return {
    readText: async (path) => {
      try {
        return await readFile(path)
      } catch {
        // 文件缺失 / 不可读统一按「没有侧车」处理；损坏由 JSON 解析分支显式报错。
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

/**
 * 迁移步（形状对齐 projection-store.ts:56-63 的 SchemaMigrationStep 的 from/to/forward）。
 *
 * P1 不提供 `inverse`：outline-model 没有回滚入口（无运维回滚脚本消费），
 * 凭空写一个不跑的反向函数只会制造「看起来可逆」的假保证。
 */
export interface OutlineModelMigration {
  from: number
  to: number
  forward: (raw: Record<string, unknown>) => Record<string, unknown>
}

/**
 * v1→v2：唯一变化是章级 `pov`（R0 无损可逆：纯 additive 字段 + 默认值 ""）。
 *
 * 其余字段原样透传 —— 丢 volumes/chapters/entities/foreshadow/constraints/prose
 * 任一项都等于毁掉作者的大纲。
 */
export const OUTLINE_MODEL_MIGRATIONS: readonly OutlineModelMigration[] = [
  {
    from: 1,
    to: 2,
    forward: (raw) => {
      const volumes = Array.isArray(raw.volumes) ? raw.volumes : []
      const migratedVolumes = volumes.map((volumeItem) => {
        const volume = (volumeItem ?? {}) as Record<string, unknown>
        const chapters = Array.isArray(volume.chapters) ? volume.chapters : []
        const migratedChapters = chapters.map((chapterItem) => {
          const chapter = (chapterItem ?? {}) as Record<string, unknown>
          return {
            ...chapter,
            pov: typeof chapter.pov === "string" ? chapter.pov : "",
          }
        })
        return { ...volume, chapters: migratedChapters }
      })
      return { ...raw, schemaVersion: 2, volumes: migratedVolumes }
    },
  },
]

export interface OutlineModelLoadResult {
  /** null = 侧车不可用（缺失 / 损坏 / 版本更高 / 校验失败）——消费方据此回退旧文本路径。 */
  model: OutlineModel | null
  /** 发生了迁移时记录原始版本号；null = 磁盘上本来就是当前版本（幂等）。 */
  migratedFrom: number | null
  /** 失败原因（缺失时无 error —— 那不是错误，只是还没有侧车）。 */
  error?: string
}

/**
 * 读取侧车模型。
 *
 * 顺序固定：readText → typeof 守卫 → JSON.parse → 根节点形状 → 版本裁决 →
 * 迁移 → 校验。任何一步失败都返回 `model: null`（+ error），绝不抛异常、绝不降级为空模型。
 */
export async function loadOutlineModel(
  projectPath: string,
  deps: OutlineModelStoreDeps = {},
): Promise<OutlineModelLoadResult> {
  const io = { ...createFsDeps(), ...deps }
  const path = outlineModelFilePath(projectPath)

  const raw = await io.readText(path)
  // 必须用 typeof 守卫：deps 注入方可能返回 undefined（见 outline-model-store.spec.ts 的
  // readDeps(undefined) 与 context-engine.spec.ts 的显式 return undefined）。vitest 4 的
  // mockReset 恢复原实现（返回原 stub 的 ""），不是 undefined。
  if (typeof raw !== "string" || raw.trim() === "") {
    return { model: null, migratedFrom: null }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // R-28：只保留位置/语法类型，不拼接 JSON.parse 原文片段（Node 20+ 的报错会内嵌输入片段，
    // 大纲原文会被写进日志/错误串）。
    const position = /position\s+(\d+)/i.exec(toErrorMessage(error))?.[1]
    return {
      model: null,
      migratedFrom: null,
      error: position ? `JSON 解析失败（位置 ${position}）` : "JSON 解析失败（语法错误）",
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { model: null, migratedFrom: null, error: "根节点不是对象" }
  }

  let record = parsed as Record<string, unknown>

  // ── 根形状闸（R-01 critical）：`{}` / 无关 JSON / `{"volumes":[]}` 一律 model:null。
  // 不得把「无 schemaVersion」当 v1 后凭空造 volumes:[]（D-08：缺键不回落 v1）。
  if (!Object.prototype.hasOwnProperty.call(record, "schemaVersion")) {
    return {
      model: null,
      migratedFrom: null,
      error: "根形状非法：缺少 schemaVersion 字段（拒绝降级为 v1 空模型）",
    }
  }
  if (typeof record.schemaVersion !== "number" || !Number.isInteger(record.schemaVersion)) {
    // R-04：类型误写（"3" / 1.5 / null）不得回落 v1，否则绕过未来版本闸。
    return {
      model: null,
      migratedFrom: null,
      error: `schemaVersion 类型非法：${JSON.stringify(record.schemaVersion)}（期望整数）`,
    }
  }
  if (!Array.isArray(record.volumes)) {
    return {
      model: null,
      migratedFrom: null,
      error: "根形状非法：volumes 不是数组（拒绝降级为空大纲）",
    }
  }

  const declared = record.schemaVersion
  let migratedFrom: number | null = null

  if (declared > OUTLINE_MODEL_SCHEMA_VERSION) {
    // fail-loud = 拒绝读取并显式报错（不抛异常、不降级）：降级会静默毁掉更新版本的数据。
    return {
      model: null,
      migratedFrom: null,
      error: `schemaVersion 高于支持版本：${declared} > ${OUTLINE_MODEL_SCHEMA_VERSION}（拒绝读取，避免降级毁数据）`,
    }
  }

  if (declared < OUTLINE_MODEL_SCHEMA_VERSION) {
    // R-29：按 record 当前版本推进（不是按声明的起始版本全量套用）。升序/无跳步由
    // outline-model-store.spec.ts 的迁移链断言保证，不做运行时 assert（避免把库加载变成抛错源）。
    let currentVersion = declared
    for (const step of OUTLINE_MODEL_MIGRATIONS) {
      if (step.from === currentVersion && step.to > step.from && step.to <= OUTLINE_MODEL_SCHEMA_VERSION) {
        record = step.forward(record)
        currentVersion = step.to
        if (migratedFrom === null) migratedFrom = declared
      }
    }
  }

  // 迁移之后才校验：validateOutlineModel 对 schemaVersion !== 常量直接报错，
  // 先校验会把刚迁移到 v2 的记录当非法。
  const model = record as unknown as OutlineModel
  let validation: ReturnType<typeof validateOutlineModel>
  try {
    validation = validateOutlineModel(model)
  } catch (error) {
    // R-03 兜底：形状闸之后理论上不可达，但「绝不抛异常」契约的最后一道网必须存在。
    return { model: null, migratedFrom, error: `模型校验抛错：${toErrorMessage(error)}` }
  }
  if (!validation.ok) {
    return {
      model: null,
      migratedFrom,
      error: `模型校验失败：${validation.issues.join("；")}`,
    }
  }

  return { model, migratedFrom }
}

/**
 * 写入侧车模型。
 *
 * 写前两道闸：schemaVersion 必须等于当前常量、模型必须自洽 —— 否则抛
 * `OutlineModelStoreError` 且**不落盘**（宁可不写，不可写坏权威内容）。
 */
export async function saveOutlineModel(
  projectPath: string,
  model: OutlineModel,
  deps: OutlineModelStoreDeps = {},
): Promise<{ path: string }> {
  if (model.schemaVersion !== OUTLINE_MODEL_SCHEMA_VERSION) {
    throw new OutlineModelStoreError(
      `schemaVersion 不符：期望 ${OUTLINE_MODEL_SCHEMA_VERSION}，实际 ${String(model.schemaVersion)}`,
    )
  }
  const validation = validateOutlineModel(model)
  if (!validation.ok) {
    throw new OutlineModelStoreError(`模型校验失败：${validation.issues.join("；")}`)
  }

  const io = { ...createFsDeps(), ...deps }
  const trimmed = projectPath.replace(/[\\/]+$/, "")
  const path = outlineModelFilePath(projectPath)
  await io.ensureDir(`${trimmed}/.novel`)
  // D5：无尾随换行（与 projection-store.ts:133 / facts-store.ts:100 主流一致）。
  await io.writeText(path, JSON.stringify(model, null, 2))
  return { path }
}
