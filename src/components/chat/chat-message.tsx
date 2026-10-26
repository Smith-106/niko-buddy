import { useCallback, useEffect, useRef, useState, useMemo, memo } from "react"
import ReactMarkdown from "react-markdown"
import "katex/dist/katex.min.css"
import {
  Bot, User, FileText, ChevronDown, ChevronRight, RefreshCw, Copy, Check,
  Users, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, Layout, Globe,
  Image as ImageIcon, Loader2, Sparkles,
} from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { useTranslation } from "react-i18next"
import { readFile } from "@/commands/fs"
import { normalizePath, getFileName } from "@/lib/path-utils"
import { refreshProjectState } from "@/lib/project-refresh"
import { getLastQueryPages } from "@/components/chat/chat-shared"
import { FileEditPreview } from "@/components/chat/file-edit-preview"
// Wave 5 (v2.5.0): 上下文用量圆环 — 完成页透明度卡片（受控纯组件）。
import { ContextRing } from "@/components/chat/context-ring"
import { canOperateOnDeepChapterDraft, getContextUsageFromMessage, getManagedDeepChapterDraftStatus, isTerminalAssistantError, processContent, separateThinking } from "./chat-message-content"
import type { DisplayMessage } from "@/stores/chat-store"

import { resolveMarkdownImageSrc, sharedRehypePlugins, sharedRemarkPlugins } from "@/lib/markdown-image-resolver"
import { findRawSourceForImage, imageUrlToAbsolute } from "@/lib/raw-source-resolver"
import { detectLanguage } from "@/lib/detect-language"
import { getHtmlLang, getTextDirection } from "@/lib/language-metadata"
import { MermaidDiagram, unwrapMermaidPre } from "@/components/mermaid-diagram"
import { ErrorBoundary } from "@/components/error-boundary"
import { canContinueUnfinishedDeepChapter } from "@/lib/chat/resume"
import { getCopyableAssistantContent } from "@/lib/chat-copy-content"
import { parseAgentResponse } from "@/lib/novel"

interface ChatMessageProps {
  message: DisplayMessage
  isLastAssistant?: boolean
  onRegenerate?: () => void
  novelMode?: boolean
  projectPath?: string | null
  onSaveAsChapter?: (content: string) => void
  onAcceptAndContinueNext?: (content: string) => void
  onContinueNextChapter?: () => void
  onContinueUnfinished?: () => void
  onSaveAsDraft?: (content: string) => void
  onDiscardDraft?: () => void
  saveStatus?: string
  isSaving?: boolean
}


// A11Y-005 / IS-001 / IS-002 / POLISH-06 (odyssey-ui): shared focus + base
// styling for native action buttons. The audit found chat-message.tsx uses raw
// <button> elements with only hover/transition classes — no focus-visible ring,
// so keyboard users cannot see focus (WCAG 2.4.7). shadcn <Button> carries
// focus-visible:ring-3 ring-ring; these raw buttons opted out. This constant
// mirrors the project's input.tsx:12 focus-visible:ring convention and is reused
// across draft/copy/regenerate/cited buttons to prevent per-instance drift.
const ACTION_BUTTON_BASE =
  "rounded px-2 py-0.5 text-xs transition-colors duration-150 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:scale-[0.98]"


// ISS-20260709-010 (EC-004): ChatMessage 用 React.memo 避免 1000+ 消息列表
// 在父级任何 state 变化(hover/scroll/streaming)时全量重渲染。memo 浅比较
// props;回调引用由父级 chat-panel useCallback 稳定,message 对象引用稳定
// (chat-store 按 id 去重)。isLastAssistant 只对末条 assistant 消息变化,
// 非末条消息该 prop 恒定 false,不触发重渲染。
function ChatMessageImpl({ message, isLastAssistant, onRegenerate, novelMode, projectPath, onSaveAsChapter, onAcceptAndContinueNext, onContinueNextChapter, onContinueUnfinished, onDiscardDraft, saveStatus, isSaving }: ChatMessageProps) {
  const { t } = useTranslation()
  const isUser = message.role === "user"
  const isSystem = message.role === "system"
  const isAssistant = message.role === "assistant"
  const [hovered, setHovered] = useState(false)
  const managedDraftStatus = getManagedDeepChapterDraftStatus(message.content)
  const contextUsage = getContextUsageFromMessage(message.content)
  const canOperateOnDraft = Boolean(novelMode && isLastAssistant && canOperateOnDeepChapterDraft(message))
  const canAcceptDraft = canOperateOnDraft && managedDraftStatus === "ready"
  const canRejectDraft = canOperateOnDraft && (managedDraftStatus === "ready" || managedDraftStatus === "pending")
  const canResumeUnfinished = Boolean(
    novelMode && isLastAssistant && onContinueUnfinished && canContinueUnfinishedDeepChapter(message.content),
  )

  return (
    <div
      className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isSystem
            ? "bg-accent text-accent-foreground"
            : isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {isUser ? <User className="h-4 w-4 shrink-0" /> : <Bot className="h-4 w-4 shrink-0" />}
      </div>
      <div className="max-w-[95%] @md:max-w-[80%] min-w-0 flex flex-col gap-1.5">
        <div
          className={`rounded-lg px-3 py-2 text-sm min-w-0 overflow-x-auto ${
            isUser
              ? "bg-primary text-primary-foreground"
              : message.discarded
                // A11Y-001 (odyssey-ui): dropped the /50 opacity stack —
                // muted-foreground/50 on muted/50 computed ~1.85:1 (light) /
                // 3.2:1 (dark), failing WCAG 1.4.3 (4.5:1). De-emphasize via the
                // muted bg + italic style + smaller text, NOT opacity-on-muted.
                ? "bg-muted text-muted-foreground"
                : isTerminalAssistantError(message.content)
                  // EC-02 (odyssey-ui): stream/generation errors ('出错：',
                  // '已停止生成。') were indistinguishable from success replies.
                  // Render the bubble with a destructive variant so a glance
                  // distinguishes a failed generation.
                  ? "border border-destructive/40 bg-destructive/5 text-destructive"
                  : "bg-muted text-foreground"
          }`}
        >
          {message.discarded ? (
            <span className="italic text-xs">{t("chat.deprecated")}</span>
          ) : isUser ? (
            <p dir="auto" className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : (
            <AgentAwareContent content={message.content} projectPath={projectPath} />
          )}
        </div>
        {isAssistant && !message.discarded && <CitedReferencesPanel content={message.content} savedReferences={message.references} />}
        {isAssistant && !message.discarded && contextUsage && (
          <ContextRing usage={contextUsage} />
        )}
        {isAssistant && !message.discarded && (
          <div className="flex flex-col @sm:flex-row items-start @sm:items-center gap-1.5 @sm:flex-wrap">
            {canResumeUnfinished && (
              // VH-001 (odyssey-ui): replaced hardcoded amber-* scale (not in
              // Niko Buddy oklch token system, inconsistent across 3 themes) with
              // primary-token opacity tiers that adapt per-theme automatically.
              <div className="basis-full rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs leading-5 text-primary">
                这次深度生成已经完成了部分思考过程。点击“继续未完成”会基于上方已有阶段继续往后生成，通常比“重新生成”更节省 token；如果前面的思考方向本身不对，再使用“重新生成”。
              </div>
            )}
            {canAcceptDraft && onSaveAsChapter && (
              <button
                type="button"
                onClick={() => onSaveAsChapter(message.content)}
                disabled={isSaving}
                aria-busy={isSaving}
                aria-label={isSaving ? "保存中" : "接受草稿"}
                // POLISH-09 (odyssey-ui): accept is the primary commitment \u2014
                // solid-fill primary with Check icon, visually dominant over
                // reject/continue so the safe/forward action is unmistakable.
                className={`${ACTION_BUTTON_BASE} inline-flex items-center gap-1 border border-primary bg-primary font-medium text-primary-foreground elevation-1 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {isSaving ? <Loader2 className="h-3 w-3 animate-spin shrink-0" /> : <Check className="h-3 w-3 shrink-0" />}
                {isSaving ? "\u4fdd\u5b58\u4e2d" : "\u63a5\u53d7\u8349\u7a3f"}
              </button>
            )}
            {canAcceptDraft && onAcceptAndContinueNext && (
              <button
                type="button"
                onClick={() => onAcceptAndContinueNext(message.content)}
                disabled={isSaving}
                aria-busy={isSaving}
                className={`${ACTION_BUTTON_BASE} inline-flex items-center gap-1 border border-primary/60 bg-primary/10 font-medium text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50`}
                title="接受当前草稿并自动发起下一章撰写"
                aria-label="接受并撰写下一章"
              >
                {isSaving ? <Loader2 className="h-3 w-3 animate-spin shrink-0" /> : <Sparkles className="h-3 w-3 shrink-0" />}
                {"接受并撰写下一章"}
              </button>
            )}
            {canRejectDraft && onDiscardDraft && (
              <button
                type="button"
                onClick={onDiscardDraft}
                disabled={isSaving}
                aria-label="拒绝草稿"
                className={`${ACTION_BUTTON_BASE} border border-destructive/40 text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {"拒绝草稿"}
              </button>
            )}
            {canOperateOnDraft && onContinueNextChapter && (
              <button
                type="button"
                onClick={onContinueNextChapter}
                disabled={isSaving}
                aria-label="继续生成下一章"
                className={`${ACTION_BUTTON_BASE} border border-border text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50`}
              >
                继续生成下一章
              </button>
            )}
            {canResumeUnfinished && (
              <button
                type="button"
                onClick={onContinueUnfinished}
                disabled={isSaving}
                aria-label="继续未完成"
                // VH-002 (odyssey-ui): amber resume button → primary token tier,
                // consistent with the primary-tinted info banner above.
                className={`${ACTION_BUTTON_BASE} border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50`}
                title={t("chat.continueFromThought")}
              >
                继续未完成
              </button>
            )}
            {(hovered || (novelMode && isLastAssistant)) && (
              <CopyButton content={message.content} />
            )}
            {isLastAssistant && onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className={`${ACTION_BUTTON_BASE} inline-flex items-center gap-1 text-muted-foreground hover:bg-primary/10 hover:text-primary`}
                title={t("chat.regenerate")}
                aria-label={t("chat.regenerate")}
              >
                <RefreshCw className="h-3 w-3 shrink-0" /> 重新生成
              </button>
            )}
          </div>
        )}
        {saveStatus && (
          <p className="mt-1 text-xs text-muted-foreground">{saveStatus}</p>
        )}
      </div>
    </div>
  )
}

function CopyButton({ content }: { content: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    const clean = getCopyableAssistantContent(content)
    await navigator.clipboard.writeText(clean)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [content])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`${ACTION_BUTTON_BASE} inline-flex items-center gap-1 text-muted-foreground hover:bg-primary/10 hover:text-primary`}
      title={t("chat.copyToClipboard")}
      aria-label={t("chat.copyToClipboard")}
    >
      {copied ? <Check className="h-3 w-3 shrink-0" /> : <Copy className="h-3 w-3 shrink-0" />}
      {copied ? "已复制" : "复制"}
    </button>
  )
}

interface CitedPage {
  title: string
  path: string
}

const REF_TYPE_CONFIG: Record<string, { icon: typeof FileText; color: string }> = {
  entity: { icon: Users, color: "text-info" },
  concept: { icon: Lightbulb, color: "text-purple-500" },
  source: { icon: BookOpen, color: "text-orange-500" },
  query: { icon: HelpCircle, color: "text-success" },
  synthesis: { icon: GitMerge, color: "text-destructive" },
  comparison: { icon: BarChart3, color: "text-teal-500" },
  overview: { icon: Layout, color: "text-warning" },
  clip: { icon: Globe, color: "text-info" },
}

function getRefType(path: string): string {
  if (path.includes("/entities/")) return "entity"
  if (path.includes("/concepts/")) return "concept"
  if (path.includes("/sources/")) return "source"
  if (path.includes("/queries/")) return "query"
  if (path.includes("/synthesis/")) return "synthesis"
  if (path.includes("/comparisons/")) return "comparison"
  if (path.includes("overview")) return "overview"
  /* v8 ignore next */
  if (path.includes("raw/sources/")) return "clip"
  return "source"
}

/**
 * Markdown image-reference regex used to count `![](url)` occurrences
 * in cited pages AND extract the first URL (so the image-badge
 * jump button knows where to send the user). Same shape as the
 * search/pipeline regex elsewhere (kept duplicated to avoid
 * coupling — this module never wants to pull caption-pipeline
 * imports for a 3-character count).
 *
 * Group 1 captures the URL (everything inside `(...)` of the
 * markdown image syntax, no whitespace).
 */
const CITED_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

interface CitedImageInfo {
  count: number
  /** First image URL on the page — used as the scroll target when
   *  the badge button opens the raw source. Null when count===0. */
  firstUrl: string | null
}

/**
 * ISS-20260709-013: module-level image-info cache for CitedReferencesPanel.
 * Keyed by `${normalizedProjectPath}\n${page.path}` so a second render of
 * the same citation (same project + same path, e.g. re-render / another
 * message citing the same page) hits the cache without re-issuing readFile
 * IPC round-trips. Bounded LRU-ish (insertion-order eviction at cap) so a
 * 1000-message list cannot grow it without bound.
 */
export const citedPageImageCache = new Map<string, CitedImageInfo>()
export const CITED_PAGE_IMAGE_CACHE_MAX = 200

export function getCitedImageCacheKey(projectPath: string, pagePath: string): string {
  return `${normalizePath(projectPath)}\n${pagePath}`
}

export function __resetCitedImageCacheForTests(): void {
  citedPageImageCache.clear()
}

export function __getCitedImageCacheSizeForTests(): number {
  return citedPageImageCache.size
}

/** Build the ordered candidate absolute paths for a cited page. */
export function buildCitedPageCandidates(projectPath: string, pagePath: string): string[] {
  const pp = normalizePath(projectPath)
  const id = getFileName(pagePath.replace(/^wiki\//, "").replace(/\.md$/, ""))
  return [
    `${pp}/${pagePath}`,
    `${pp}/wiki/entities/${id}.md`,
    // 物理分层：实体可能已迁入 entities/<subdir>/，逐一探测。
    `${pp}/wiki/entities/characters/${id}.md`,
    `${pp}/wiki/entities/items/${id}.md`,
    `${pp}/wiki/entities/locations/${id}.md`,
    `${pp}/wiki/entities/organizations/${id}.md`,
    `${pp}/wiki/entities/events/${id}.md`,
    `${pp}/wiki/concepts/${id}.md`,
    `${pp}/wiki/sources/${id}.md`,
    `${pp}/wiki/queries/${id}.md`,
    `${pp}/wiki/synthesis/${id}.md`,
    `${pp}/wiki/comparisons/${id}.md`,
    `${pp}/wiki/${id}.md`,
  ]
}

/**
 * Probe candidate paths in PARALLEL and return the first existing file in
 * candidate order (index backfill保序). Each candidate is read concurrently
 * via Promise.all; the smallest index that succeeded wins, so result order
 * matches the serial fallback chain without paying N sequential IPC trips.
 * Returns null when every candidate is missing.
 */
export async function readFirstExistingCandidate(
  candidates: string[],
): Promise<{ index: number; path: string; text: string } | null> {
  const settled = await Promise.all(
    candidates.map(async (candidate, index) => {
      try {
        const text = await readFile(candidate)
        return { index, path: candidate, text }
      } catch {
        return null
      }
    }),
  )
  let best: { index: number; path: string; text: string } | null = null
  for (const entry of settled) {
    if (entry !== null && (best === null || entry.index < best.index)) best = entry
  }
  return best
}

export function extractCitedImageInfo(text: string): CitedImageInfo {
  // Reset stateful regex.lastIndex by `new RegExp(...)` —
  // module-level `g` regexes carry state across calls
  // and would skip matches on the second invocation.
  const re = new RegExp(CITED_IMAGE_RE.source, CITED_IMAGE_RE.flags)
  const matches = [...text.matchAll(re)]
  return {
    count: matches.length,
    firstUrl: matches.length > 0 ? (matches[0][1] as string) : null,
  }
}

/**
 * ISS-20260709-013: cached fetch for one citation (testable core of the
 * panel effect). Cache hit returns immediately without readFile; miss probes
 * candidates in parallel, stores the result, and returns it. Exported so the
 * perf spec can assert "同 projectPath+path 二次渲染命中缓存" without
 * mounting React.
 */
export async function getOrFetchCitedImageInfo(
  projectPath: string,
  pagePath: string,
): Promise<CitedImageInfo> {
  const pp = normalizePath(projectPath)
  const key = getCitedImageCacheKey(pp, pagePath)
  const hit = citedPageImageCache.get(key)
  if (hit !== undefined) return hit
  const candidates = buildCitedPageCandidates(pp, pagePath)
  const found = await readFirstExistingCandidate(candidates)
  const info: CitedImageInfo =
    found !== null ? extractCitedImageInfo(found.text) : { count: 0, firstUrl: null }
  citedPageImageCache.set(key, info)
  while (citedPageImageCache.size > CITED_PAGE_IMAGE_CACHE_MAX) {
    const oldest = citedPageImageCache.keys().next().value
    if (oldest === undefined) break
    citedPageImageCache.delete(oldest)
  }
  return info
}

function CitedReferencesPanel({ content, savedReferences }: { content: string; savedReferences?: CitedPage[] }) {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setPendingScrollImageSrc = useWikiStore((s) => s.setPendingScrollImageSrc)
  const [expanded, setExpanded] = useState(false)
  /**
   * Per-cited-page image info: count + first image URL. We can't
   * hang this off `CitedPage` directly because `extractCitedPages`
   * is sync and works on the AI's text response, never seeing the
   * underlying page. So we fetch the page contents lazily here.
   * Same path → same info, so a tiny in-component map keyed by
   * path is plenty.
   */
  const [imageInfos, setImageInfos] = useState<Record<string, CitedImageInfo>>({})

  // Use saved references first (persisted with message), fall back to dynamic extraction
  const citedPages = useMemo(() => {
    if (savedReferences && savedReferences.length > 0) return savedReferences
    return extractCitedPages(content)
  }, [content, savedReferences])

  // ISS-20260709-013: parallel fetch + result cache. Pages are independent
  // so they resolve via one outer Promise.all; each page's candidate chain
  // probes in parallel (readFirstExistingCandidate) with index backfill
  //保序, and hits consult citedPageImageCache first (same
  // projectPath+path → no second readFile). Failures degrade to
  // { count: 0, firstUrl: null } (page may not exist on disk yet, e.g. a
  // citation the LLM hallucinated).
  useEffect(() => {
    if (!project || citedPages.length === 0) return
    const pp = normalizePath(project.path)
    let cancelled = false
    // De-duplicate identical page.path values within this render so one
    // cache-miss fetch serves every duplicate citation.
    const seenPaths = new Set<string>()
    const uniquePages = citedPages.filter((page) => {
      if (seenPaths.has(page.path)) return false
      seenPaths.add(page.path)
      return true
    })
    const cachedEntries: Array<readonly [string, CitedImageInfo]> = []
    const missPages: typeof uniquePages = []
    for (const page of uniquePages) {
      const hit = citedPageImageCache.get(getCitedImageCacheKey(pp, page.path))
      if (hit !== undefined) cachedEntries.push([page.path, hit] as const)
      else missPages.push(page)
    }
    const fetchMiss = async (page: (typeof uniquePages)[number]): Promise<readonly [string, CitedImageInfo]> => {
      const info = await getOrFetchCitedImageInfo(pp, page.path)
      return [page.path, info] as const
    }
    Promise.all(missPages.map((page) => fetchMiss(page))).then((missEntries) => {
      if (cancelled) return
      const next: Record<string, CitedImageInfo> = {}
      for (const [path, info] of [...cachedEntries, ...missEntries]) next[path] = info
      // Expand back to every cited page (duplicates share the same info).
      const full: Record<string, CitedImageInfo> = {}
      for (const page of citedPages) {
        const info = next[page.path]
        if (info !== undefined) full[page.path] = info
      }
      setImageInfos(full)
    })
    // Seed synchronously-available cache hits so a cached second render
    // paints badges without waiting a tick for the miss fetch.
    if (cachedEntries.length > 0) {
      const seed: Record<string, CitedImageInfo> = {}
      for (const [path, info] of cachedEntries) seed[path] = info
      setImageInfos((prev) => ({ ...seed, ...prev }))
    }
    return () => {
      cancelled = true
    }
  }, [project, citedPages])

  /**
   * Open the raw source file for a page's first image and stage a
   * scroll target so the markdown preview lands on that image.
   * Mirrors the lightbox "Jump to source document" path in
   * search-view — same `findRawSourceForImage` resolver, same
   * `pendingScrollImageSrc` store handoff, same fallback to
   * opening the wiki page when no raw source is found.
   */
  const handleJumpToImageSource = useCallback(
    async (firstUrl: string, fallbackPath: string) => {
      if (!project) return
      const pp = normalizePath(project.path)
      const rawPath = await findRawSourceForImage(firstUrl, pp)
      if (rawPath) {
        try {
          const content = await readFile(rawPath)
          setPendingScrollImageSrc(imageUrlToAbsolute(firstUrl, pp))
          setSelectedFile(rawPath)
          setFileContent(content)
          return
        } catch (err) {
          console.warn(`[refs:image-jump] failed to read ${rawPath}:`, err)
        }
      }
      // Fallback: open the wiki summary itself with same scroll
      // target — at least the safety-net section will scroll into
      // view there.
      try {
        const content = await readFile(`${pp}/${fallbackPath}`)
        setPendingScrollImageSrc(firstUrl)
        setSelectedFile(`${pp}/${fallbackPath}`)
        setFileContent(content)
      } catch (err) {
        console.warn(`[refs:image-jump] fallback also failed:`, err)
      }
    },
    [project, setPendingScrollImageSrc, setSelectedFile, setFileContent],
  )

  if (citedPages.length === 0) return null

  const MAX_COLLAPSED = 3
  const visiblePages = expanded ? citedPages : citedPages.slice(0, MAX_COLLAPSED)
  const hasMore = citedPages.length > MAX_COLLAPSED

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 text-xs mb-1">
      <button
        type="button"
        onClick={() => hasMore && setExpanded(!expanded)}
        aria-expanded={hasMore ? expanded : undefined}
        aria-label={`引用资料（${citedPages.length}）`}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FileText className="h-3 w-3 shrink-0" />
        <span className="font-medium">引用资料（{citedPages.length}）</span>
        {hasMore && (
          expanded
            ? <ChevronDown className="h-3 w-3 shrink-0 ml-auto" />
            : <ChevronRight className="h-3 w-3 shrink-0 ml-auto" />
        )}
      </button>
      <div className="px-2 pb-1.5">
        {visiblePages.map((page, i) => {
          const refType = getRefType(page.path)
          /* v8 ignore next */
          const config = REF_TYPE_CONFIG[refType] ?? REF_TYPE_CONFIG.source
          const Icon = config.icon
          const info = imageInfos[page.path]
          const hasImages = (info?.count ?? 0) > 0
          const openCitedPage = async () => {
            if (!project) return
            const pp = normalizePath(project.path)
            const candidates = buildCitedPageCandidates(pp, page.path)
            // ISS-20260709-013: parallel candidate probe (index backfill保序)
            // instead of serial await-in-loop; first existing candidate wins.
            const found = await readFirstExistingCandidate(candidates)
            if (found !== null) {
              setSelectedFile(found.path)
              return
            }
            setSelectedFile(`${pp}/${page.path}`)
          }
          return (
            // Outer is a div, NOT a button — we have two click
            // targets inside (image badge + main row) and nesting
            // a button inside a button is invalid HTML and breaks
            // event delegation. Hover effect shifts to the inner
            // buttons individually so each gives feedback.
            <div
              key={page.path}
              className="flex w-full items-center gap-1.5 rounded text-left"
              title={page.path}
            >
              <span className="text-xs tabular-nums text-muted-foreground w-4 shrink-0 text-right">[{i + 1}]</span>
              {/*
               * Image badge — clickable, separately from the page
               * row. Click → resolve the FIRST image's raw source
               * (`raw/sources/<slug>.<ext>`) and open the FULL
               * combined-extraction preview, scrolled to that
               * image. This mirrors the search-view lightbox
               * "Jump to source document" behavior so the two
               * surfaces feel consistent.
               *
               * Icon: lucide `Image` (picture-frame outline with
               * mountain + sun) — direct visual cue for "image",
               * NOT `Camera` which reads as "take a photo".
               */}
              {hasImages && info?.firstUrl && (
                <button
                  type="button"
                  onClick={() => handleJumpToImageSource(info.firstUrl!, page.path)}
                  className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-xs text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                  title={`打开第一张图片所在原始文档（本页共 ${info.count} 张图片）`}
                  aria-label={`打开第一张图片所在原始文档（本页共 ${info.count} 张图片）`}
                >
                  <ImageIcon className="h-3 w-3 shrink-0" />
                  {info.count}
                </button>
              )}
              <button
                type="button"
                onClick={openCitedPage}
                aria-label={page.title}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon className={`h-3 w-3 shrink-0 ${config.color}`} />
                <span className="truncate text-foreground">{page.title}</span>
              </button>
            </div>
          )
        })}
        {hasMore && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label={`展开其余 ${citedPages.length - MAX_COLLAPSED} 条引用`}
            className="w-full text-center text-xs text-muted-foreground hover:text-primary pt-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            +{citedPages.length - MAX_COLLAPSED} 条更多引用...
          </button>
        )}
      </div>
    </div>
  )
}


/**
 * Extract cited wiki pages from the hidden <!-- cited: 1, 3, 5 --> comment.
 * Maps page numbers back to the pages that were sent to the LLM.
 */
function extractCitedPages(text: string): CitedPage[] {
  const lastQueryPages = getLastQueryPages()
  const citedMatch = text.match(/<!--\s*cited:\s*(.+?)\s*-->/)
  if (citedMatch && lastQueryPages.length > 0) {
    const numbers = citedMatch[1]
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n >= 1 && n <= lastQueryPages.length)

    const pages = numbers.map((n) => lastQueryPages[n - 1])
    if (pages.length > 0) return pages
  }

  // Fallback: if LLM used [1], [2] notation in text, try to match those
  if (lastQueryPages.length > 0) {
    const numberRefs = text.match(/\[(\d+)\]/g)
    if (numberRefs) {
      const numbers = [...new Set(numberRefs.map((r) => parseInt(r.slice(1, -1), 10)))]
        .filter((n) => n >= 1 && n <= lastQueryPages.length)
      if (numbers.length > 0) {
        return numbers.map((n) => lastQueryPages[n - 1])
      }
    }
  }

  // Fallback for persisted messages: extract [[wikilinks]] from the text
  // Try to resolve each wikilink to a real file path by checking common wiki subdirectories
  const wikilinks = text.match(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g)
  if (wikilinks) {
    const seen = new Set<string>()
    const pages: CitedPage[] = []
    const WIKI_DIRS = ["entities", "concepts", "sources", "queries", "synthesis", "comparisons"]

    for (const link of wikilinks) {
      const nameMatch = link.match(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/)
      /* v8 ignore next */
      if (nameMatch) {
        const id = nameMatch[1].trim()
        const display = nameMatch[2]?.trim() || id

        // Skip if id contains path separators (already a path like queries/xxx)
        if (seen.has(id)) continue
        seen.add(id)

        // Try to find the file in known wiki subdirectories
        let resolvedPath = ""
        if (id.includes("/")) {
          // Already has directory like "queries/my-query"
          resolvedPath = `wiki/${id}.md`
        } else {
          // Search in common directories
          for (const dir of WIKI_DIRS) {
            resolvedPath = `wiki/${dir}/${id}.md`
            // We can't do async file checking here, so try all known patterns
            // The click handler will try multiple paths
            break // Use first candidate, click handler resolves the rest
          }
          /* v8 ignore next */
          if (!resolvedPath) resolvedPath = `wiki/${id}.md`
        }

        pages.push({ title: display, path: resolvedPath })
      }
    }
    /* v8 ignore next */
    if (pages.length > 0) return pages
  }

  // No citations found
  return []
}

export const ChatMessage = memo(ChatMessageImpl)

interface StreamingMessageProps {
  content: string
}

export function StreamingMessage({ content }: StreamingMessageProps) {
  const { t } = useTranslation()
  const { thinking, answer } = useMemo(() => separateThinking(content), [content])
  const isThinking = thinking !== null && answer.length === 0
  // POLISH-01 (odyssey-ui): skeleton for the empty window before the first
  // token lands. Previously this rendered an empty bubble with a lone blinking
  // cursor — visually indistinguishable from a broken/stuck response. Three
  // placeholder lines with a staggered pulse read clearly as "loading" and
  // match the motion vocabulary (animate-pulse) used elsewhere.
  const isEmpty = !isThinking && answer.trim().length === 0

  return (
    <div className="flex gap-2 flex-row">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Bot className="h-4 w-4 shrink-0" />
      </div>
      <div className="max-w-[95%] @md:max-w-[80%] min-w-0 overflow-x-auto rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
        {isEmpty ? (
          <div className="flex flex-col gap-1.5 py-1" aria-label={t("chat.generating")} role="status">
            <div className="h-3 w-48 animate-pulse rounded bg-muted-foreground/20" />
            <div className="h-3 w-40 animate-pulse rounded bg-muted-foreground/20" style={{ animationDelay: "150ms" }} />
            <div className="h-3 w-44 animate-pulse rounded bg-muted-foreground/20" style={{ animationDelay: "300ms" }} />
          </div>
        ) : isThinking ? (
          <StreamingWorkflowBlock content={thinking} />
        ) : (
          <>
            {thinking && <WorkflowBlock content={thinking} />}
            <MarkdownContent content={answer} />
            <span className="animate-pulse">▊</span>
          </>
        )}
      </div>
    </div>
  )
}

function AgentAwareContent({ content, projectPath }: { content: string; projectPath?: string | null }) {
  const [applied, setApplied] = useState(false)
  const [results, setResults] = useState<import("@/lib/novel/agent-tools").FileEditResult[]>([])
  const [dismissed, setDismissed] = useState(false)

  const parsed = useMemo(() => parseAgentResponse(content), [content])

  const handleApply = useCallback(async (edits: import("@/lib/novel/agent-parser").FileEditAction[]) => {
    /* v8 ignore next */
    if (!projectPath) return []
    const { applyFileEdits } = await import("@/lib/novel/agent-tools")
    const editResults = await applyFileEdits(projectPath, edits)
    setResults(editResults)
    setApplied(true)
    // Refresh file tree
    await refreshProjectState(projectPath)
    return editResults
  }, [projectPath])

  return (
    <>
      <MarkdownContent content={parsed.textContent || content} />
      {parsed.hasEdits && !dismissed && projectPath ? (
        <FileEditPreview
          edits={parsed.edits}
          onApply={handleApply}
          onDismiss={() => setDismissed(true)}
          applied={applied}
          results={results}
        />
      ) : null}
    </>
  )
}

// ISS-20260709-010 (EC-004): MarkdownContent memo — content 不变时跳过
// ReactMarkdown/remark/rehype 重新解析(KaTeX/Mermaid 重算昂贵)。content 是
// string 浅比较即可,父 ChatMessage 已 memo 保证 content 引用稳定。
const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const { t } = useTranslation()
  // Strip hidden comments
  const cleaned = content.replace(/<!--.*?-->/gs, "").trimEnd()

  // Project path for resolving wiki-relative image src in chat
  // replies (LLM may surface images that came in via retrieved
  // chunks, e.g. when the chat answer cites a diagram from a wiki
  // page). Same convention the file-preview uses.
  const projectPath = useWikiStore((s) => s.project?.path ?? null)

  // Separate thinking blocks from main content, filter LLM English thinking but keep workflow stages
  const { thinking, answer } = useMemo(() => separateThinking(cleaned), [cleaned])
  const processed = useMemo(() => processContent(answer), [answer])
  const renderLanguage = useMemo(() => detectLanguage(answer), [answer])
  const direction = getTextDirection(renderLanguage)
  const htmlLang = getHtmlLang(renderLanguage)

  return (
    <div>
      {thinking && <WorkflowBlock content={thinking} />}
      <div
        className="chat-markdown prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none"
        dir={direction}
        lang={htmlLang}
        style={{ textAlign: "start" }}
      >
        {/* P0 robustness: each MarkdownContent owns an independent ErrorBoundary so a
            single malformed-KaTeX throw only degrades that message, never whitescreens
            the list. Fallback reuses errorBoundary.title (no new i18n key) + raw text. */}
        <ErrorBoundary
          fallback={
            <div className="whitespace-pre-wrap break-words text-xs">
              <p className="mb-1 font-medium text-destructive">
                {t("errorBoundary.title", { defaultValue: "Render failed, showing raw text / 内容渲染失败，已显示原文" })}
              </p>
              <pre className="whitespace-pre-wrap break-words">{processed}</pre>
            </div>
          }
        >
          <ReactMarkdown
          remarkPlugins={sharedRemarkPlugins}
          rehypePlugins={sharedRehypePlugins}
          components={{
            a: ({ href, children }) => {
              if (href?.startsWith("wikilink:")) {
                const pageName = href.slice("wikilink:".length)
                return <WikiLink pageName={pageName}>{children}</WikiLink>
              }
              return (
                <span className="text-primary underline cursor-default" title={href}>
                  {children}
                </span>
              )
            },
            img: ({ src, alt, ...props }) => (
              <img
                src={typeof src === "string" ? resolveMarkdownImageSrc(src, projectPath) : undefined}
                alt={alt ?? ""}
                className="my-2 max-w-full rounded border border-border/40"
                loading="lazy"
                {...props}
              />
            ),
            table: ({ children, ...props }) => (
              <div className="my-2 overflow-x-auto rounded border border-border">
                <table className="w-full border-collapse text-xs" {...props}>{children}</table>
              </div>
            ),
            thead: ({ children, ...props }) => (
              <thead className="bg-muted" {...props}>{children}</thead>
            ),
            th: ({ children, ...props }) => (
              <th className="border border-border/80 px-3 py-1.5 text-start font-semibold bg-muted" {...props}>{children}</th>
            ),
            td: ({ children, ...props }) => (
              <td className="border border-border/60 px-3 py-1.5" {...props}>{children}</td>
            ),
            pre: ({ children, ...props }) => {
              const mermaid = unwrapMermaidPre(children)
              if (mermaid) return <>{mermaid}</>
              return (
                <pre
                  dir="ltr"
                  className="rounded bg-background/50 p-2 text-xs overflow-x-auto"
                  style={{ textAlign: "left" }}
                  {...props}
                >
                  {children}
                </pre>
              )
            },
            code: ({ className, children, ...props }) => {
              const lang = className?.replace("language-", "")
              const codeText = String(children).replace(/\n$/, "")
              if (lang === "mermaid") {
                return <MermaidDiagram code={codeText} />
              }
              return <code dir="ltr" className={className} {...props}>{children}</code>
            },
          }}
        >
          {processed}
          </ReactMarkdown>
        </ErrorBoundary>
      </div>
    </div>
  )
})


/** Streaming workflow: show stages as they come in so user can see progress. */
function StreamingWorkflowBlock({ content }: { content: string }) {
  const { t } = useTranslation()
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 0)

  return (
    <div className="rounded-md border border-dashed border-primary/30 bg-primary/5 px-2.5 py-2 min-h-[3rem]">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-sm animate-pulse">📋</span>
        <span className="text-xs font-medium text-primary">{t("chat.workflowRunning")}</span>
      </div>
      <div className="max-h-72 overflow-y-auto pr-1 text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap break-words">
        {paragraphs.map((p, i) => (
          <div key={`p-${i}`} className={i > 0 ? "mt-1.5" : ""}>
            {p}
          </div>
        ))}
        <span className="animate-pulse text-primary">▊</span>
      </div>
    </div>
  )
}

/** Completed workflow stages: keep visible so user can review what happened. */
function WorkflowBlock({ content }: { content: string }) {
  const { t } = useTranslation()
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 0)

  return (
    <div className="mb-2 rounded-md border border-dashed border-border bg-muted/40 min-h-[3rem]">
      <div className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground">
        <span className="text-sm">📋</span>
        <span className="font-medium">{t("chat.workflowStage")}</span>
        <span className="text-xs tabular-nums">{paragraphs.length} 个阶段</span>
      </div>
      <div className="max-h-72 overflow-y-auto border-t border-border px-2.5 py-2 pr-1 text-xs text-foreground/90 whitespace-pre-wrap break-words leading-relaxed">
        {paragraphs.map((p, i) => (
          <div key={`p-${i}`} className={i > 0 ? "mt-1.5" : ""}>
            {p}
          </div>
        ))}
      </div>
    </div>
  )
}


function WikiLink({ pageName, children }: { pageName: string; children: React.ReactNode }) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [exists, setExists] = useState<boolean | null>(null)
  const resolvedPath = useRef<string | null>(null)

  useEffect(() => {
    if (!project) return
    const pp = normalizePath(project.path)
    const candidates = [
      `${pp}/wiki/entities/${pageName}.md`,
      `${pp}/wiki/entities/characters/${pageName}.md`,
      `${pp}/wiki/entities/items/${pageName}.md`,
      `${pp}/wiki/entities/locations/${pageName}.md`,
      `${pp}/wiki/entities/organizations/${pageName}.md`,
      `${pp}/wiki/entities/events/${pageName}.md`,
      `${pp}/wiki/concepts/${pageName}.md`,
      `${pp}/wiki/sources/${pageName}.md`,
      `${pp}/wiki/queries/${pageName}.md`,
      `${pp}/wiki/comparisons/${pageName}.md`,
      `${pp}/wiki/synthesis/${pageName}.md`,
      `${pp}/wiki/${pageName}.md`,
    ]

    let cancelled = false
    async function check() {
      for (const path of candidates) {
        try {
          await readFile(path)
          if (!cancelled) {
            resolvedPath.current = path
            setExists(true)
          }
          return
        } catch {
          // try next
        }
      }
      if (!cancelled) setExists(false)
    }
    check()
    return () => { cancelled = true }
  }, [project, pageName])

  const handleClick = useCallback(async () => {
    if (!resolvedPath.current) return
    try {
      const content = await readFile(resolvedPath.current)
      setSelectedFile(resolvedPath.current)
      setFileContent(content)
      setActiveView("wiki")
    } catch {
      // ignore
    }
  }, [setSelectedFile, setFileContent, setActiveView])

  if (exists === false) {
    return (
      <span className="inline text-muted-foreground" title={t("chat.pageNotFound", { defaultValue: "页面不存在: {{name}}", name: pageName })}>
        {children}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-primary underline decoration-primary/30 hover:bg-primary/10 hover:decoration-primary"
      title={`Open wiki page: ${pageName}`}
      aria-label={`Open wiki page: ${pageName}`}
    >
      <FileText className="inline h-3 w-3 shrink-0" />
      {children}
    </button>
  )
}
