/**
 * @license MIT © QMAI
 *
 * Image extraction orchestration for the ingest pipeline.
 *
 * Dispatches to the Rust-side extraction commands based on file
 * extension, computes destination paths, and builds the markdown
 * snippet for the LLM source context.
 */
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { isTauri } from "@/lib/platform"
import { toast } from "@/lib/toast"

/** Mirrors `commands::extract_images::SavedImage` on the Rust side. */
export interface SavedImage {
  index: number
  mimeType: string
  /** PDF page or PPTX slide number (1-based). DOCX always null. */
  page: number | null
  width: number
  height: number
  /** Path relative to the wiki/ root, e.g. `media/rope-paper/img-1.png`. */
  relPath: string
  /** Absolute filesystem path — used by `convertFileSrc` for preview. */
  absPath: string
  sha256: string
}

const PDF_EXTENSIONS = ["pdf"] as const
const OFFICE_EXTENSIONS = ["pptx", "docx", "ppt", "doc"] as const

/**
 * Rust 侧 `extract-images-progress` 事件载荷（③-11 契约）。
 * `{ current, total, file }` —— 已提取数 / 总数 / 当前文件名。
 */
export interface ExtractImagesProgress {
  current: number
  total: number
  file: string
}

/** extractAndSaveSourceImages 可选项（additive，既有调用方不受影响）。 */
export interface ExtractSourceImagesOptions {
  /**
   * 进度回调：内部订阅 `extract-images-progress` 事件后按帧转发，
   * 供 ingest 管线等调用方展示提取进度（③-11）。缺省不订阅。
   */
  onProgress?: (progress: ExtractImagesProgress) => void
}

/**
 * Extract every embedded image from a source file and save them to
 * `<projectPath>/wiki/media/<slug>/`.
 *
 * Returns an empty array for unsupported file types or when extraction
 * fails — image extraction must never abort the ingest pipeline.
 */
export async function extractAndSaveSourceImages(
  projectPath: string,
  sourcePath: string,
  options: ExtractSourceImagesOptions = {},
): Promise<SavedImage[]> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const fileName = getFileName(sp)
  /* v8 ignore next */
  const ext = fileName.split(".").pop()?.toLowerCase() ?? ""

  const isPdf = (PDF_EXTENSIONS as readonly string[]).includes(ext)
  const isOffice = (OFFICE_EXTENSIONS as readonly string[]).includes(ext)
  if (!isPdf && !isOffice) return []

  if (!isTauri()) return []

  const slug = fileName.replace(/\.[^.]+$/, "")
  const destDir = `${pp}/wiki/media/${slug}`
  const relTo = `${pp}/wiki`

  try {
    // ③-11：订阅 Rust 侧进度事件（{current,total,file}），转发给 onProgress。
    // 事件系统不可用时（非 Tauri / 旧后端）降级为不订阅，不影响提取主流程。
    let unlisten: UnlistenFn | undefined
    if (options.onProgress) {
      try {
        unlisten = await listen<ExtractImagesProgress>("extract-images-progress", (event) => {
          options.onProgress?.(event.payload)
        })
      } catch {
        unlisten = undefined
      }
    }
    try {
      const images = await invoke<unknown[]>(
        isPdf ? "extract_and_save_pdf_images_cmd" : "extract_and_save_office_images_cmd",
        { sourcePath: sp, destDir, relTo },
      )
      return images.filter((it): it is SavedImage => {
        if (!it || typeof it !== "object") return false
        const obj = it as Record<string, unknown>
        return (
          typeof obj.index === "number" &&
          typeof obj.relPath === "string" &&
          typeof obj.absPath === "string"
        )
      })
    } finally {
      unlisten?.()
    }
  } catch (err) {
    // ③-11：错误从静默吞错改为 toast 提示（保留 console.warn 供诊断）
    const message = err instanceof Error ? err.message : String(err)
    toast.error(`图片提取失败（${fileName}）：${message}`)
    console.warn(
      `[ingest:images] extraction failed for "${fileName}":`,
      message,
    )
    return []
  }
}

/**
 * Build the markdown section listing all extracted images for the
 * LLM source context.  Images are grouped by page (or "Document" for
 * DOCX) and ordered by page number.
 *
 * Returns an empty string when there are no images.
 */
export function buildImageMarkdownSection(
  images: SavedImage[],
  captionsBySha?: Map<string, string>,
): string {
  if (images.length === 0) return ""

  const lines: string[] = ["", "", "## Embedded Images", ""]

  // Group by page
  const byPage = new Map<string, SavedImage[]>()
  for (const img of images) {
    const key = img.page == null ? "Document" : `Page ${img.page}`
    const bucket = byPage.get(key)
    if (bucket) bucket.push(img)
    else byPage.set(key, [img])
  }

  // Sort page keys numerically, with "Document" last
  const ordered = [...byPage.keys()].sort((a, b) => {
    if (a === "Document") return 1
    if (b === "Document") return -1
    const numA = parseInt(a.replace(/\D/g, ""), 10) || 0
    const numB = parseInt(b.replace(/\D/g, ""), 10) || 0
    return numA - numB
  })

  const sanitise = (s: string): string =>
    s.replace(/[\r\n]+/g, " ").replace(/]/g, ")").trim()

  for (const key of ordered) {
    lines.push(`### ${key}`, "")
    /* v8 ignore next */
    for (const img of byPage.get(key) ?? []) {
      const caption = captionsBySha?.get(img.sha256)
      const alt = caption ? sanitise(caption) : ""
      lines.push(`![${alt}](${img.relPath})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
