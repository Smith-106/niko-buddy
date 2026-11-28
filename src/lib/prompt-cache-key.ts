/**
 * 确定性 Prompt Cache Routing Key 构造器（浏览器安全，零 Node 内置依赖）。
 *
 * 将项目、作用域、章号与会话收敛为短前缀键，供支持 `prompt_cache_key` 的
 * OpenAI / 兼容网关复用同一缓存节点；禁止引入 `node:crypto` 以免污染前端打包。
 */

export interface PromptCacheKeyParts {
  projectId?: string
  projectPath?: string
  scope: string
  chapterNumber?: number | string
  conversationId?: string
  subKey?: string
}

const MAX_CACHE_KEY_LEN = 64

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * 纯 JS FNV-1a 双 32 位哈希（输出 16 位十六进制），无外部依赖且确定性可复现。
 */
export function hashStableCacheInput(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5 ^ 0x9e3779b9
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= (code + i) & 0xffff
    h2 = Math.imul(h2, 0x01000193)
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, "0")
  const part2 = (h2 >>> 0).toString(16).padStart(8, "0")
  return `${part1}${part2}`
}

export function buildPromptCacheKey(parts: PromptCacheKeyParts): string {
  const normalizedPath = parts.projectPath
    ? parts.projectPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    : ""
  const projectSeed = parts.projectId?.trim() || normalizedPath || "global"
  const scope = sanitizeSegment(parts.scope) || "default"
  const chapterPart =
    parts.chapterNumber !== undefined && parts.chapterNumber !== null && String(parts.chapterNumber).trim() !== ""
      ? `ch:${String(parts.chapterNumber).trim()}`
      : ""
  const convPart = parts.conversationId?.trim() ? `conv:${parts.conversationId.trim()}` : ""
  const subPart = parts.subKey?.trim() ? `sub:${parts.subKey.trim()}` : ""
  const seed = [projectSeed, scope, chapterPart, convPart, subPart].filter(Boolean).join("|")
  const digest = hashStableCacheInput(seed)
  const readableChapter = chapterPart ? `:${sanitizeSegment(chapterPart.replace(":", ""))}` : ""
  const raw = `niko:${scope}${readableChapter}:${digest}`
  if (raw.length <= MAX_CACHE_KEY_LEN) return raw
  return `niko:${scope.slice(0, 24)}:${digest}`
}
