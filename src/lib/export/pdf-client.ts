/**
 * PDF 导出客户端（F-008）。
 *
 * 导出是**只读投影**：本层只读取调用方给的文本切片并调用 IPC；不触碰正文、不写记忆区。
 * 数据区路径在本地先挡一次（与 Rust 侧 `assert_export_path_outside_data_sections` 同一判据），
 * 免得用户填完对话框才被后端拒绝。
 */

import { invoke } from "@tauri-apps/api/core";
import { toErrorMessage } from "@/lib/utils";

/** 数据区目录名；这些目录内的路径一律不可作为导出目标。 */
export const DATA_SECTIONS = [".novel", "QM", ".niko-buddy", "backups"] as const;
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

function isAbsoluteFsPath(normalizedPath: string): boolean {
  return /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith("/");
}

function isWindowsDrivePath(normalizedPath: string): boolean {
  return /^[A-Za-z]:(?:\/|$)/.test(normalizedPath);
}

/**
 * 导出目标校验：返回 null 表示可用，否则返回 UI 文案键。
 * 越界与数据区共用同一条 UI 提示（`pdfexport.path.outsideData`）。
 *
 * - 单参调用（未传 projectPath）：保持 100% 向后兼容。
 * - 双参调用（传入 projectPath）：区分项目内外——
 *   1. 空路径 / 非 .pdf / 含 ".." 段 → 一律拒绝；
 *   2. 相对路径或落在 projectPath 内部 → 仅检查项目内相对路径段是否落入 DATA_SECTIONS；
 *   3. 落在 projectPath 外部的绝对路径（如 D:/backups/book.pdf）→ 放行，消除项目外祖先目录同名误拦。
 */
export function validateExportTarget(path: string, projectPath?: string): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) return "pdfexport.path.outsideData";
  if (!/\.pdf$/i.test(trimmed)) return "pdfexport.path.outsideData";

  const normalizedTarget = trimmed.replace(/\\/g, "/");
  const segments = normalizedTarget.replace(/^\/+/, "").split("/");
  if (segments.includes("..")) return "pdfexport.path.outsideData";

  if (!projectPath || projectPath.trim().length === 0) {
    if (isPathInsideDataSection(trimmed)) return "pdfexport.path.outsideData";
    return null;
  }

  if (!isAbsoluteFsPath(normalizedTarget)) {
    return isPathInsideDataSection(normalizedTarget) ? "pdfexport.path.outsideData" : null;
  }

  const targetSlashed = normalizedTarget.replace(/\/+$/, "");
  const projectSlashed = projectPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const isWinPair = isWindowsDrivePath(targetSlashed) && isWindowsDrivePath(projectSlashed);
  const targetComparable = isWinPair ? targetSlashed.toLowerCase() : targetSlashed;
  const projectComparable = isWinPair ? projectSlashed.toLowerCase() : projectSlashed;
  if (
    targetComparable === projectComparable ||
    targetComparable.startsWith(`${projectComparable}/`)
  ) {
    const relative = targetSlashed.slice(projectSlashed.length).replace(/^\/+/, "");
    if (isPathInsideDataSection(relative)) return "pdfexport.path.outsideData";
    if (isWinPair) {
      const lowerSections = DATA_SECTIONS.map((section) => section.toLowerCase());
      if (relative.split("/").some((segment) => lowerSections.includes(segment.toLowerCase()))) {
        return "pdfexport.path.outsideData";
      }
    }
    return null;
  }

  return null;
}

export function isPathInsideDataSectionError(error: unknown): boolean {
  const text = toErrorMessage(error);
  return text.includes(PATH_INSIDE_DATA_SECTION_PREFIX);
}

/** 调用后端生成 PDF。目标必须是数据区之外的路径。 */
export async function exportPdf(
  projectPath: string,
  target: string,
  title: string,
  paragraphs: string[],
): Promise<PdfExportReport> {
  const invalid = validateExportTarget(target, projectPath);
  if (invalid !== null) {
    throw new Error(`${PATH_INSIDE_DATA_SECTION_PREFIX}: 目标路径不可用于导出（${invalid}）`);
  }
  return invoke<PdfExportReport>("export_pdf", { projectPath, target, title, paragraphs });
}
