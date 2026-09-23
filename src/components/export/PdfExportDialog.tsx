import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CJK_FONT_FILE,
  LINE_HEIGHT_RATIO,
  exportPdf,
  isPathInsideDataSectionError,
  validateExportTarget,
  type PdfExportReport,
} from "@/lib/export/pdf-client";
import {
  exportConfirmedChapterPdf,
  exportHistoryPath,
  loadPdfExportHistory,
  type PdfExportHistoryEntry,
} from "@/lib/export/pdf-export-gate";
import { readFile } from "@/commands/fs";

export interface PdfExportDialogProps {
  /** 当前项目根路径。 */
  projectPath: string;
  /** 文档标题（仅写入 PDF 首屏）。 */
  title: string;
  /** 待导出的正文切片（只读投影：调用方从正文读，导出不写回）。 */
  paragraphs: string[];
  /**
   * 确认门溯源输入（可选，向后兼容）：传入后对话框走确认导出通道——
   * 导出前断言该章节磁盘内容 `chapter_status=final`（门禁 1），
   * 成功后追加 `.novel/export-history.json` 溯源记录（门禁 7/9）。
   * 未传入时保持旧行为（直调裸 `exportPdf`），旧调用方不受影响。
   */
  chapterPath?: string;
}

/**
 * PDF 导出对话框（F-008 + #43 确认门）。
 *
 * 只读投影：正文来自 props，导出目标必须在数据区之外（本地先挡，后端再挡一次）。
 * 面板展示内嵌中文字体与固定 1.5 行距，让用户知道产物自带字体、不依赖本机。
 * 确认门（可选 `chapterPath`）：导出前断言章节磁盘内容为 final（门禁 1），
 * 成功后追加导出历史（门禁 7/9）；失败/取消不留完成记录（门禁 5）。
 */
export function PdfExportDialog({ projectPath, title, paragraphs, chapterPath }: PdfExportDialogProps) {
  const { t } = useTranslation();
  const [target, setTarget] = useState("exports/book.pdf");
  const [report, setReport] = useState<PdfExportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<PdfExportHistoryEntry | null>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);

  const targetIssue = useMemo(() => validateExportTarget(target), [target]);

  const run = async () => {
    setError(null);
    setConfirmed(null);
    setBusy(true);
    try {
      if (chapterPath) {
        // 确认导出通道：final 断言 → 后端 → 成功落历史。
        const { report: gated, entry } = await exportConfirmedChapterPdf({
          projectPath,
          chapterPath,
          chapterTitle: title,
          target,
          paragraphs,
          readChapterContent: () => readFile(`${projectPath}/${chapterPath}`),
        });
        setReport(gated);
        setConfirmed(entry);
        setHistoryCount((await loadPdfExportHistory(projectPath)).length);
      } else {
        setReport(await exportPdf(projectPath, target, title, paragraphs));
      }
    } catch (cause) {
      setReport(null);
      setConfirmed(null);
      const text = cause instanceof Error ? cause.message : String(cause);
      setError(
        isPathInsideDataSectionError(cause)
          ? t("pdfexport.path.outsideData")
          : text.includes("PDF_EXPORT_NOT_CONFIRMED")
            ? t("pdfexport.notConfirmed")
            : text.includes("PDF_EXPORT_CONTENT_CHANGED")
              ? t("pdfexport.contentChanged")
              : text,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="pdf-export-dialog" className="flex flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">{t("pdfexport.dialog.title")}</h2>

      <p data-testid="pdfexport-font-notice" className="text-xs">
        {t("pdfexport.font.cjk")} · {CJK_FONT_FILE} · {LINE_HEIGHT_RATIO}×
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span>{t("pdfexport.target.label")}</span>
        <input
          className="rounded border px-2 py-1 text-sm"
          data-testid="pdfexport-target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
      </label>

      {targetIssue !== null ? (
        <p role="alert" data-testid="pdfexport-target-warning" className="text-xs text-amber-600">
          {t(targetIssue)}
        </p>
      ) : null}

      {/* 禁用态必须自述原因：正文为空时按钮从外观上和其它禁用原因一模一样。 */}
      {paragraphs.length === 0 ? (
        <p role="status" data-testid="pdfexport-empty-hint" className="text-xs text-amber-600">
          {t("pdfexport.empty.body")}
        </p>
      ) : null}

      <button
        type="button"
        data-testid="pdfexport-submit"
        disabled={targetIssue !== null || paragraphs.length === 0 || busy}
        onClick={() => void run()}
      >
        {busy ? t("pdfexport.submit.busy") : t("pdfexport.submit")}
      </button>

      <p data-testid="pdfexport-paragraphs" className="text-xs">
        {t("pdfexport.paragraphs.label")}: {paragraphs.length}
      </p>

      {report ? (
        <p data-testid="pdfexport-report" className="text-xs">
          {t("pdfexport.report", {
            pages: report.pages,
            bytes: report.bytes_written,
            font: report.font,
          })}
        </p>
      ) : null}
      {confirmed ? (
        <p data-testid="pdfexport-confirm" className="text-xs">
          {t("pdfexport.confirmed", {
            digest: confirmed.confirmedDigest,
            chapter: confirmed.chapterPath,
          })}
        </p>
      ) : null}
      {historyCount !== null ? (
        <p data-testid="pdfexport-history" className="text-xs">
          {t("pdfexport.history.count", { count: historyCount, file: exportHistoryPath(projectPath) })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-testid="pdfexport-error" className="text-xs text-red-500">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export default PdfExportDialog;
