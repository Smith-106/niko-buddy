/**
 * PDF 导出客户端（F-008）。
 *
 * 导出是**只读投影**：本层只读取调用方给的文本切片并调用 IPC；不触碰正文、不写记忆区。
 * 数据区路径在本地先挡一次（与 Rust 侧 `assert_export_path_outside_data_sections` 同一判据），
 * 免得用户填完对话框才被后端拒绝。
 */

import { invoke } from "@tauri-apps/api/core";

/** 数据区目录名；这些目录内的路径一律不可作为导出目标。 */
export const DATA_SECTIONS = [".novel", "QM", ".qmai", "backups"] as const;
/** 行距倍数（与 Rust 侧 `LINE_HEIGHT_RATIO` 一致）。 */
export const LINE_HEIGHT_RATIO = 1.5;
/** 内嵌中文字体文件名。 */
export const CJK_FONT_FILE = "NotoSerifCJKsc-Regular.otf";
/** 后端路径越界错误前缀。 */
export const PATH_INSIDE_DATA_SECTION_PREFIX = "PDF_EXPORT_PATH_INSIDE_DATA_SECTION";

export interface PdfExportReport {
  target: string;
  pages: number;
  paragraphs: number;
  font: string;
  line_height_ratio: number;
  bytes_written: number;
}

/** 路径是否落在数据区内（按路径段判断，不做字符串包含）。 */
export function isPathInsideDataSection(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.length === 0) return false;
  const segments = normalized.split("/");
  if (segments.includes("..")) return true;
  return segments.some((segment) => (DATA_SECTIONS as readonly string[]).includes(segment));
}

/**
 * 导出目标校验：返回 null 表示可用，否则返回 UI 文案键。
 * 越界与数据区共用同一条 UI 提示（`pdfexport.path.outsideData`）。
 */
export function validateExportTarget(path: string): string | null {
  if (path.trim().length === 0) return "pdfexport.path.outsideData";
  if (!/\.pdf$/i.test(path.trim())) return "pdfexport.path.outsideData";
  if (isPathInsideDataSection(path)) return "pdfexport.path.outsideData";
  return null;
}

export function isPathInsideDataSectionError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(PATH_INSIDE_DATA_SECTION_PREFIX);
}

/** 调用后端生成 PDF。目标必须是数据区之外的路径。 */
export async function exportPdf(
  projectPath: string,
  target: string,
  title: string,
  paragraphs: string[],
): Promise<PdfExportReport> {
  const invalid = validateExportTarget(target);
  if (invalid !== null) {
    throw new Error(`${PATH_INSIDE_DATA_SECTION_PREFIX}: 目标路径不可用于导出（${invalid}）`);
  }
  return invoke<PdfExportReport>("export_pdf", { projectPath, target, title, paragraphs });
}
