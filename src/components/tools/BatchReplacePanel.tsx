import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  applyBatchReplace,
  buildCanonEdgeFilter,
  isGateDenied,
  isGateRequireConfirm,
  isTransactionRolledBack,
  preflightCanonEdgeGate,
  previewBatchReplace,
  queryCanonEdges,
  type PreWriteGateCode,
  type ReplaceRule,
} from "@/lib/novel";
import {
  assessSafety,
  changedFilesOnly,
  summarize,
  type DiffSummary,
  type FileDiffModel,
  type SafetyIssue,
  type SafetyIssueCode,
} from "@/lib/novel";

export interface BatchReplacePanelProps {
  /** 当前项目根路径。 */
  projectPath: string;
  /** 预选目标（项目相对路径）。 */
  targets: string[];
}

type Phase = "idle" | "previewed" | "applied" | "confirm" | "denied" | "rolledback" | "error";

interface StatusState {
  phase: Phase;
  text: string;
}

/**
 * 安全结论码 → i18n 键。
 *
 * 文案只在面板层（本仓 UI 一律中文，英文诊断串会直接暴露给用户）；
 * `diff-model.ts` 只产出结论码，两边各守自己那一层。
 */
const REASON_LABEL_KEY: Record<SafetyIssueCode, string> = {
  empty_find_text: "batchreplace.reason.empty_find_text",
  no_target_files: "batchreplace.reason.no_target_files",
  too_many_files: "batchreplace.reason.too_many_files",
  unsafe_path: "batchreplace.reason.unsafe_path",
  nothing_to_replace: "batchreplace.reason.nothing_to_replace",
};

/** 写前门结论码 → i18n 键（lib 只产出码 + 诊断串，文案在本层）。 */
const CANON_GATE_LABEL_KEY: Record<PreWriteGateCode, string> = {
  block_endpoint_conflict: "batchreplace.canonGate.block",
  warn_temporal_advance: "batchreplace.canonGate.warn",
  duplicate_digest_overlap: "batchreplace.canonGate.duplicate",
};

/** 既有 canon 事实快照（仅写前门需要的字段）。 */
interface CanonEdgeSnapshot {
  id: string;
  sourceId: string;
  targetId: string;
  predicate: string;
  validAt?: number | null;
  invalidAt?: number | null;
}

/**
 * 批量替换面板（F-007）。
 *
 * 流程固定为「预览 → 写前门预检 → 提交」：预览只读；提交前拿**真实的既有 canon
 * 事实**跑写前门（旧实现恒传空数组，门永远不会命中，UI 却在宣称已检查）。
 *
 * 诚实的边界（实机核实）：
 *  - 写前门默认 `warn` 观察模式，BLOCK 级冲突会**降级为提示**；只有切到 `block`
 *    模式才会真的禁用提交（`disabled` 分支保留以适配该模式）；
 *  - 既有事实读不出来时门未评估，UI 显示“未评估（不等于通过）”，绝不显示为通过。
 *
 * 本面板自己不做任何文件写入。
 */
export function BatchReplacePanel({ projectPath, targets }: BatchReplacePanelProps) {
  const { t } = useTranslation();
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [files, setFiles] = useState<FileDiffModel[]>([]);
  const [status, setStatus] = useState<StatusState>({ phase: "idle", text: "" });
  /**
   * 是否已跑过一次预览。
   *
   * 未跑之前 `files` 与 `find` 必然为空，此时展示 safety 结论（"empty find text" /
   * "no target files" / "nothing to replace"）等于把「你还没填表」报成三个错误；
   * 所以空态先给操作引导，结论只在用户真的点过预览后出现。
   */
  const [previewed, setPreviewed] = useState(false);
  /**
   * 既有 canon 事实快照。
   * `null` = 未评估（未加载 / 加载失败）——此时门不得报 PASS。
   */
  const [existingEdges, setExistingEdges] = useState<CanonEdgeSnapshot[] | null>(null);
  const [canonGateState, setCanonGateState] = useState<"idle" | "checking" | "ready" | "failed">(
    "idle",
  );

  const rule: ReplaceRule = useMemo(
    () => ({ find, replace, caseSensitive: false }),
    [find, replace],
  );
  const changed = useMemo(() => changedFilesOnly(files), [files]);
  const summary = useMemo(() => summarize(files), [files]);
  const safety = useMemo(() => assessSafety(files, find), [files, find]);
  const canonGate = useMemo(
    () =>
      files.length > 0 && existingEdges !== null
        ? preflightCanonEdgeGate(files, rule, existingEdges)
        : null,
    [files, rule, existingEdges],
  );

  const loadExistingEdges = useCallback(async () => {
    if (find.trim().length === 0) {
      setExistingEdges([]);
      setCanonGateState("ready");
      return;
    }
    setCanonGateState("checking");
    try {
      const facts = await queryCanonEdges(
        projectPath,
        buildCanonEdgeFilter({ predicates: ["replaced_by"], entityIds: [find] }),
      );
      setExistingEdges(
        facts.map((fact) => ({
          id: fact.id,
          sourceId: fact.sourceId,
          targetId: fact.targetId,
          predicate: fact.predicate,
          validAt: fact.validAt ?? null,
          invalidAt: fact.invalidAt ?? null,
        })),
      );
      setCanonGateState("ready");
    } catch {
      setExistingEdges(null);
      setCanonGateState("failed");
    }
  }, [find, projectPath]);

  const formatSummaryText = useCallback(
    (value: DiffSummary) =>
      value.totalReplacements === 0
        ? t("batchreplace.summary.none")
        : t("batchreplace.summary.count", {
            replacements: value.totalReplacements,
            files: value.changedFiles,
            lines: value.touchedLines,
          }),
    [t],
  );

  const formatReason = useCallback(
    (issue: SafetyIssue) =>
      issue.detail
        ? t(REASON_LABEL_KEY[issue.code], { detail: issue.detail })
        : t(REASON_LABEL_KEY[issue.code]),
    [t],
  );

  const runPreview = async () => {
    setPreviewed(true);
    await loadExistingEdges();
    try {
      const diffs = await previewBatchReplace({ projectPath, files: targets, rule });
      setFiles(diffs);
      setStatus({ phase: "previewed", text: formatSummaryText(summarize(diffs)) });
    } catch (error) {
      setStatus({ phase: "error", text: String(error) });
    }
  };

  const runApply = async () => {
    try {
      const report = await applyBatchReplace({ projectPath, files: targets, rule });
      setStatus({
        phase: "applied",
        text: t("batchreplace.status.applied", {
          replacements: report.total_replacements,
          drafts: report.drafts.length,
        }),
      });
    } catch (error) {
      if (isGateRequireConfirm(error)) {
        setStatus({ phase: "confirm", text: t("batchreplace.apply.confirm") });
        return;
      }
      if (isTransactionRolledBack(error)) {
        setStatus({ phase: "rolledback", text: t("batchreplace.transaction.rollback") });
        return;
      }
      setStatus({ phase: isGateDenied(error) ? "denied" : "error", text: String(error) });
    }
  };

  return (
    <section data-testid="batch-replace-panel" className="flex h-full flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">{t("batchreplace.preview.title")}</h2>

      <div className="flex gap-2">
        <input
          className="rounded border px-2 py-1 text-sm"
          data-testid="batchreplace-find"
          placeholder={t("batchreplace.find.label")}
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        <input
          className="rounded border px-2 py-1 text-sm"
          data-testid="batchreplace-replace"
          placeholder={t("batchreplace.replace.label")}
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
        />
        <button type="button" data-testid="batchreplace-preview" onClick={() => void runPreview()}>
          {t("batchreplace.preview.action")}
        </button>
        <button
          type="button"
          data-testid="batchreplace-apply"
          disabled={!safety.ok || canonGate?.state === "BLOCK"}
          onClick={() => void runApply()}
        >
          {t("batchreplace.apply.confirm")}
        </button>
      </div>

      {previewed ? (
        <p data-testid="batchreplace-summary" className="text-xs">
          {formatSummaryText(summary)}
        </p>
      ) : (
        <p data-testid="batchreplace-empty-hint" className="text-xs text-muted-foreground">
          {t("batchreplace.empty.hint")}
        </p>
      )}

      {previewed && !safety.ok ? (
        <ul data-testid="batchreplace-safety" className="text-xs text-amber-600">
          {safety.issues.map((issue) => (
            <li key={`${issue.code}:${issue.detail ?? ""}`}>{formatReason(issue)}</li>
          ))}
        </ul>
      ) : null}

      {previewed && files.length > 0 ? (
        <p
          data-testid="batchreplace-canon-gate-state"
          data-state={canonGateState === "failed" ? "unevaluated" : (canonGate?.state ?? "checking")}
          className="text-xs opacity-70"
        >
          {canonGateState === "failed"
            ? t("batchreplace.canonGate.unavailable")
            : canonGateState === "checking"
              ? t("batchreplace.canonGate.checking")
              : `${t("batchreplace.canonGate.label")}：${canonGate?.state ?? "PASS"}`}
        </p>
      ) : null}

      {canonGate && canonGate.state !== "PASS" ? (
        <ul data-testid="batchreplace-canon-gate" className="text-xs text-amber-600">
          {canonGate.conflicts.map((conflict) => (
            <li key={`${conflict.newEdgeId}-${conflict.code}`} title={conflict.reason}>
              {t(CANON_GATE_LABEL_KEY[conflict.code])}
            </li>
          ))}
        </ul>
      ) : null}

      {canonGate && canonGate.state !== "PASS" ? (
        <p data-testid="batchreplace-canon-gate-advisory" className="text-xs opacity-70">
          {t("batchreplace.canonGate.advisory")}
        </p>
      ) : null}

      <ul data-testid="batchreplace-files" className="flex-1 space-y-0.5 overflow-auto text-xs">
        {changed.map((file) => (
          <li key={file.path} className="font-mono">
            {file.path} · {file.replacements}
          </li>
        ))}
      </ul>

      <p data-testid="batchreplace-status" data-phase={status.phase} className="text-xs">
        {status.text}
      </p>
      {status.phase === "rolledback" ? (
        <p data-testid="batchreplace-rollback-notice" className="text-xs text-red-500">
          {t("batchreplace.transaction.rollback")}
        </p>
      ) : null}
    </section>
  );
}

export default BatchReplacePanel;
