// @vitest-environment jsdom
/** PdfExportDialog 行为测试（TASK-032：替代 C4 空壳）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils";
import { PdfExportDialog } from "./PdfExportDialog";

const mocks = vi.hoisted(() => ({
  exportPdf: vi.fn(),
  exportConfirmedChapterPdf: vi.fn(),
  loadPdfExportHistory: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("@/lib/export/pdf-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/pdf-client")>();
  return { ...actual, exportPdf: mocks.exportPdf };
});

vi.mock("@/lib/export/pdf-export-gate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/export/pdf-export-gate")>();
  return {
    ...actual,
    exportConfirmedChapterPdf: mocks.exportConfirmedChapterPdf,
    loadPdfExportHistory: mocks.loadPdfExportHistory,
  };
});

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>();
  return { ...actual, readFile: mocks.readFile };
});

const REPORT = { pages: 3, bytes_written: 1024, font: "Noto Sans SC" };
const ENTRY = { confirmedDigest: "abc123", chapterPath: "chapters/c01.md" };

beforeEach(() => {
  setupDomGlobals();
  mocks.exportPdf.mockReset();
  mocks.exportConfirmedChapterPdf.mockReset();
  mocks.loadPdfExportHistory.mockReset();
  mocks.readFile.mockReset();
  mocks.exportPdf.mockResolvedValue(REPORT);
  mocks.readFile.mockResolvedValue("# c01\n正文");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PdfExportDialog — 渲染与校验", () => {
  it("渲染标题/字体说明/段落计数；默认目标可用", () => {
    render(<PdfExportDialog projectPath="/proj" title="T" paragraphs={["p1", "p2"]} />);
    expect(screen.getByTestId("pdf-export-dialog")).toBeTruthy();
    expect(screen.getByTestId("pdfexport-font-notice")).toBeTruthy();
    expect(screen.getByTestId("pdfexport-paragraphs").textContent).toContain("2");
    expect(screen.queryByTestId("pdfexport-target-warning")).toBeNull();
    expect((screen.getByTestId("pdfexport-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("非法目标 → 警告并禁用提交", () => {
    render(<PdfExportDialog projectPath="/proj" title="T" paragraphs={["p1"]} />);
    fireEvent.change(screen.getByTestId("pdfexport-target"), { target: { value: "noext" } });
    expect(screen.getByTestId("pdfexport-target-warning")).toBeTruthy();
    expect((screen.getByTestId("pdfexport-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("空正文 → 空提示 + 提交禁用 + 状态轨警告", () => {
    render(<PdfExportDialog projectPath="/proj" title="T" paragraphs={[]} />);
    expect(screen.getByTestId("pdfexport-empty-hint")).toBeTruthy();
    expect((screen.getByTestId("pdfexport-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("导出中按钮禁用并显示忙文案", async () => {
    let resolveExport!: (v: typeof REPORT) => void;
    mocks.exportPdf.mockReturnValue(
      new Promise<typeof REPORT>((r) => {
        resolveExport = r;
      }),
    );
    render(<PdfExportDialog projectPath="/proj" title="T" paragraphs={["p1"]} />);
    fireEvent.click(screen.getByTestId("pdfexport-submit"));
    await waitFor(() => expect(mocks.exportPdf).toHaveBeenCalled());
    expect((screen.getByTestId("pdfexport-submit") as HTMLButtonElement).disabled).toBe(true);
    resolveExport(REPORT);
    await waitFor(() => {
      expect(screen.getByTestId("pdfexport-report")).toBeTruthy();
    });
  });
});

describe("PdfExportDialog — 裸导出通道", () => {
  it("成功 → 报告区渲染", async () => {
    render(<PdfExportDialog projectPath="/proj" title="T" paragraphs={["p1"]} />);
    fireEvent.click(screen.getByTestId("pdfexport-submit"));
    await waitFor(() => expect(mocks.exportPdf).toHaveBeenCalledWith("/proj", "exports/book.pdf", "T", ["p1"]));
    const report = await screen.findByTestId("pdfexport-report");
    expect(report.textContent).toBeTruthy();
  });

  it("数据区错误 → outsideData 文案", async () => {
    mocks.exportPdf.mockRejectedValue(
      new Error("PDF_EXPORT_PATH_INSIDE_DATA_SECTION: 目标在数据区"),
    );
    render(<PdfExportDialog projectPath="/proj" title="T" paragraphs={["p1"]} />);
    fireEvent.click(screen.getByTestId("pdfexport-submit"));
    const err = await screen.findByTestId("pdfexport-error");
    await waitFor(() => {
      expect(err.textContent).toBeTruthy();
    });
    // 状态轨同步出现 danger 芯片
    expect(screen.getByTestId("pdfexport-status-rail").textContent).toContain(err.textContent ?? "x");
  });

  it("未确认错误 → notConfirmed 文案", async () => {
    mocks.exportPdf.mockRejectedValue(new Error("PDF_EXPORT_NOT_CONFIRMED: 需先确认"));
    render(<PdfExportDialog projectPath="/proj" title="T" paragraphs={["p1"]} />);
    fireEvent.click(screen.getByTestId("pdfexport-submit"));
    const err = await screen.findByTestId("pdfexport-error");
    expect(err.textContent).toContain("notConfirmed");
  });

  it("内容变化错误 → contentChanged 文案", async () => {
    mocks.exportPdf.mockRejectedValue(new Error("PDF_EXPORT_CONTENT_CHANGED: 变了"));
    render(<PdfExportDialog projectPath="/proj" title="T" paragraphs={["p1"]} />);
    fireEvent.click(screen.getByTestId("pdfexport-submit"));
    const err = await screen.findByTestId("pdfexport-error");
    expect(err.textContent).toContain("contentChanged");
  });

  it("普通错误 → 原文透出", async () => {
    mocks.exportPdf.mockRejectedValue(new Error("printer-gone"));
    render(<PdfExportDialog projectPath="/proj" title="T" paragraphs={["p1"]} />);
    fireEvent.click(screen.getByTestId("pdfexport-submit"));
    const err = await screen.findByTestId("pdfexport-error");
    expect(err.textContent).toContain("printer-gone");
    expect(screen.queryByTestId("pdfexport-report")).toBeNull();
  });
});

describe("PdfExportDialog — 确认导出通道", () => {
  it("成功 → 确认记录 + 历史计数；readChapterContent 读对路径", async () => {
    mocks.exportConfirmedChapterPdf.mockImplementation(async (input: {
      readChapterContent: () => Promise<string>;
    }) => {
      const content = await input.readChapterContent();
      expect(content).toContain("c01");
      return { report: REPORT, entry: ENTRY };
    });
    mocks.loadPdfExportHistory.mockResolvedValue([ENTRY, ENTRY]);
    render(
      <PdfExportDialog
        projectPath="/proj"
        title="T"
        paragraphs={["p1"]}
        chapterPath="chapters/c01.md"
      />,
    );
    fireEvent.click(screen.getByTestId("pdfexport-submit"));
    await waitFor(() => expect(mocks.exportConfirmedChapterPdf).toHaveBeenCalled());
    const call = mocks.exportConfirmedChapterPdf.mock.calls[0][0] as {
      projectPath: string;
      chapterPath: string;
    };
    expect(call.projectPath).toBe("/proj");
    expect(call.chapterPath).toBe("chapters/c01.md");
    expect(mocks.readFile).toHaveBeenCalledWith("/proj/chapters/c01.md");
    expect(await screen.findByTestId("pdfexport-confirm")).toBeTruthy();
    const history = await screen.findByTestId("pdfexport-history");
    expect(history.textContent).toBeTruthy();
    expect(mocks.loadPdfExportHistory).toHaveBeenCalledWith("/proj");
  });

  it("确认通道失败 → 错误态且无确认记录", async () => {
    mocks.exportConfirmedChapterPdf.mockRejectedValue(new Error("PDF_EXPORT_NOT_CONFIRMED: 未终章"));
    render(
      <PdfExportDialog
        projectPath="/proj"
        title="T"
        paragraphs={["p1"]}
        chapterPath="chapters/c01.md"
      />,
    );
    fireEvent.click(screen.getByTestId("pdfexport-submit"));
    expect(await screen.findByTestId("pdfexport-error")).toBeTruthy();
    expect(screen.queryByTestId("pdfexport-confirm")).toBeNull();
    expect(screen.queryByTestId("pdfexport-report")).toBeNull();
  });
});
