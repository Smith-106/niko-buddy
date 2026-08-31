/**
 * EPIC-001 / TASK-005 / ADR-29: exemplar command TS wrapper（UI → Rust 中转）。
 *
 * 镜像 `@/commands/fs.ts` 模式 — UI 经此 wrapper invoke Rust command，
 * chat-panel 不直接 invoke（项目既定路径：UI → commands/*.ts → Rust）。
 *
 * Rust command（`exemplar_commands.rs`）直接读写 `.novel/style-exemplars.json`，
 * 与 TS loader（`style-exemplars-loader.ts`，供 contextPack 注入用）两端读写
 * 同一文件 — HARD-1 真源是文件本身，非两份状态。
 */
import { invoke } from "@tauri-apps/api/core"

/** exemplar 标记类型枚举（与 Rust VALID_MARK_TYPES + TS loader 一致，PAT-G2 镜像）。 */
export type StyleExemplarMarkType = "style" | "voice" | "pacing"

/** exemplar 标记输入负载（UI → Rust）。 */
export interface MarkStyleExemplarInput {
  chapterId: string
  text: string
  markType: StyleExemplarMarkType
  note?: string
}

/** style exemplar 单条记录（Rust 返回，camelCase 与 TS loader StyleExemplar 同构）。 */
export interface StyleExemplarRecord {
  exemplarId: string
  chapterId: string
  text: string
  markType: StyleExemplarMarkType
  note?: string
  createdAt: string
}

/**
 * 标记一段文本为 style exemplar 并持久化（Draft-first 例外 C-001，直写正式层）。
 *
 * UI 调用此 wrapper → invoke Rust `mark_style_exemplar` command → Rust 侧
 * read-modify-write `.novel/style-exemplars.json`。
 */
export async function markStyleExemplarViaRust(
  projectPath: string,
  mark: MarkStyleExemplarInput,
): Promise<void> {
  return invoke<void>("mark_style_exemplar", { projectPath, mark })
}

/**
 * 加载项目级 style exemplars（UI 计数显示用）。
 *
 * Rust 侧读 `.novel/style-exemplars.json`；缺失返回 []（优雅降级）。
 */
export async function loadStyleExemplarsViaRust(
  projectPath: string,
): Promise<StyleExemplarRecord[]> {
  return invoke<StyleExemplarRecord[]>("load_style_exemplars", { projectPath })
}

/** 删除单条 style exemplar 的输入负载（UI → Rust）。 */
export interface DeleteStyleExemplarInput {
  exemplarId: string
}

/**
 * 删除一条已标记的 style exemplar（③-6 审计修复：标记后可取消）。
 *
 * UI 调用此 wrapper → invoke Rust `delete_style_exemplar` command → Rust 侧
 * read-modify-write `.novel/style-exemplars.json`，移除匹配 exemplarId 的记录。
 * Rust 命令需同步新增（注册到 `generate_handler!`）。
 */
export async function deleteStyleExemplarViaRust(
  projectPath: string,
  exemplarId: string,
): Promise<void> {
  return invoke<void>("delete_style_exemplar", { projectPath, exemplarId })
}
