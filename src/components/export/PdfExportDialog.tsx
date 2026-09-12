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

export interface PdfExportDialogProps {
  /** 当前项目根路径。 */
  projectPath: string;
  /** 文档标题（仅写入 PDF 元数据/首屏）。 */
  title: string;
  /** 待导出的正文切片（只读投影：调用方从正文读，导出不写回）。 */
  paragraphs: string[];
}

/**
 * PDF 导出对话框（F-008）。
 *
 * 只读投影：正文来自 props，导出目标必须在数据区之外（本地先挡，后端再挡一次）。
 * 面板展示内嵌中文字体与固定 1.5 行距，让用户知道产物自带字体、不依赖本机。
 */
export function PdfExportDialog({ projectPath, title, paragraphs }: PdfExportDialogProps) {
  const { t } = useTranslation();
  const [target, setTarget] = useState("exports/book.pdf");
  const [report, setReport] = useState<PdfExportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targetIssue = useMemo(() => validateExportTarget(target), [target]);

  const run = async () => {
    setError(null);
    try {
      setReport(await exportPdf(projectPath, target, title, paragraphs));
    } catch (cause) {
      setReport(null);
      setError(isPathInsideDataSectionError(cause) ? t("pdfexport.path.outsideData") : String(cause));
    }
  };

  return (
    <section data-testid="pdf-export-dialog" className="flex flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">{t("pdfexport.dialog.title")}</h2>

      <p data-testid="pdfexport-font-notice" className="text-xs">
        {t("pdfexport.font.cjk")} · {CJK_FONT_FILE} · {LINE_HEIGHT_RATIO}×
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span>{t("pdfexport.dialog.title")}</span>
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

      <button
        type="button"
        data-testid="pdfexport-submit"
        disabled={targetIssue !== null || paragraphs.length === 0}
        onClick={() => void run()}
      >
        {t("pdfexport.dialog.title")}
      </button>

      <p data-testid="pdfexport-paragraphs" className="text-xs">
        {paragraphs.length}
      </p>

      {report ? (
        <p data-testid="pdfexport-report" className="text-xs">
          {report.pages} page(s) · {report.bytes_written} bytes · {report.font}
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
