import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import { normalizePath } from "@/lib/path-utils"
import { isTauri } from "@/lib/platform"
import { convertFileSrc } from "@tauri-apps/api/core"

// 三处 Markdown 渲染共用的 remark/rehype 插件数组（chat-message / file-preview /
// wiki-reader）。各文件的 components 映射保持独立，这里只收敛插件列表，
// 避免 remarkGfm+remarkMath+rehypeKatex 重复引入。共享数组请勿原地修改。
export const sharedRemarkPlugins = [remarkGfm, remarkMath]
export const sharedRehypePlugins = [rehypeKatex]

const PASSTHROUGH_RE = /^(https?:|data:|blob:|file:|tauri:)/i

export function resolveMarkdownImageSrc(
  rawSrc: string,
  projectPath: string | null,
): string {
  if (!rawSrc) return rawSrc
  if (PASSTHROUGH_RE.test(rawSrc)) return rawSrc

  if (!projectPath) return rawSrc

  if (!isTauri()) return rawSrc

  const pp = normalizePath(projectPath)
  const isAbsolute =
    rawSrc.startsWith("/") || /^[a-zA-Z]:/.test(rawSrc) || rawSrc.startsWith("\\\\")

  if (isAbsolute) return convertFileSrc(rawSrc)

  const cleaned = rawSrc.replace(/^\.\//, "")
  const absolute = `${pp}/wiki/${cleaned}`

  return convertFileSrc(absolute)
}

export async function resolveMarkdownImageSrcAsync(
  rawSrc: string,
  projectPath: string | null,
): Promise<string> {
  if (!rawSrc) return rawSrc
  if (PASSTHROUGH_RE.test(rawSrc)) return rawSrc
  if (!projectPath) return rawSrc
  if (!isTauri()) return rawSrc

  const pp = normalizePath(projectPath)
  const isAbsolute =
    rawSrc.startsWith("/") || /^[a-zA-Z]:/.test(rawSrc) || rawSrc.startsWith("\\\\")

  if (isAbsolute) return convertFileSrc(rawSrc)

  const cleaned = rawSrc.replace(/^\.\//, "")
  const absolute = `${pp}/wiki/${cleaned}`
  return convertFileSrc(absolute)
}
