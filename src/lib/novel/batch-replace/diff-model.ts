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

/**
 * RCP-20261014-count/CRlf 落地：断言式单点替换原语（纯函数）。
 *
 * 背景：弯引号/全角标点文本用 edit 硬怼 exact-match 极脆弱；R24 改走
 * "count==1 断言再 replace"，任一对不断言全停。CRLF 大文件另需行尾零漂移。
 */

/** 断言式替换结论码。 */
export type AssertReplaceCode = "ok" | "not_found" | "ambiguous";

/** 单对 old/new 断言式替换结果。 */
export interface AssertReplaceResult {
  code: AssertReplaceCode;
  text: string;
  /** old 在原文中的命中次数（ok 时恒为 1）。 */
  matches: number;
}

/** old 恰命中 1 次才替换；0 次→not_found、多于 1 次→ambiguous，原文原样返回。 */
export function assertSingleMatchReplace(text: string, oldText: string, newText: string): AssertReplaceResult {
  if (oldText.length === 0) return { code: "not_found", text, matches: 0 };
  let matches = 0;
  let idx = text.indexOf(oldText);
  while (idx >= 0) {
    matches += 1;
    if (matches > 1) break;
    idx = text.indexOf(oldText, idx + oldText.length);
  }
  if (matches === 0) return { code: "not_found", text, matches: 0 };
  if (matches > 1) return { code: "ambiguous", text, matches };
  return { code: "ok", text: text.replace(oldText, newText), matches: 1 };
}

/** 批量断言式替换：任一对非 ok 即整体失败、返回已定位的首个失败对序号。 */
export interface AssertBatchResult {
  ok: boolean;
  text: string;
  failedIndex: number;
  code: AssertReplaceCode | "ok";
}

export function assertBatchReplace(
  text: string,
  pairs: ReadonlyArray<{ oldText: string; newText: string }>,
): AssertBatchResult {
  let cur = text;
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    if (!pair) continue;
    const r = assertSingleMatchReplace(cur, pair.oldText, pair.newText);
    if (r.code !== "ok") return { ok: false, text, failedIndex: i, code: r.code };
    cur = r.text;
  }
  return { ok: true, text: cur, failedIndex: -1, code: "ok" };
}

/**
 * CRLF 安全区段拼接：新区段统一 \n→\r\n、尾部保证空行，旧首尾 bytes 原样保留。
 * 对应 v13：旧区段 12676B→新区段 13078B（+402），全书 1590137B→1590539B 精确可审计。
 */
export function joinCrlfSections(head: string, newSection: string, tail: string): string {
  let sec = newSection.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  if (!sec.endsWith("\r\n\r\n")) sec += "\r\n";
  return head + sec + tail;
}
