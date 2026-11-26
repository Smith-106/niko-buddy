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

const SAFE_REMOTE_SCHEME_RE = /^(?:https?:|blob:|tauri:)/i
const DATA_SCHEME_RE = /^data:/i
const SAFE_RASTER_DATA_URI_RE =
  /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)(?:;charset=[^;,]+)?;base64,[a-z0-9+/=\s]+$/i
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const DEVICE_OR_UNC_RAW_RE = /^[\\/]{2}/
const ENCODED_TRAVERSAL_RE = /(?:%2e%2e|%2e\.|\.%2e|%2f|%5c|%00)/i
const DRIVE_PREFIX_RE = /^[a-zA-Z]:/
const DRIVE_ABS_RE = /^[a-zA-Z]:\//

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function normalizeCleanPath(input: string): string {
  const isPosixAbs = input.startsWith("/")
  const parts = input.split("/").filter((seg) => seg.length > 0 && seg !== ".")
  return isPosixAbs ? `/${parts.join("/")}` : parts.join("/")
}

function isStrictlyInside(target: string, root: string): boolean {
  const caseInsensitive = DRIVE_PREFIX_RE.test(root)
  const lhs = caseInsensitive ? target.toLowerCase() : target
  const rhs = caseInsensitive ? root.toLowerCase() : root
  return lhs.startsWith(`${rhs}/`)
}

export function resolveSafeProjectImagePath(
  rawSrc: string,
  projectPath: string,
): string | null {
  if (!rawSrc || !projectPath) return null
  if (hasControlChar(rawSrc)) return null

  const trimmed = rawSrc.trim()
  if (!trimmed) return null
  if (DEVICE_OR_UNC_RAW_RE.test(trimmed)) return null
  if (SCHEME_RE.test(trimmed) && !DRIVE_PREFIX_RE.test(trimmed)) return null
  if (ENCODED_TRAVERSAL_RE.test(trimmed)) return null

  const normalizedSrc = normalizePath(trimmed)
  if (normalizedSrc.startsWith("//")) return null
  if (DRIVE_PREFIX_RE.test(normalizedSrc) && !DRIVE_ABS_RE.test(normalizedSrc)) return null
  if (normalizedSrc.split("/").includes("..")) return null

  const pp = normalizeCleanPath(normalizePath(projectPath))
  if (!pp || pp === "/" || /^[a-zA-Z]:$/.test(pp)) return null

  const isAbsolute = normalizedSrc.startsWith("/") || DRIVE_ABS_RE.test(normalizedSrc)
  if (isAbsolute) {
    const candidate = normalizeCleanPath(normalizedSrc)
    return isStrictlyInside(candidate, pp) ? candidate : null
  }

  const cleaned = normalizeCleanPath(normalizedSrc)
  const wikiRoot = `${pp}/wiki`
  const candidate = normalizeCleanPath(`${wikiRoot}/${cleaned}`)
  return isStrictlyInside(candidate, wikiRoot) ? candidate : null
}

export function resolveMarkdownImageSrc(
  rawSrc: string,
  projectPath: string | null,
): string {
  if (!rawSrc) return ""
  if (hasControlChar(rawSrc)) return ""

  const trimmed = rawSrc.trim()
  if (!trimmed) return ""

  if (SAFE_REMOTE_SCHEME_RE.test(trimmed)) return rawSrc
  if (DATA_SCHEME_RE.test(trimmed)) {
    return SAFE_RASTER_DATA_URI_RE.test(trimmed) ? rawSrc : ""
  }
  if (DEVICE_OR_UNC_RAW_RE.test(trimmed)) return ""
  if (SCHEME_RE.test(trimmed) && !DRIVE_PREFIX_RE.test(trimmed)) return ""
  if (ENCODED_TRAVERSAL_RE.test(trimmed)) return ""

  const normalized = normalizePath(trimmed)
  if (normalized.startsWith("//")) return ""
  if (DRIVE_PREFIX_RE.test(normalized) && !DRIVE_ABS_RE.test(normalized)) return ""
  if (normalized.split("/").includes("..")) return ""

  const isAbsolute = normalized.startsWith("/") || DRIVE_ABS_RE.test(normalized)
  if (!projectPath) {
    return isAbsolute ? "" : rawSrc
  }

  const safePath = resolveSafeProjectImagePath(trimmed, projectPath)
  if (!safePath) return ""
  if (!isTauri()) return rawSrc
  return convertFileSrc(safePath)
}

export async function resolveMarkdownImageSrcAsync(
  rawSrc: string,
  projectPath: string | null,
): Promise<string> {
  return resolveMarkdownImageSrc(rawSrc, projectPath)
}
