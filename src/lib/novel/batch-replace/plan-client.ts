/**
 * 批量替换的计划客户端（F-007）。
 *
 * 职责分工：
 * * 预览/提交走 IPC（Rust 侧 `batch_replace_preview` / `batch_replace_apply`，事务与门都在那边）；
 * * 本层在提交前**额外**跑一次既有写前门 `canon-pre-write-gate`：把「旧词 → 新词」当作一条
 *   待写入的 canon 边，若该边与既有事实冲突（state = BLOCK）则整个计划不可提交。
 *   这一步不替代 Rust 的门，只是把冲突暴露在 UI 上、避免用户走完确认流程才发现要回滚。
 */

import { invoke } from "@tauri-apps/api/core";

import {
  DEFAULT_PRE_WRITE_GATE_MODE,
  checkCanonPreWrite,
  type PreWriteGateConfig,
  type PreWriteGateInput,
  type PreWriteGateResult,
} from "../canon-pre-write-gate";
import type { FileDiffModel } from "./diff-model";

/** 确认门里的操作名（与 Rust 侧 `BATCH_REPLACE_OP` 一致）。 */
export const BATCH_REPLACE_OP = "batchReplace";
/** 后端确认门前缀（前端据此弹确认框而不是报错）。 */
export const GATE_CONFIRM_PREFIX = "GATE_REQUIRE_CONFIRM:";
export const GATE_DENIED_PREFIX = "GATE_DENIED:";

export interface ReplaceRule {
  find: string;
  replace: string;
  caseSensitive?: boolean;
}

export interface BatchReplaceRequest {
  projectPath: string;
  files: string[];
  rule: ReplaceRule;
}

export interface ApplyReport {
  applied: string[];
  drafts: string[];
  backup_root: string;
  total_replacements: number;
  projection_status_updated: boolean;
  rollback_performed: boolean;
}

function toWireRule(rule: ReplaceRule) {
  return {
    find: rule.find,
    replace: rule.replace,
    case_sensitive: rule.caseSensitive ?? false,
  };
}

/** 只读预览（Rust 侧零副作用）。 */
export async function previewBatchReplace(req: BatchReplaceRequest): Promise<FileDiffModel[]> {
  const raw = await invoke<FileDiffModel[]>("batch_replace_preview", {
    projectPath: req.projectPath,
    files: req.files,
    rule: toWireRule(req.rule),
  });
  return raw;
}

/**
 * 事务提交。未确认的不可重建目标会返回 `BATCH_REPLACE_GATE_REJECTED: GATE_REQUIRE_CONFIRM:<id>`，
 * 前端应走既有确认对话框后重试同一调用。
 */
export async function applyBatchReplace(req: BatchReplaceRequest): Promise<ApplyReport> {
  return invoke<ApplyReport>("batch_replace_apply", {
    projectPath: req.projectPath,
    files: req.files,
    rule: toWireRule(req.rule),
  });
}

export function isGateRequireConfirm(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(GATE_CONFIRM_PREFIX);
}

export function isGateDenied(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(GATE_DENIED_PREFIX);
}

export function isTransactionRolledBack(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("BATCH_REPLACE_ROLLED_BACK");
}

/**
 * 把一次批量替换折算成待写入的 canon 边：一个旧词到新词的「替换」关系。
 * 每个命中文件产出一条边；空规则不产出边。
 */
export function buildEdgesFromPlan(
  files: FileDiffModel[],
  rule: ReplaceRule,
): PreWriteGateInput["newEdges"] {
  if (rule.find.length === 0) return [];
  return files
    .filter((file) => file.replacements > 0)
    .map((file) => ({
      id: `batch:${file.path}:${rule.find}->${rule.replace}`,
      sourceId: rule.find,
      targetId: rule.replace,
      predicate: "replaced_by",
      digest: `${file.path}#${file.replacements}`,
      validAt: null,
      invalidAt: null,
    }));
}

/** 提交前跑既有写前门。 */
export function preflightCanonEdgeGate(
  files: FileDiffModel[],
  rule: ReplaceRule,
  existingEdges: PreWriteGateInput["existingEdges"],
  config?: Partial<PreWriteGateConfig>,
): PreWriteGateResult {
  const resolved: PreWriteGateConfig = {
    mode: config?.mode ?? DEFAULT_PRE_WRITE_GATE_MODE,
    ...(config ?? {}),
  };
  return checkCanonPreWrite({ newEdges: buildEdgesFromPlan(files, rule), existingEdges }, resolved);
}

/** 写前门是否禁止提交（BLOCK 才算禁；WARN/DUPLICATE 只提示）。 */
export function isPlanBlockedByCanonGate(result: PreWriteGateResult): boolean {
  return result.state === "BLOCK";
}
