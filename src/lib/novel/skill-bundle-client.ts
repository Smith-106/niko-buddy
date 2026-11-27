/**
 * skill-bundle-client.ts — F-002 技能包离线协议的 TS 封装（TASK-005 / TASK-006）。
 *
 * 职责边界：
 *   - **不重新实现安全策略**，只做 Rust 侧契约的镜像与前置体检。真正的拒绝发生在
 *     `src-tauri/src/commands/skill_bundle.rs`（条目守卫 / 清单校验 / 写入权威 / 原子
 *     promote）。这里的前置检查是为了让 UI 在**触盘之前**就能给出明确理由。
 *   - **零网络**：C-013 明令不得提供上传/下载端点，本模块只涉及本地文件路径。
 *   - **信任级别恒为 untrusted**：`trust_level` 由导入器盖章，客户端不采信包内自述。
 */

import { invoke } from "@tauri-apps/api/core"

/** 包格式标识（与 Rust 侧 `SKILL_BUNDLE_SCHEMA` 同值）。 */
export const SKILL_BUNDLE_SCHEMA = "nbskill/1"

/** 清单 schema 版本。 */
export const SKILL_BUNDLE_SCHEMA_VERSION = 1

/** 导入器盖章值。 */
export const SKILL_BUNDLE_TRUST_UNTRUSTED = "untrusted"

/** 人工复核通过后由独立收据文件背书的信任级别（不采信 `manifest.json` 自述）。 */
export const SKILL_BUNDLE_TRUST_REVIEWED = "reviewed"

/** 技能包信任级别。 */
export type SkillBundleTrustLevel =
  | typeof SKILL_BUNDLE_TRUST_UNTRUSTED
  | typeof SKILL_BUNDLE_TRUST_REVIEWED
  | (string & {})

/** 条目数上限（与 Rust `MAX_ENTRIES` 同值）。 */
export const SKILL_BUNDLE_MAX_ENTRIES = 512

/** 解压后总字节上限（与 Rust `MAX_BYTES` 同值）。 */
export const SKILL_BUNDLE_MAX_BYTES = 32 * 1024 * 1024

/** 扩展名 allowlist（G-6；与 Rust `ALLOWED_EXTENSIONS` 同值）。 */
export const SKILL_BUNDLE_ALLOWED_EXTENSIONS = ["md", "txt", "json", "yaml", "csv", "png", "svg"] as const

/** 可执行扩展名 denylist（C-007：脚本通道整体否决）。 */
export const SKILL_BUNDLE_EXECUTABLE_EXTENSIONS = [
  "exe", "dll", "so", "dylib", "ps1", "bat", "cmd", "com", "scr", "sh", "bash", "zsh", "fish",
  "py", "pyc", "js", "mjs", "cjs", "rb", "pl", "wasm",
] as const

/** 技能可写产物白名单（G-6）：未声明即拒绝。 */
export interface SkillBundleAllowlist {
  readable_state: string[]
  writable_artifacts: string[]
}

/** 清单内的单文件引用。 */
export interface BundleFileRef {
  path: string
  hash: string
  size: number
}

/** 技能包清单。 */
export interface SkillBundleManifest {
  schema: string
  schema_version: number
  id: string
  name: string
  version: string
  content_hash: string
  source: string
  trust_level: string
  min_nb_version: string
  deps?: string[]
  allowlist: SkillBundleAllowlist
  files?: BundleFileRef[]
}

/** 导出结果。 */
export interface SkillBundleExportResult {
  bundle_path: string
  id: string
  version: string
  content_hash: string
  manifest_sha256: string
  file_count: number
  total_bytes: number
}

/** 校验结果。 */
export interface SkillBundleVerifyResult {
  ok: boolean
  schema_version: number
  trust_level: string
  manifest_sha256: string
  content_hash: string
  mismatched: string[]
  rejected: string[]
  entry_count: number
  total_bytes: number
  /** 清单本体（导入对话框逐项展示用）。 */
  manifest?: SkillBundleManifest
}

/** 导入结果。 */
export interface SkillBundleImportResult {
  ok: boolean
  id: string
  name: string
  version: string
  trust_level: string
  installed_dir: string
  content_hash: string
  manifest_sha256: string
  file_count: number
  total_bytes: number
  readable_state: string[]
  writable_artifacts: string[]
  warnings: string[]
}

/** 已安装技能包清单条目（对应 Rust `skill_bundle_list_installed` 返回）。 */
export interface SkillBundleInstalledEntry {
  id: string
  name: string
  version: string
  installed_dir: string
  trust_level: SkillBundleTrustLevel
  content_hash: string
  manifest_sha256: string
  file_count: number
  reviewed_at: string | null
  reviewer_note: string | null
  skill_ids: string[]
  integrity_ok: boolean
}

/** 人工复核状态更新结果（对应 Rust `skill_bundle_mark_reviewed` 返回）。 */
export interface SkillBundleReviewResult {
  ok: boolean
  bundle_id: string
  bundle_version: string
  trust_level: SkillBundleTrustLevel
  content_hash: string
  manifest_sha256: string
  receipt_path: string
  reviewed_at: string | null
}

/** 单向声明式 `SKILL.md` 导出结果（对应 Rust `skill_bundle_export_declarative_skill_md` 返回）。 */
export interface SkillBundleDeclarativeExportResult {
  ok: boolean
  bundle_id: string
  bundle_version: string
  source_skill_id: string
  exported_skill_name: string
  trust_level: SkillBundleTrustLevel
  content_hash: string
  manifest_sha256: string
  skill_md_sha256: string
  export_dir: string
  skill_md_path: string
  written_files: string[]
  skipped_non_md_files: string[]
  declarative_only: boolean
}

/** 单向声明式 `SKILL.md` 导出门禁输入（兼容 camelCase 与 snake_case 字段）。 */
export interface DeclarativeSkillMdExportGateInput {
  trustLevel?: string | null
  trust_level?: string | null
  integrityOk?: boolean
  integrity_ok?: boolean
  rejected?: readonly string[]
  mismatched?: readonly string[]
}

/** 单向声明式 `SKILL.md` 导出前置门禁结论（fail-closed）。 */
export interface DeclarativeSkillMdExportGate {
  canExport: boolean
  trustLevel: SkillBundleTrustLevel
  reasons: string[]
}

/** 条目安全体检结论。 */
export type BundleEntryVerdict = { ok: true } | { ok: false; reason: string }

function extensionOf(name: string): string | null {
  const file = name.split("/").pop() ?? name
  const dot = file.lastIndexOf(".")
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : null
}

/** 可执行扩展名 → true（C-007 一律拒绝导入）。 */
export function hasExecutableExtension(name: string): boolean {
  const ext = extensionOf(name)
  return ext !== null && (SKILL_BUNDLE_EXECUTABLE_EXTENSIONS as readonly string[]).includes(ext)
}

/** 扩展名在 allowlist 内 → true。 */
export function isAllowedBundleEntry(name: string): boolean {
  const ext = extensionOf(name)
  return ext !== null && (SKILL_BUNDLE_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * 条目名的前置安全体检（与 Rust `validate_entry_name` 同规则）。
 *
 * 拒绝：绝对路径、Windows 盘符、反斜杠分隔符、`..` 穿越、空名。
 */
export function validateBundleEntryName(name: string): BundleEntryVerdict {
  if (name.length === 0) return { ok: false, reason: "empty entry name" }
  if (name.includes("\\")) return { ok: false, reason: "entry must use POSIX separators" }
  if (name.startsWith("/")) return { ok: false, reason: "absolute entry rejected" }
  if (/^[a-zA-Z]:/.test(name)) return { ok: false, reason: "drive-qualified entry rejected" }
  if (name.split("/").includes("..")) return { ok: false, reason: "path traversal rejected" }
  if (hasExecutableExtension(name)) return { ok: false, reason: "executable entry rejected" }
  return { ok: true }
}

/**
 * 结构化清单体检（与 Rust `validate_manifest` 同规则）。
 *
 * 返回全部拒绝理由（空数组 = 通过）；**不触盘**。
 */
export function validateManifestShape(manifest: SkillBundleManifest): string[] {
  const reasons: string[] = []
  if (manifest.schema !== SKILL_BUNDLE_SCHEMA) {
    reasons.push(`unsupported schema ${manifest.schema} (expected ${SKILL_BUNDLE_SCHEMA})`)
  }
  if (manifest.schema_version !== SKILL_BUNDLE_SCHEMA_VERSION) {
    reasons.push(
      `unsupported schema_version ${manifest.schema_version} (supported: ${SKILL_BUNDLE_SCHEMA_VERSION})`,
    )
  }
  for (const field of ["id", "name", "version", "min_nb_version"] as const) {
    if (!manifest[field] || String(manifest[field]).trim().length === 0) {
      reasons.push(`manifest field ${field} must not be empty`)
    }
  }
  if (!/^[0-9a-f]{64}$/i.test(manifest.content_hash ?? "")) {
    reasons.push("content_hash must be a 64-char sha256 hex")
  }
  if (!manifest.allowlist) {
    reasons.push("allowlist is mandatory (readable_state[] / writable_artifacts[])")
  }
  return reasons
}

/**
 * 导入门禁判定：把「能否导入」与「为何不能」分离，供 UI 逐条展示。
 *
 * `trust_level` 恒按 `untrusted` 处理——即使包内自述为可信。
 */
export function summarizeImportGate(verify: SkillBundleVerifyResult): {
  canImport: boolean
  trustLevel: string
  reasons: string[]
} {
  const reasons = [...verify.rejected]
  if (verify.mismatched.length > 0) {
    reasons.push(`hash mismatches: ${verify.mismatched.join(", ")}`)
  }
  return {
    canImport: verify.ok && reasons.length === 0,
    trustLevel: SKILL_BUNDLE_TRUST_UNTRUSTED,
    reasons,
  }
}

/** 导出技能包（`source_root/<skill_id>/` 布局）。 */
export async function exportSkillBundle(
  skillIds: string[],
  sourceRoot: string,
  destPath: string,
): Promise<SkillBundleExportResult> {
  return invoke<SkillBundleExportResult>("skill_bundle_export", {
    skillIds,
    sourceRoot,
    destPath,
  })
}

/** 校验技能包（不落任何持久产物）。 */
export async function verifySkillBundle(bundlePath: string): Promise<SkillBundleVerifyResult> {
  return invoke<SkillBundleVerifyResult>("skill_bundle_verify", { bundlePath })
}

/**
 * 导入技能包。
 *
 * `confirmed` 必须来自用户在导入对话框的**逐项确认**：Rust 侧把它当作「导入确认门」的
 * 机械判据，用户资产域（`RequireGate`）在 `confirmed=false` 时直接失败。
 */
export async function importSkillBundle(
  bundlePath: string,
  destRoot: string,
  confirmed: boolean,
): Promise<SkillBundleImportResult> {
  return invoke<SkillBundleImportResult>("skill_bundle_import", {
    bundlePath,
    destRoot,
    confirmed,
  })
}

/**
 * 单向声明式 `SKILL.md` 导出前置门禁判定（fail-closed，零触盘）。
 * 仅当 `trustLevel === "reviewed"`、完整性未失败且无 `rejected`/`mismatched` 项时放行。
 */
export function canExportDeclarativeSkillMd(
  input: DeclarativeSkillMdExportGateInput | null | undefined,
): DeclarativeSkillMdExportGate {
  const reasons: string[] = []
  if (!input) {
    return {
      canExport: false,
      trustLevel: SKILL_BUNDLE_TRUST_UNTRUSTED,
      reasons: ["bundle metadata missing"],
    }
  }
  const rawTrust = (input.trustLevel ?? input.trust_level ?? "").trim()
  const trustLevel: SkillBundleTrustLevel = rawTrust || SKILL_BUNDLE_TRUST_UNTRUSTED
  if (trustLevel !== SKILL_BUNDLE_TRUST_REVIEWED) {
    reasons.push(
      `bundle trust_level is ${trustLevel} (requires human-confirmed ${SKILL_BUNDLE_TRUST_REVIEWED})`,
    )
  }
  const integrityOk = input.integrityOk ?? input.integrity_ok
  if (integrityOk === false) {
    reasons.push("bundle integrity check failed")
  }
  if (Array.isArray(input.rejected) && input.rejected.length > 0) {
    reasons.push(...input.rejected)
  }
  if (Array.isArray(input.mismatched) && input.mismatched.length > 0) {
    reasons.push(`hash mismatches: ${input.mismatched.join(", ")}`)
  }
  return {
    canExport: reasons.length === 0,
    trustLevel,
    reasons,
  }
}

/** 列出 `<destRoot>/skill_bundle/<id>/<version>` 下已安装的技能包及其核验后信任状态。 */
export async function listInstalledSkillBundles(
  destRoot: string,
): Promise<SkillBundleInstalledEntry[]> {
  return invoke<SkillBundleInstalledEntry[]>("skill_bundle_list_installed", {
    destRoot,
  })
}

/**
 * 标记或撤销已安装技能包的人工复核收据（`<installedDir>/.nb-review-receipt.json`）。
 * fail-closed：未显式人工确认（`confirmed !== true`）时在客户端即拒绝，绝不触发 IPC。
 */
export async function setSkillBundleReviewStatus(
  installedDir: string,
  reviewed: boolean,
  confirmed: boolean,
  reviewerNote?: string,
): Promise<SkillBundleReviewResult> {
  if (!confirmed) {
    throw new Error(
      "[skill_bundle] human confirmation (confirmed=true) is required to update review status",
    )
  }
  return invoke<SkillBundleReviewResult>("skill_bundle_mark_reviewed", {
    installedDir,
    reviewed,
    confirmed,
    reviewerNote,
  })
}

/**
 * 将已人工复核通过的 `nbskill/1` 包单向导出为声明式 `SKILL.md`（+ `references/*.md`）。
 * 严守 C-007 零脚本与 fail-closed 信任门：若调用方传入 `options.trustLevel` 且非 `reviewed`，
 * 客户端先拒绝不调用 IPC；最终权威校验由 Rust 侧重算哈希并验证独立收据执行。
 */
export async function exportDeclarativeSkillMd(
  installedDir: string,
  destRoot: string,
  options?: { skillId?: string; overwrite?: boolean; trustLevel?: string },
): Promise<SkillBundleDeclarativeExportResult> {
  if (options?.trustLevel !== undefined && options.trustLevel !== SKILL_BUNDLE_TRUST_REVIEWED) {
    throw new Error(
      `[skill_bundle] declarative SKILL.md export requires trust_level=${SKILL_BUNDLE_TRUST_REVIEWED} (got ${options.trustLevel || SKILL_BUNDLE_TRUST_UNTRUSTED})`,
    )
  }
  return invoke<SkillBundleDeclarativeExportResult>("skill_bundle_export_declarative_skill_md", {
    installedDir,
    destRoot,
    skillId: options?.skillId,
    overwrite: options?.overwrite,
  })
}
