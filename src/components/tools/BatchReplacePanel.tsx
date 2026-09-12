import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  applyBatchReplace,
  isGateDenied,
  isGateRequireConfirm,
  isTransactionRolledBack,
  preflightCanonEdgeGate,
  previewBatchReplace,
  type ReplaceRule,
} from "@/lib/novel";
import {
  assessSafety,
  changedFilesOnly,
  formatSummary,
  summarize,
  type FileDiffModel,
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
 * 批量替换面板（F-007）。
 *
 * 流程固定为「预览 → 写前门预检 → 提交」：预览只读；提交前若既有 canon 事实与本次替换
 * 冲突（写前门 BLOCK）则不给提交；未确认的不可重建目标会走既有确认对话框（`GATE_REQUIRE_CONFIRM`）；
 * 事务失败并已回滚时展示回滚提示。本面板自己不做任何文件写入。
 */
export function BatchReplacePanel({ projectPath, targets }: BatchReplacePanelProps) {
  const { t } = useTranslation();
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [files, setFiles] = useState<FileDiffModel[]>([]);
  const [status, setStatus] = useState<StatusState>({ phase: "idle", text: "" });

  const rule: ReplaceRule = useMemo(
    () => ({ find, replace, caseSensitive: false }),
    [find, replace],
  );
  const changed = useMemo(() => changedFilesOnly(files), [files]);
  const summary = useMemo(() => summarize(files), [files]);
  const safety = useMemo(() => assessSafety(files, find), [files, find]);
  const canonGate = useMemo(
    () => (files.length > 0 ? preflightCanonEdgeGate(files, rule, []) : null),
    [files, rule],
  );

  const runPreview = async () => {
    try {
      const diffs = await previewBatchReplace({ projectPath, files: targets, rule });
      setFiles(diffs);
      setStatus({ phase: "previewed", text: formatSummary(summarize(diffs)) });
    } catch (error) {
      setStatus({ phase: "error", text: String(error) });
    }
  };

  const runApply = async () => {
    try {
      const report = await applyBatchReplace({ projectPath, files: targets, rule });
      setStatus({
        phase: "applied",
        text: `${report.total_replacements} replacements · ${report.drafts.length} drafts`,
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

      <p data-testid="batchreplace-summary" className="text-xs">
        {formatSummary(summary)}
      </p>

      {!safety.ok ? (
        <ul data-testid="batchreplace-safety" className="text-xs text-amber-600">
          {safety.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}

      {canonGate && canonGate.state !== "PASS" ? (
        <ul data-testid="batchreplace-canon-gate" className="text-xs text-amber-600">
          {canonGate.conflicts.map((conflict) => (
            <li key={`${conflict.newEdgeId}-${conflict.reason}`}>{conflict.reason}</li>
          ))}
        </ul>
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
