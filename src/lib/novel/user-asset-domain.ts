import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/**
 * 用户资产域 — USER ASSET DOMAIN（C-007 / C-010）
 *
 * 来源：跨项目移植专项 guidance-specification.md §12.3 C-007 + cross-role-review §A-2。
 * 上游 12 路对 F-002 技能包的数据归置未收敛（需第三域 1 / 不入双库 1 / 资料库 md +
 * 否决脚本 1），裁定为：**承认既有一库二判据不完备，新增「用户资产域」第三域**。
 *
 * 域语义（五项同时成立，缺一不可）：
 *   1. 跨项目 —— 资产不属于任何单个项目，项目切换后仍可复用；
 *   2. 用户级 —— 所有权属用户帐号（本机 profile），不属项目；
 *   3. 不可重建 —— 无法由项目内 committed 数据推导，删除即永久丢失；
 *   4. 机读 —— 以结构化格式被程序消费（不是给人读的文档）；
 *   5. 项目内只存引用 —— 项目侧**不得**落资产本体，只落 `.novel/user-asset-refs.json`
 *      的引用条目（id / kind / assetPath / contentHash / trustLevel）。
 *
 * 与 DA-01「MUST NOT 新建第三库」的关系：**「域」≠「库」**。双库（过程库 `.novel/`、
 * 资料库 `QM/`）说的是**项目内**的持久化边界；用户资产域的本体落在**项目外**的用户级
 * 路径，项目内只留引用文件——因此不构成第三库，而是既有「项目内只存引用」惯例
 * （参见 user-skill-store 的 `.qmai/writing-skills.json` 治理目录先例）的显式化。
 *
 * 落位（C-007）：
 *   - 技能包**本体** → 用户资产域（`USER_ASSET_ROOT`）；
 *   - **安装副本**   → 资料库 `QM/`；
 *   - **启用状态**   → 过程库 `.novel/`。
 *
 * 硬否决（C-007）：技能包内任何**可执行扩展名**一律拒绝导入，不提供自动执行路径。
 */

/** 用户资产域根目录（用户级、跨项目；落点在各项目之外）。 */
export const USER_ASSET_ROOT = ".qmai/user-assets"

/** 项目侧唯一落点：引用文件（只存引用，不存本体）。 */
export const USER_ASSET_REF_FILE = ".novel/user-asset-refs.json"

/** 引用文件 schema 版本（DA-03：格式演进必须向后兼容）。 */
export const USER_ASSET_REF_SCHEMA_VERSION = 1

/** 资产类别。 */
export type UserAssetKind = "skill_bundle" | "external_sample" | "other"

/** 允许的信任级别。外部资产默认 `untrusted`；`reviewed` 只能由显式人工复核提升。 */
export type UserAssetTrustLevel = "untrusted" | "reviewed"

/** 项目侧的资产引用条目。**不含资产本体内容**。 */
export interface UserAssetRef {
  /** 资产在用户资产域内的稳定 id（内容哈希前缀或包 id）。 */
  id: string
  /** 资产类别。 */
  kind: UserAssetKind
  /** 用户资产域内的相对路径（本体所在处）。 */
  assetPath: string
  /** 内容 sha256（完整性校验 + 去重；不得用时间戳判新旧）。 */
  contentHash: string
  /** 信任级别；外部资产默认 untrusted。 */
  trustLevel: UserAssetTrustLevel
  /** ISO 时间戳：引用建立时间。 */
  referencedAt: string
  /** 可选来源标识（provenance 三元组之「来源」）。 */
  origin?: string
}

export interface UserAssetRefFile {
  schemaVersion: number
  assets: UserAssetRef[]
}

/**
 * 一律拒绝的可执行扩展名（C-007 整体否决可执行脚本通道）。
 * 大小写不敏感匹配；清单取「在 Windows / macOS / Linux 三平台可直接执行或有执行语义」的并集。
 */
export const USER_ASSET_EXECUTABLE_EXTENSIONS: readonly string[] = [
  "exe",
  "dll",
  "msi",
  "bat",
  "cmd",
  "com",
  "scr",
  "ps1",
  "psm1",
  "vbs",
  "vbe",
  "js",
  "jse",
  "mjs",
  "cjs",
  "wsf",
  "wsh",
  "hta",
  "jar",
  "sh",
  "bash",
  "zsh",
  "fish",
  "run",
  "bin",
  "app",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "appimage",
  "apk",
  "so",
  "dylib",
  "py",
  "pyc",
  "rb",
  "pl",
  "lua",
  "scpt",
  "workflow",
  "command",
  "lnk",
  "reg",
  "inf",
  "sys",
  "drv",
]

/** 判定：文件名是否带可执行扩展名（C-007 拒绝条件）。 */
export function hasExecutableExtension(fileName: string): boolean {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName
  const dot = base.lastIndexOf(".")
  if (dot <= 0 || dot === base.length - 1) return false
  const ext = base.slice(dot + 1).toLowerCase()
  return USER_ASSET_EXECUTABLE_EXTENSIONS.includes(ext)
}

/**
 * 判定一批资产文件名中是否含可执行项；返回**全部**命中项（供一次性给出完整错误清单）。
 * 空数组 = 通过（可继续导入）。
 */
export function findExecutableAssets(fileNames: readonly string[]): string[] {
  return fileNames.filter((name) => hasExecutableExtension(name))
}

/** 项目内引用文件路径。 */
export function userAssetRefsPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${USER_ASSET_REF_FILE}`
}

/** 项目内库根（DA-01：仅 `.novel/` 与 `QM/` 为物理库；`canon/` 为正式正文域）。 */
export const PROJECT_LOCAL_ASSET_ROOTS: readonly string[] = [".novel", "QM", "canon"]

/**
 * 判定「项目内只存引用」这一不变量：拒绝把用户资产域本体路径写进项目。
 * 依据：C-007 第 5 项语义 + DA-01「不得新建第三库」。
 * 按**路径段**判定（而非仅前缀），故绝对路径中的库根段同样命中
 * （如 `C:/proj/.novel/x.json`）——引用条目一律禁止指向项目内。
 */
export function isProjectLocalAssetPath(path: string): boolean {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean)
  return segments.some((segment) => PROJECT_LOCAL_ASSET_ROOTS.includes(segment))
}

/** 规范化单条引用（容错读入；未知字段丢弃，缺失必填字段返回 null）。 */
export function normalizeUserAssetRef(value: unknown): UserAssetRef | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Partial<UserAssetRef>
  const id = typeof raw.id === "string" ? raw.id.trim() : ""
  const assetPath = typeof raw.assetPath === "string" ? raw.assetPath.trim() : ""
  const contentHash = typeof raw.contentHash === "string" ? raw.contentHash.trim() : ""
  if (!id || !assetPath || !contentHash) return null
  if (isProjectLocalAssetPath(assetPath)) return null
  const kind: UserAssetKind =
    raw.kind === "skill_bundle" || raw.kind === "external_sample" || raw.kind === "other"
      ? raw.kind
      : "other"
  const trustLevel: UserAssetTrustLevel = raw.trustLevel === "reviewed" ? "reviewed" : "untrusted"
  return {
    id,
    kind,
    assetPath,
    contentHash,
    trustLevel,
    referencedAt: typeof raw.referencedAt === "string" ? raw.referencedAt : "",
    ...(typeof raw.origin === "string" && raw.origin.trim() ? { origin: raw.origin.trim() } : {}),
  }
}

function emptyUserAssetRefFile(): UserAssetRefFile {
  return { schemaVersion: USER_ASSET_REF_SCHEMA_VERSION, assets: [] }
}

/**
 * 读项目侧引用文件。缺失 / 解析失败 / 结构不符 → 返回空引用集（读路径绝不抛，
 * 与 projection-status-ledger 的容错读语义一致：损坏不阻断项目打开）。
 */
export async function loadUserAssetRefs(projectPath: string): Promise<UserAssetRefFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(userAssetRefsPath(projectPath)))
  } catch {
    return emptyUserAssetRefFile()
  }
  if (!parsed || typeof parsed !== "object") return emptyUserAssetRefFile()
  const rawAssets = (parsed as { assets?: unknown }).assets
  if (!Array.isArray(rawAssets)) return emptyUserAssetRefFile()
  const assets: UserAssetRef[] = []
  for (const item of rawAssets) {
    const normalized = normalizeUserAssetRef(item)
    if (normalized) assets.push(normalized)
  }
  return { schemaVersion: USER_ASSET_REF_SCHEMA_VERSION, assets }
}

/** 写项目侧引用文件（原子写；调用方负责持项目锁——与 ledger 的写纪律一致）。 */
export async function saveUserAssetRefs(projectPath: string, file: UserAssetRefFile): Promise<void> {
  await createDirectory(`${normalizePath(projectPath)}/.novel`)
  await writeFileAtomic(
    userAssetRefsPath(projectPath),
    `${JSON.stringify({ schemaVersion: USER_ASSET_REF_SCHEMA_VERSION, assets: file.assets }, null, 2)}\n`,
  )
}

/** 幂等 upsert（同 id 覆盖；不做时间戳比较——DA-04：判新旧只用内容哈希）。 */
export function upsertUserAssetRef(assets: readonly UserAssetRef[], ref: UserAssetRef): UserAssetRef[] {
  const next = assets.filter((a) => a.id !== ref.id)
  next.push(ref)
  return next
}

/** 该资产 id 是否已被项目引用。 */
export function hasUserAssetRef(assets: readonly UserAssetRef[], id: string): boolean {
  return assets.some((a) => a.id === id)
}

/** 引用完整性校验：assetPath 不得指向项目内（C-007 第 5 项）。 */
export function assertReferenceOnlyAssets(assets: readonly UserAssetRef[]): void {
  const violations = assets.filter((a) => isProjectLocalAssetPath(a.assetPath))
  if (violations.length > 0) {
    throw new Error(
      `[user-asset-domain] project-local asset bodies are forbidden (reference-only, C-007): ${violations
        .map((v) => v.assetPath)
        .join(", ")}`,
    )
  }
}
