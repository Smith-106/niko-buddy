/**
 * 批量替换的确定性 diff 模型（F-007）。
 *
 * 纯函数、零副作用：把「原文 → 命中行 → 预览摘要」算清楚，供面板渲染与安全判据使用。
 * 这里不做任何替换决策——真正的门与事务在 `plan-client.ts` 与 Rust 侧。
 */

export interface LineDiffEntry {
  /** 1-based 行号。 */
  line: number;
  before: string;
  after: string;
}

export interface FileDiffModel {
  /** 项目相对路径（正斜杠）。 */
  path: string;
  replacements: number;
  changes: LineDiffEntry[];
}

export interface DiffSummary {
  changedFiles: number;
  totalReplacements: number;
  /** 命中行总数（用于面板折叠展示）。 */
  touchedLines: number;
  /** 最长单行变化（字符数），用于决定是否提示「整行改写」。 */
  maxLineDelta: number;
}

export interface SafetyVerdict {
  ok: boolean;
  issues: SafetyIssue[];
}

/**
 * 安全判据结论码。**文案在 UI 层**：本层只产出 code（+ 必要 detail），
 * 面板按 code 取 i18n 文案——否则中文界面会混进英文诊断串（实机回归：
 * 空态曾直接渲染 `empty find text` / `no target files` / `nothing to replace`）。
 */
export type SafetyIssueCode =
  | "empty_find_text"
  | "no_target_files"
  | "too_many_files"
  | "unsafe_path"
  | "nothing_to_replace";

export interface SafetyIssue {
  code: SafetyIssueCode;
  /** 补充信息（文件数 / 路径），面板按 code 决定是否展示。 */
  detail?: string;
}

/** 单批上限，与 Rust 侧 `MAX_FILES_PER_BATCH` 保持一致。 */
export const MAX_FILES_PER_BATCH = 200;

/** 逐行对齐的确定性 diff（行数相同，行内 before/after 逐字对比）。 */
export function diffLines(before: string, after: string): LineDiffEntry[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const limit = Math.max(beforeLines.length, afterLines.length);
  const out: LineDiffEntry[] = [];
  for (let i = 0; i < limit; i += 1) {
    const left = beforeLines[i] ?? "";
    const right = afterLines[i] ?? "";
    if (left !== right) out.push({ line: i + 1, before: left, after: right });
  }
  return out;
}

export function summarize(files: FileDiffModel[]): DiffSummary {
  let totalReplacements = 0;
  let touchedLines = 0;
  let maxLineDelta = 0;
  let changedFiles = 0;
  for (const file of files) {
    if (file.replacements === 0) continue;
    changedFiles += 1;
    totalReplacements += file.replacements;
    touchedLines += file.changes.length;
    for (const change of file.changes) {
      maxLineDelta = Math.max(maxLineDelta, Math.abs(change.after.length - change.before.length));
    }
  }
  return { changedFiles, totalReplacements, touchedLines, maxLineDelta };
}

/** 提交前的机械安全判据（不涉及门与审计，只挡明显误操作）。 */
export function assessSafety(files: FileDiffModel[], findText: string): SafetyVerdict {
  const issues: SafetyIssue[] = [];
  if (findText.length === 0) issues.push({ code: "empty_find_text" });
  if (files.length === 0) issues.push({ code: "no_target_files" });
  if (files.length > MAX_FILES_PER_BATCH) {
    issues.push({ code: "too_many_files", detail: `${files.length} > ${MAX_FILES_PER_BATCH}` });
  }
  for (const file of files) {
    if (file.path.startsWith("/") || file.path.includes("..")) {
      issues.push({ code: "unsafe_path", detail: file.path });
    }
  }
  const summary = summarize(files);
  if (summary.totalReplacements === 0) issues.push({ code: "nothing_to_replace" });
  return { ok: issues.length === 0, issues };
}

/** 只保留有命中的文件（预览列表用）。 */
export function changedFilesOnly(files: FileDiffModel[]): FileDiffModel[] {
  return files.filter((file) => file.replacements > 0);
}
