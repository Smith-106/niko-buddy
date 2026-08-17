import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  autoIngest,
  buildAnalysisPrompt,
  buildGenerationPrompt,
  executeIngestWrites,
  FILE_BLOCK_REGEX,
  isSafeIngestPath,
  languageRule,
  parseFileBlocks,
  startIngest,
} from "./ingest"
import { __resetProjectLocksForTesting } from "./project-mutex"
import type { LlmConfig } from "@/stores/wiki-store"

// ────────────────────────────────────────────────────────────────────────────
// Mock surface — every external dependency of ingest.ts is mocked here.
// path-utils and project-mutex are left REAL (pure, side-effect free).
// @/lib/embedding is reached only via dynamic import(); its mock uses a
// Proxy so tests can force the module namespace access to throw and reach
// the defensive "embedding module not available" catch.
// ────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  streamChat: vi.fn(),
  wikiGetState: vi.fn(),
  chatGetState: vi.fn(),
  activityGetState: vi.fn(),
  reviewGetState: vi.fn(),
  t: vi.fn(),
  checkIngestCache: vi.fn(),
  saveIngestCache: vi.fn(),
  sanitizeIngestedFileContent: vi.fn(),
  mergePageContent: vi.fn(),
  extractAndSaveSourceImages: vi.fn(),
  buildImageMarkdownSection: vi.fn(),
  captionMarkdownImages: vi.fn(),
  loadCaptionCache: vi.fn(),
  buildLanguageDirective: vi.fn(),
  detectLanguage: vi.fn(),
  sameScriptFamily: vi.fn(),
  embedPage: vi.fn(),
}))

let failEmbeddingModule = false

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  listDirectory: mocks.listDirectory,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: mocks.wikiGetState },
}))

vi.mock("@/stores/chat-store", () => ({
  useChatStore: { getState: mocks.chatGetState },
}))

vi.mock("@/i18n", () => ({
  default: { t: mocks.t },
}))

vi.mock("@/stores/activity-store", () => ({
  useActivityStore: { getState: mocks.activityGetState },
}))

vi.mock("@/stores/review-store", () => ({
  useReviewStore: { getState: mocks.reviewGetState },
}))

vi.mock("@/lib/ingest-cache", () => ({
  checkIngestCache: mocks.checkIngestCache,
  saveIngestCache: mocks.saveIngestCache,
}))

vi.mock("@/lib/ingest-sanitize", () => ({
  sanitizeIngestedFileContent: mocks.sanitizeIngestedFileContent,
}))

vi.mock("@/lib/page-merge", () => ({
  mergePageContent: mocks.mergePageContent,
}))

vi.mock("@/lib/extract-source-images", () => ({
  extractAndSaveSourceImages: mocks.extractAndSaveSourceImages,
  buildImageMarkdownSection: mocks.buildImageMarkdownSection,
}))

vi.mock("@/lib/image-caption-pipeline", () => ({
  captionMarkdownImages: mocks.captionMarkdownImages,
  loadCaptionCache: mocks.loadCaptionCache,
}))

vi.mock("@/lib/output-language", () => ({
  buildLanguageDirective: mocks.buildLanguageDirective,
}))

vi.mock("@/lib/detect-language", () => ({
  detectLanguage: mocks.detectLanguage,
}))

vi.mock("@/lib/language-metadata", () => ({
  sameScriptFamily: mocks.sameScriptFamily,
}))

vi.mock("@/lib/embedding", () => {
  const target = { embedPage: mocks.embedPage }
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "embedPage" && failEmbeddingModule) {
        throw new Error("module load failed")
      }
      return (t as Record<string, unknown>)[prop as string]
    },
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Fixtures / store fakes
// ────────────────────────────────────────────────────────────────────────────

const PP = "P:/proj"
const SP = "P:/proj/raw/doc.pdf"

const LLM: LlmConfig = {
  provider: "custom",
  apiKey: "k",
  model: "m",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 100_000,
}

interface ChatMessage {
  role: string
  content: string
}

interface FakeChat {
  mode: string
  messages: ChatMessage[]
  activeConversationId: string | null
  ingestSource: string | null
  setMode: ReturnType<typeof vi.fn>
  setIngestSource: ReturnType<typeof vi.fn>
  clearMessages: ReturnType<typeof vi.fn>
  clearStreaming: ReturnType<typeof vi.fn>
  addMessage: ReturnType<typeof vi.fn>
  startStreaming: ReturnType<typeof vi.fn>
  appendStreamToken: ReturnType<typeof vi.fn>
  finalizeStream: ReturnType<typeof vi.fn>
}

function makeChatState(): FakeChat {
  const messages: ChatMessage[] = []
  const state: FakeChat = {
    mode: "chat",
    messages,
    activeConversationId: "conv-1",
    ingestSource: null,
    setMode: vi.fn((m: string) => {
      state.mode = m
    }),
    setIngestSource: vi.fn((p: string | null) => {
      state.ingestSource = p
    }),
    clearMessages: vi.fn(() => {
      messages.length = 0
    }),
    clearStreaming: vi.fn(),
    addMessage: vi.fn((role: string, content: string) => {
      messages.push({ role, content })
    }),
    startStreaming: vi.fn(),
    appendStreamToken: vi.fn(),
    finalizeStream: vi.fn(),
  }
  return state
}

interface FakeActivity {
  items: Array<Record<string, unknown>>
  addItem: ReturnType<typeof vi.fn>
  updateItem: ReturnType<typeof vi.fn>
}

function makeActivityState(): FakeActivity {
  let seq = 0
  const items: Array<Record<string, unknown>> = []
  const state: FakeActivity = {
    items,
    addItem: vi.fn((partial: Record<string, unknown>) => {
      const id = `act-${++seq}`
      items.push({ id, ...partial })
      return id
    }),
    updateItem: vi.fn((id: string, updates: Record<string, unknown>) => {
      const item = items.find((i) => i.id === id)
      if (item) Object.assign(item, updates)
    }),
  }
  return state
}

interface FakeWiki {
  multimodalConfig: {
    enabled: boolean
    useMainLlm: boolean
    provider: string
    apiKey: string
    model: string
    ollamaUrl: string
    customEndpoint: string
    apiMode?: string
    concurrency: number
  }
  outputLanguage: string
  novelMode: boolean
  embeddingConfig: { enabled: boolean; endpoint: string; apiKey: string; model: string }
  setFileTree: ReturnType<typeof vi.fn>
  bumpDataVersion: ReturnType<typeof vi.fn>
}

function makeWikiState(): FakeWiki {
  return {
    multimodalConfig: {
      enabled: false,
      useMainLlm: true,
      provider: "custom",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      concurrency: 2,
    },
    outputLanguage: "auto",
    novelMode: false,
    embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
    setFileTree: vi.fn(),
    bumpDataVersion: vi.fn(),
  }
}

function installWikiState(overrides: Partial<FakeWiki> = {}): FakeWiki {
  const state = makeWikiState()
  Object.assign(state, overrides)
  mocks.wikiGetState.mockReturnValue(state)
  return state
}

function installChatState(): FakeChat {
  const state = makeChatState()
  mocks.chatGetState.mockReturnValue(state)
  return state
}

function installActivityState(): FakeActivity {
  const state = makeActivityState()
  mocks.activityGetState.mockReturnValue(state)
  return state
}

function installReviewState(): { addItems: ReturnType<typeof vi.fn> } {
  const state = { addItems: vi.fn() }
  mocks.reviewGetState.mockReturnValue(state)
  return state
}

// ────────────────────────────────────────────────────────────────────────────
// Behavior helpers
// ────────────────────────────────────────────────────────────────────────────

/** readFile fixture keyed by exact path; missing paths reject (→ "" via tryReadFile). */
function installReads(map: Record<string, string | Error>): void {
  mocks.readFile.mockImplementation((path: string) => {
    if (path in map) {
      const value = map[path]
      if (value instanceof Error) return Promise.reject(value)
      return Promise.resolve(value)
    }
    return Promise.reject(new Error(`readFile: no fixture for ${path}`))
  })
}

function defaultReads(overrides: Record<string, string | Error> = {}): Record<string, string | Error> {
  return {
    [SP]: "Source body ![](P:/proj/wiki/media/doc/img.png)",
    [`${PP}/schema.md`]: "schema text",
    [`${PP}/purpose.md`]: "purpose text",
    [`${PP}/wiki/index.md`]: "index text",
    [`${PP}/wiki/overview.md`]: "overview text",
    ...overrides,
  }
}

interface StreamHandlers {
  onToken?: (token: string) => void
  onDone?: () => void
  onError?: (err: unknown) => void
}

type StreamBehavior = (h: StreamHandlers) => void | Promise<void>

function streamSuccess(tokens: string[] = ["t"]): StreamBehavior {
  return (h) => {
    for (const token of tokens) h.onToken?.(token)
    h.onDone?.()
  }
}

const streamError = (err: unknown): StreamBehavior => (h) => h.onError?.(err)

const streamReject = (err: unknown): StreamBehavior => async () => {
  throw err
}

/** Queue of streamChat behaviors; exhausted queue falls back to onDone. */
function installStreamChat(behaviors: StreamBehavior[]): void {
  const queue = [...behaviors]
  mocks.streamChat.mockImplementation(
    async (_cfg: unknown, _msgs: unknown, handlers: StreamHandlers) => {
      const behavior = queue.shift()
      if (behavior) await behavior(handlers)
      else handlers.onDone?.()
    },
  )
}

function fileBlock(path: string, content: string): string {
  // Ensure the closer sits on its own line (the parser is line-anchored).
  const body = content.endsWith("\n") ? content : `${content}\n`
  return `---FILE: ${path}---\n${body}---END FILE---`
}

function reviewBlock(type: string, title: string, body: string): string {
  return `---REVIEW: ${type} | ${title}---\n${body}---END REVIEW---`
}

function writtenFiles(): Array<[string, string]> {
  return mocks.writeFile.mock.calls as Array<[string, string]>
}

const IMAGE = { relPath: "media/doc/img.png", page: 1, sha256: "abc" }

// ────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks()
  failEmbeddingModule = false
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  __resetProjectLocksForTesting()

  mocks.t.mockImplementation((key: string, params?: Record<string, unknown>) =>
    params ? `${key}(${JSON.stringify(params)})` : key,
  )
  mocks.sanitizeIngestedFileContent.mockImplementation((c: string) => c)
  mocks.buildLanguageDirective.mockImplementation((fallback: string = "") => `LANG:${fallback || "auto"}`)
  mocks.mergePageContent.mockImplementation(
    async (
      incoming: string,
      existing: string | null,
      mergeFn: unknown,
      opts: { sourceFileName?: string; signal?: AbortSignal; backup?: (old: string) => Promise<void> },
    ) => {
      if (existing && typeof mergeFn === "function") {
        if (opts?.backup) await opts.backup(existing)
        return mergeFn(existing, incoming, opts?.sourceFileName, opts?.signal)
      }
      return incoming
    },
  )
  mocks.captionMarkdownImages.mockImplementation(
    async (_pp: string, _src: string, _cfg: unknown, opts: Record<string, unknown> | undefined) => {
      const onProgress = opts?.onProgress as ((done: number, total: number) => void) | undefined
      const shouldCaption = opts?.shouldCaption as ((url: string) => boolean) | undefined
      const urlToAbsPath = opts?.urlToAbsPath as ((url: string) => string) | undefined
      onProgress?.(1, 1)
      shouldCaption?.(`${PP}/wiki/media/doc/img.png`)
      shouldCaption?.("https://external/x.png")
      urlToAbsPath?.(`${PP}/wiki/media/doc/img.png`)
      return { enrichedMarkdown: "captioned", freshCaptions: 1, cachedCaptions: 0, failed: 0 }
    },
  )
  mocks.loadCaptionCache.mockResolvedValue(new Map([["abc", "caption text"]]))
  mocks.buildImageMarkdownSection.mockReturnValue("## Embedded Images\n\n![doc image](media/doc/img.png)")
  mocks.extractAndSaveSourceImages.mockResolvedValue([])
  mocks.checkIngestCache.mockResolvedValue(null)
  mocks.saveIngestCache.mockResolvedValue(undefined)
  mocks.embedPage.mockResolvedValue(undefined)
  mocks.listDirectory.mockResolvedValue([])
  mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: StreamHandlers) => {
    handlers.onDone?.()
  })
  mocks.detectLanguage.mockReturnValue("English")

  installWikiState()
  installChatState()
  installActivityState()
  installReviewState()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ────────────────────────────────────────────────────────────────────────────
// isSafeIngestPath
// ────────────────────────────────────────────────────────────────────────────

describe("isSafeIngestPath", () => {
  it("accepts valid wiki-relative paths", () => {
    expect(isSafeIngestPath("wiki/concepts/foo.md")).toBe(true)
    expect(isSafeIngestPath("wiki/sources/my-page.md")).toBe(true)
    expect(isSafeIngestPath("wiki/entities/foo/bar.md")).toBe(true)
  })

  it("rejects non-strings, empty and whitespace-only inputs", () => {
    expect(isSafeIngestPath("")).toBe(false)
    expect(isSafeIngestPath("   ")).toBe(false)
    expect(isSafeIngestPath(undefined as unknown as string)).toBe(false)
  })

  it("rejects control / NUL bytes", () => {
    expect(isSafeIngestPath("wiki/a\u0000b.md")).toBe(false)
    expect(isSafeIngestPath("wiki/a\u0001b.md")).toBe(false)
  })

  it("rejects absolute POSIX and backslash paths", () => {
    expect(isSafeIngestPath("/etc/passwd")).toBe(false)
    expect(isSafeIngestPath("\\etc\\passwd")).toBe(false)
  })

  it("rejects Windows drive letters and UNC-ish payloads", () => {
    expect(isSafeIngestPath("C:/Windows/system32")).toBe(false)
    expect(isSafeIngestPath("c:\\evil\\x.md")).toBe(false)
  })

  it("rejects any .. segment", () => {
    expect(isSafeIngestPath("wiki/../x.md")).toBe(false)
    expect(isSafeIngestPath("wiki/a/../../b.md")).toBe(false)
  })

  it("rejects empty segments (double slashes, trailing slash)", () => {
    expect(isSafeIngestPath("wiki//x.md")).toBe(false)
    expect(isSafeIngestPath("wiki/x/")).toBe(false)
  })

  it("rejects Windows-invalid filename characters", () => {
    expect(isSafeIngestPath("wiki/a<b.md")).toBe(false)
    expect(isSafeIngestPath('wiki/a"b.md')).toBe(false)
    expect(isSafeIngestPath("wiki/a|b.md")).toBe(false)
    expect(isSafeIngestPath("wiki/a?b.md")).toBe(false)
    expect(isSafeIngestPath("wiki/a*b.md")).toBe(false)
  })

  it("rejects segments ending in space or dot", () => {
    expect(isSafeIngestPath("wiki/foo /x.md")).toBe(false)
    expect(isSafeIngestPath("wiki/foo./x.md")).toBe(false)
  })

  it("rejects reserved device names (case-insensitive, any extension)", () => {
    expect(isSafeIngestPath("wiki/CON")).toBe(false)
    expect(isSafeIngestPath("wiki/prn.md")).toBe(false)
    expect(isSafeIngestPath("wiki/aux/x.md")).toBe(false)
    expect(isSafeIngestPath("wiki/NUL.md")).toBe(false)
    expect(isSafeIngestPath("wiki/COM1.md")).toBe(false)
    expect(isSafeIngestPath("wiki/lpt9.md")).toBe(false)
  })

  it("rejects dot-led segments (empty stem)", () => {
    expect(isSafeIngestPath("wiki/.hidden.md")).toBe(false)
    expect(isSafeIngestPath("wiki/foo/..")).toBe(false)
  })

  it("requires the wiki/ prefix", () => {
    expect(isSafeIngestPath("concepts/x.md")).toBe(false)
    expect(isSafeIngestPath("wiki2/x.md")).toBe(false)
    expect(isSafeIngestPath("wiki")).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// parseFileBlocks
// ────────────────────────────────────────────────────────────────────────────

describe("parseFileBlocks", () => {
  it("parses a simple block", () => {
    const text = "---FILE: wiki/a.md---\nline1\nline2\n---END FILE---"
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toEqual([{ path: "wiki/a.md", content: "line1\nline2" }])
    expect(warnings).toEqual([])
  })

  it("handles CRLF line endings (H1)", () => {
    const text = "---FILE: wiki/a.md---\r\nline1\r\n---END FILE---\r\n"
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toEqual([{ path: "wiki/a.md", content: "line1" }])
  })

  it("tolerates marker whitespace / case variants (H3)", () => {
    const text = [
      "--- FILE: wiki/a.md ---",
      "A",
      "--- end file ---",
      "---FILE: wiki/b.md---",
      "B",
      "---END FILE---",
      "",
    ].join("\n")
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toEqual([
      { path: "wiki/a.md", content: "A" },
      { path: "wiki/b.md", content: "B" },
    ])
  })

  it("trims path whitespace", () => {
    const text = "---FILE:  wiki/a.md   ---\nX\n---END FILE---"
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toEqual([{ path: "wiki/a.md", content: "X" }])
  })

  it("warns and drops an unclosed block, labeling its path (H2)", () => {
    const text = "---FILE: wiki/a.md---\npartial"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("wiki/a.md")
    expect(warn).toHaveBeenCalled()
  })

  it("labels an unclosed block with an empty path as (unnamed)", () => {
    const text = "---FILE:  ---\npartial"
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toEqual([])
    expect(warnings[0]).toContain("(unnamed)")
  })

  it("warns on an empty path (H6)", () => {
    const text = "---FILE:  ---\ncontent\n---END FILE---"
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toEqual([])
    expect(warnings[0]).toContain("路径为空")
  })

  it("warns and drops unsafe (path-traversal) paths", () => {
    const text = "---FILE: ../../../etc/passwd---\nX\n---END FILE---"
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toEqual([])
    expect(warnings[0]).toContain("不安全")
  })

  it("treats a nested opener line inside a block as body text (not a closer)", () => {
    const text = [
      "---FILE: wiki/a.md---",
      "partial",
      "---FILE: wiki/b.md---",
      "B",
      "---END FILE---",
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toEqual([
      { path: "wiki/a.md", content: "partial\n---FILE: wiki/b.md---\nB" },
    ])
    expect(warnings).toEqual([])
  })

  it("ignores literal closers inside backtick code fences (H5)", () => {
    const text = [
      "---FILE: wiki/a.md---",
      "```",
      "---END FILE---",
      "```",
      "after fence",
      "---END FILE---",
    ].join("\n")
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toEqual([
      { path: "wiki/a.md", content: "```\n---END FILE---\n```\nafter fence" },
    ])
  })

  it("handles tilde fences", () => {
    const text = [
      "---FILE: wiki/a.md---",
      "~~~",
      "---END FILE---",
      "~~~",
      "after",
      "---END FILE---",
    ].join("\n")
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toEqual([{ path: "wiki/a.md", content: "~~~\n---END FILE---\n~~~\nafter" }])
  })

  it("does not close a fence on a shorter same-char run", () => {
    const text = [
      "---FILE: wiki/a.md---",
      "```",
      "``",
      "---END FILE---",
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it("does not close a fence on a different fence char", () => {
    const text = [
      "---FILE: wiki/a.md---",
      "```",
      "~~~~",
      "---END FILE---",
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it("returns empty results when no blocks are present", () => {
    const { blocks, warnings } = parseFileBlocks("just prose\nno blocks")
    expect(blocks).toEqual([])
    expect(warnings).toEqual([])
  })

  it("legacy FILE_BLOCK_REGEX still matches the canonical shape", () => {
    const text = "---FILE: wiki/a.md---\nX\n---END FILE---"
    const matches = [...text.matchAll(FILE_BLOCK_REGEX)]
    expect(matches).toHaveLength(1)
    expect(matches[0][1]).toBe("wiki/a.md")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// languageRule / prompt builders
// ────────────────────────────────────────────────────────────────────────────

describe("languageRule", () => {
  it("delegates to buildLanguageDirective with default and explicit content", () => {
    expect(languageRule()).toBe("LANG:auto")
    expect(languageRule("source text")).toBe("LANG:source text")
  })
})

describe("buildAnalysisPrompt", () => {
  it("includes purpose and index when present", () => {
    const prompt = buildAnalysisPrompt("purpose x", "index y", "source")
    expect(prompt).toContain("## Wiki Purpose (for context)")
    expect(prompt).toContain("purpose x")
    expect(prompt).toContain("## Current Wiki Index")
    expect(prompt).toContain("index y")
  })

  it("omits purpose and index when absent", () => {
    const prompt = buildAnalysisPrompt("", "")
    expect(prompt).not.toContain("## Wiki Purpose")
    expect(prompt).not.toContain("## Current Wiki Index")
  })
})

describe("buildGenerationPrompt", () => {
  it("omits novel fields outside novel mode and includes optional context", () => {
    const prompt = buildGenerationPrompt("schema", "purpose", "index", "doc.pdf", "overview", "source")
    expect(prompt).toContain("wiki/sources/doc.md")
    expect(prompt).not.toContain("chapter_number")
    expect(prompt).toContain("## Wiki Schema")
    expect(prompt).toContain("## Wiki Purpose")
    expect(prompt).toContain("## Current Overview")
  })

  it("includes novel frontmatter fields in novel mode", () => {
    installWikiState({ novelMode: true })
    const prompt = buildGenerationPrompt("", "", "", "outline.md")
    expect(prompt).toContain("chapter_number")
    expect(prompt).not.toContain("## Wiki Schema")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// autoIngest — cache-hit paths
// ────────────────────────────────────────────────────────────────────────────

describe("autoIngest cache-hit paths", () => {
  it("returns cached files and skips the pipeline when no images were extracted", async () => {
    installReads(defaultReads())
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
    expect(mocks.captionMarkdownImages).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(mocks.embedPage).not.toHaveBeenCalled()
    const activity = mocks.activityGetState() as FakeActivity
    expect(activity.items[0].status).toBe("done")
    expect(activity.updateItem).toHaveBeenCalledWith(
      "act-1",
      expect.objectContaining({ detail: expect.stringContaining("skippedUnchanged") }),
    )
  })

  it("skips caption + inject + reembed when multimodal is disabled", async () => {
    installReads(defaultReads())
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: false } })

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
    expect(mocks.captionMarkdownImages).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(mocks.embedPage).not.toHaveBeenCalled()
  })

  it("captions, injects and re-embeds on a cache hit (useMainLlm)", async () => {
    const summaryExisting =
      "---\ntype: source\ntitle: Doc Summary\n---\n# Source: doc.pdf\n\nOld body"
    installReads(defaultReads({ [`${PP}/wiki/sources/doc.md`]: summaryExisting }))
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({
      multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true },
      embeddingConfig: { enabled: true, endpoint: "", apiKey: "", model: "e" },
    })

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
    // caption called with the main LLM config when useMainLlm is set
    expect(mocks.captionMarkdownImages).toHaveBeenCalledWith(PP, expect.any(String), LLM, expect.anything())
    // safety-net inject replaced the existing page in place (kept old body)
    const writes = writtenFiles()
    const summary = writes.find(([p]) => p === `${PP}/wiki/sources/doc.md`)
    expect(summary).toBeDefined()
    expect(summary![1]).toContain("<!-- llm-wiki:embedded-images -->")
    expect(summary![1]).toContain("Old body")
    // re-embed ran with the embedding config, title parsed from frontmatter
    expect(mocks.embedPage).toHaveBeenCalledWith(
      PP,
      "doc",
      "Doc Summary",
      summaryExisting,
      expect.objectContaining({ enabled: true }),
    )
  })

  it("projects a dedicated multimodal config when useMainLlm is false", async () => {
    installReads(defaultReads())
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({
      multimodalConfig: {
        ...makeWikiState().multimodalConfig,
        enabled: true,
        useMainLlm: false,
        provider: "anthropic",
        apiKey: "mm-key",
        model: "mm-model",
        ollamaUrl: "http://ollama",
        customEndpoint: "http://custom",
        apiMode: "responses",
      },
    })

    await autoIngest(PP, SP, LLM)

    const [, , captionCfg] = mocks.captionMarkdownImages.mock.calls[0] as [string, string, LlmConfig]
    expect(captionCfg.provider).toBe("anthropic")
    expect(captionCfg.apiKey).toBe("mm-key")
    expect(captionCfg.model).toBe("mm-model")
    expect(captionCfg.ollamaUrl).toBe("http://ollama")
    expect(captionCfg.customEndpoint).toBe("http://custom")
    expect(captionCfg.apiMode).toBe("responses")
    expect(captionCfg.maxContextSize).toBe(LLM.maxContextSize)
  })

  it("swallows caption failures on the cache-hit path and still injects (Error)", async () => {
    installReads(defaultReads({ [`${PP}/wiki/sources/doc.md`]: "existing" }))
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({
      multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true },
      embeddingConfig: { enabled: true, endpoint: "", apiKey: "", model: "e" },
    })
    mocks.captionMarkdownImages.mockRejectedValue(new Error("caption boom"))

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
    expect(console.warn).toHaveBeenCalled()
  })

  it("swallows caption failures on the cache-hit path and still injects (string)", async () => {
    installReads(defaultReads({ [`${PP}/wiki/sources/doc.md`]: "existing" }))
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({
      multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true },
      embeddingConfig: { enabled: true, endpoint: "", apiKey: "", model: "e" },
    })
    // reject with a non-Error value → exercises the String(err) fallback
    mocks.captionMarkdownImages.mockRejectedValue("caption boom (string)")

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
    expect(console.warn).toHaveBeenCalled()
    const writes = writtenFiles()
    expect(writes.some(([p]) => p === `${PP}/wiki/sources/doc.md`)).toBe(true)
  })

  it("replaces a prior marker-bracketed injection in-place", async () => {
    const existing = [
      "old front",
      "",
      "<!-- llm-wiki:embedded-images -->",
      "OLD SECTION",
      "<!-- llm-wiki:embedded-images -->",
      "old tail",
    ].join("\n")
    installReads(defaultReads({ [`${PP}/wiki/sources/doc.md`]: existing }))
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({
      multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true },
      embeddingConfig: { enabled: true, endpoint: "", apiKey: "", model: "e" },
    })

    await autoIngest(PP, SP, LLM)

    const writes = writtenFiles()
    const summary = writes.find(([p]) => p === `${PP}/wiki/sources/doc.md`)
    expect(summary).toBeDefined()
    expect(summary![1]).not.toContain("OLD SECTION")
    expect(summary![1]).toContain("old front")
    expect(summary![1]).toContain("old tail")
    expect(summary![1]).toContain("<!-- llm-wiki:embedded-images -->")
  })

  it("re-embed falls back to the page id when no title is present", async () => {
    installReads(defaultReads({ [`${PP}/wiki/sources/doc.md`]: "no frontmatter here" }))
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({
      multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true },
      embeddingConfig: { enabled: true, endpoint: "", apiKey: "", model: "e" },
    })

    await autoIngest(PP, SP, LLM)

    expect(mocks.embedPage).toHaveBeenCalledWith(
      PP,
      "doc",
      "doc",
      "no frontmatter here",
      expect.objectContaining({ model: "e" }),
    )
  })

  it("re-embed swallows read failures (Error)", async () => {
    installReads(defaultReads({ [`${PP}/wiki/sources/doc.md`]: new Error("gone") }))
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({
      multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true },
      embeddingConfig: { enabled: true, endpoint: "", apiKey: "", model: "e" },
    })

    await autoIngest(PP, SP, LLM)

    expect(mocks.embedPage).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
  })

  it("re-embed swallows read failures (string)", async () => {
    const base = defaultReads({ [`${PP}/wiki/sources/doc.md`]: "existing" })
    installReads(base)
    // reject with a non-Error value → String(err) fallback in the catch
    mocks.readFile.mockImplementation((path: string) =>
      path === `${PP}/wiki/sources/doc.md`
        ? Promise.reject("gone (string)")
        : Promise.resolve((base as Record<string, string | Error>)[path] ?? ""),
    )
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({
      multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true },
      embeddingConfig: { enabled: true, endpoint: "", apiKey: "", model: "e" },
    })

    await autoIngest(PP, SP, LLM)

    expect(mocks.embedPage).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
  })

  it("image extraction failure on the cache-hit path is non-fatal (Error)", async () => {
    installReads(defaultReads())
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockRejectedValue(new Error("extract boom"))

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
    expect(console.warn).toHaveBeenCalled()
    expect((mocks.activityGetState() as FakeActivity).items[0].status).toBe("done")
  })

  it("image extraction failure on the cache-hit path is non-fatal (string)", async () => {
    installReads(defaultReads())
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockRejectedValue("extract boom (string)")

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
    expect(console.warn).toHaveBeenCalled()
    expect((mocks.activityGetState() as FakeActivity).items[0].status).toBe("done")
  })

  it("a falsy caption LLM (undefined main config) skips captioning but still injects", async () => {
    installReads(defaultReads())
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })

    await autoIngest(PP, SP, undefined as unknown as LlmConfig)

    expect(mocks.captionMarkdownImages).not.toHaveBeenCalled()
    expect(writtenFiles().some(([p]) => p === `${PP}/wiki/sources/doc.md`)).toBe(true)
  })

  it("inject image-section write failures are warned, not fatal (Error)", async () => {
    installReads(defaultReads())
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.writeFile.mockRejectedValue(new Error("inject write boom"))

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
    expect(console.warn).toHaveBeenCalled()
  })

  it("inject image-section write failures are warned, not fatal (string)", async () => {
    installReads(defaultReads())
    mocks.checkIngestCache.mockResolvedValue(["wiki/sources/doc.md"])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.writeFile.mockRejectedValue("inject write boom (string)")

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
    expect(console.warn).toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// autoIngest — full pipeline (cache MISS)
// ────────────────────────────────────────────────────────────────────────────

const GENERATION = [
  fileBlock("wiki/concepts/alpha.md", "# Alpha\nBody text.\n"),
  fileBlock("wiki/entities/beta.md", "# Beta\nNew beta body.\n"),
  fileBlock("wiki/log.md", "## [2026-07-01] ingest | doc"),
  fileBlock("wiki/sources/doc.md", "# Source: doc.pdf\nSummary body.\n"),
  reviewBlock(
    "contradiction",
    "Conflict found",
    "There is a conflict.\nOPTIONS: Create Page | Skip\nPAGES: wiki/concepts/alpha.md\nSEARCH: q1 | q2",
  ),
].join("\n\n")

describe("autoIngest full pipeline", () => {
  it("runs the full pipeline end to end", async () => {
    installReads(
      defaultReads({
        [`${PP}/wiki/entities/beta.md`]: "---\ntype: entity\n---\n# Beta\nOld body",
        [`${PP}/wiki/log.md`]: "## [2026-06-01] ingest | other",
      }),
    )
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installStreamChat([streamSuccess(["analysis text"]), streamSuccess([GENERATION]), streamSuccess(["merged"])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual([
      "wiki/concepts/alpha.md",
      "wiki/entities/beta.md",
      "wiki/log.md",
      "wiki/sources/doc.md",
    ])
    // caption ran on the full-pipeline path
    expect(mocks.captionMarkdownImages).toHaveBeenCalled()
    // log appended to existing
    const logWrite = writtenFiles().find(([p]) => p === `${PP}/wiki/log.md`)
    expect(logWrite![1]).toContain("## [2026-06-01] ingest | other")
    expect(logWrite![1]).toContain("## [2026-07-01] ingest | doc")
    // merge called for the existing entity page (with the real buildPageMerger fn)
    const mergeCalls = mocks.mergePageContent.mock.calls as Array<
      [string, string | null, unknown, Record<string, unknown>]
    >
    // 1st: alpha is a new page (existing null); 2nd: beta merges existing
    expect(mergeCalls[0][0]).toBe("# Alpha\nBody text.")
    expect(mergeCalls[0][1]).toBeNull()
    expect(mergeCalls[1][0]).toBe("# Beta\nNew beta body.")
    expect(mergeCalls[1][1]).toBe("---\ntype: entity\n---\n# Beta\nOld body")
    expect(mergeCalls[1][3]).toEqual(
      expect.objectContaining({ sourceFileName: "doc.pdf", pagePath: "wiki/entities/beta.md" }),
    )
    // cache saved with the ORIGINAL source content
    expect(mocks.saveIngestCache).toHaveBeenCalledWith(
      PP,
      "doc.pdf",
      "Source body ![](P:/proj/wiki/media/doc/img.png)",
      result,
    )
    // file tree refreshed
    expect(mocks.listDirectory).toHaveBeenCalledWith(PP)
    expect((mocks.wikiGetState() as FakeWiki).setFileTree).toHaveBeenCalledWith([])
    expect((mocks.wikiGetState() as FakeWiki).bumpDataVersion).toHaveBeenCalled()
    // review items surfaced
    const review = mocks.reviewGetState() as { addItems: ReturnType<typeof vi.fn> }
    expect(review.addItems).toHaveBeenCalledTimes(1)
    const items = review.addItems.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(items[0].type).toBe("contradiction")
    expect(items[0].title).toBe("Conflict found")
    expect(items[0].description).toBe("There is a conflict.")
    expect(items[0].options).toEqual([
      { label: "Create Page", action: "Create Page" },
      { label: "Skip", action: "Skip" },
    ])
    expect(items[0].affectedPages).toEqual(["wiki/concepts/alpha.md"])
    expect(items[0].searchQueries).toEqual(["q1", "q2"])
    expect(items[0].sourcePath).toBe(SP)
    // final activity state
    const activity = mocks.activityGetState() as FakeActivity
    expect(activity.items[0].status).toBe("done")
    expect(activity.items[0].detail).toContain("filesWrittenWithReview")
    expect(activity.items[0].filesWritten).toEqual(result)
  })

  it("strips image references from source content when multimodal is disabled", async () => {
    installReads(defaultReads())
    const activity = installActivityState()
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])

    await autoIngest(PP, SP, LLM)

    const analysisCall = mocks.streamChat.mock.calls[0]
    const userMsg = (analysisCall[1] as Array<{ role: string; content: string }>)[1]
    expect(userMsg.content).not.toContain("![](")
    expect(activity.items[0].status).toBe("done")
  })

  it("skips captioning when there are no images", async () => {
    installReads(defaultReads())
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    await autoIngest(PP, SP, LLM)

    expect(mocks.captionMarkdownImages).not.toHaveBeenCalled()
  })

  it("skips captioning when source content has no image refs", async () => {
    installReads(defaultReads({ [SP]: "plain text, no images" }))
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    await autoIngest(PP, SP, LLM)

    expect(mocks.captionMarkdownImages).not.toHaveBeenCalled()
  })

  it("swallows caption failures in the full pipeline (Error)", async () => {
    installReads(defaultReads())
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    mocks.captionMarkdownImages.mockRejectedValue(new Error("caption boom"))
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result.length).toBeGreaterThan(0)
    expect(console.warn).toHaveBeenCalled()
  })

  it("swallows caption failures in the full pipeline (string)", async () => {
    installReads(defaultReads())
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    mocks.captionMarkdownImages.mockRejectedValue("caption boom (string)")
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result.length).toBeGreaterThan(0)
    expect(console.warn).toHaveBeenCalled()
  })

  it("truncates source content past 50000 chars for the LLM prompts", async () => {
    const longSource = "x".repeat(50001)
    installReads(defaultReads({ [SP]: longSource }))
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    await autoIngest(PP, SP, LLM)

    const analysisCall = mocks.streamChat.mock.calls[0]
    const systemMsg = (analysisCall[1] as Array<{ role: string; content: string }>)[0]
    expect(systemMsg.content).toContain("[...truncated...]")
  })

  it("throws when the analysis stream errors (detail surfaced)", async () => {
    installReads(defaultReads())
    installStreamChat([streamError(new Error("boom https://x.com/auth Bearer sekret"))])

    await expect(autoIngest(PP, SP, LLM)).rejects.toThrow("activity.ingest.analysisFailed")
    const activity = mocks.activityGetState() as FakeActivity
    const detail = activity.items[0].detail as string
    expect(detail).toContain("[url]")
    expect(detail).toContain("[redacted]")
  })

  it("handles non-Error analysis stream failures", async () => {
    installReads(defaultReads())
    installStreamChat([streamError("plain analysis failure")])

    await expect(autoIngest(PP, SP, LLM)).rejects.toThrow("activity.ingest.analysisFailed")
  })

  it("throws a generic message when analysis detail is empty", async () => {
    installReads(defaultReads())
    mocks.t.mockImplementation((key: string) => (key === "activity.ingest.analysisFailed" ? "" : key))
    installStreamChat([streamError(new Error("boom"))])

    await expect(autoIngest(PP, SP, LLM)).rejects.toThrow("Analysis stream failed")
  })

  it("throws when the generation stream errors", async () => {
    installReads(defaultReads())
    mocks.t.mockImplementation((key: string) => (key === "activity.ingest.generationFailed" ? "" : key))
    installStreamChat([streamSuccess(["analysis"]), streamError(new Error("gen boom"))])

    await expect(autoIngest(PP, SP, LLM)).rejects.toThrow("Generation stream failed")
  })

  it("handles non-Error generation stream failures", async () => {
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamError("plain gen failure")])

    await expect(autoIngest(PP, SP, LLM)).rejects.toThrow("activity.ingest.generationFailed")
  })

  it("writes a fallback source-summary page when the LLM omitted it", async () => {
    const generation = fileBlock("wiki/concepts/alpha.md", "# Alpha\nBody.\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis text"]), streamSuccess([generation])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/concepts/alpha.md", "wiki/sources/doc.md"])
    const fallback = writtenFiles().find(([p]) => p === `${PP}/wiki/sources/doc.md`)
    expect(fallback).toBeDefined()
    expect(fallback![1]).toContain("# Source: doc.pdf")
    expect(fallback![1]).toContain("analysis text")
  })

  it("uses the analysisNotAvailable i18n key when analysis is empty", async () => {
    const generation = fileBlock("wiki/concepts/alpha.md", "# Alpha\nBody.\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess([]), streamSuccess([generation])])

    await autoIngest(PP, SP, LLM)

    const fallback = writtenFiles().find(([p]) => p === `${PP}/wiki/sources/doc.md`)
    expect(fallback![1]).toContain("activity.ingest.analysisNotAvailable")
  })

  it("skips the fallback write when the signal is aborted", async () => {
    const generation = fileBlock("wiki/concepts/alpha.md", "# Alpha\nBody.\n")
    installReads(defaultReads())
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([generation])])
    const controller = new AbortController()
    controller.abort()

    const result = await autoIngest(PP, SP, LLM, controller.signal)

    expect(result).toEqual(["wiki/concepts/alpha.md"])
    expect(writtenFiles().some(([p]) => p.endsWith("wiki/sources/doc.md"))).toBe(false)
  })

  it("reports noFilesGenerated when the LLM emits no FILE blocks (aborted)", async () => {
    const generation = reviewBlock("suggestion", "Maybe", "research more")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([generation])])
    const controller = new AbortController()
    controller.abort()

    const result = await autoIngest(PP, SP, LLM, controller.signal)

    expect(result).toEqual([])
    const activity = mocks.activityGetState() as FakeActivity
    expect(activity.items[0].status).toBe("error")
    expect(activity.items[0].detail).toContain("noFilesGenerated")
    expect(mocks.saveIngestCache).not.toHaveBeenCalled()
    // review blocks are still surfaced even when no files were written
    const review = mocks.reviewGetState() as { addItems: ReturnType<typeof vi.fn> }
    expect(review.addItems).toHaveBeenCalledTimes(1)
  })

  it("skips the cache when any block hits a hard FS failure", async () => {
    installReads(defaultReads())
    mocks.writeFile.mockImplementation((path: string) =>
      path.includes("wiki/concepts/alpha.md")
        ? Promise.reject("disk full (string)")
        : Promise.resolve(undefined),
    )
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).not.toContain("wiki/concepts/alpha.md")
    expect(mocks.saveIngestCache).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
  })

  it("treats a failed page merge as a hard failure (onError path)", async () => {
    installReads(
      defaultReads({ [`${PP}/wiki/entities/beta.md`]: "---\ntype: entity\n---\nOld" }),
    )
    installStreamChat([
      streamSuccess(["analysis"]),
      streamSuccess([GENERATION]),
      (h) => h.onError?.(new Error("merge onError")),
    ])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).not.toContain("wiki/entities/beta.md")
    expect(mocks.saveIngestCache).not.toHaveBeenCalled()
  })

  it("treats a failed page merge as a hard failure (rejection, Error)", async () => {
    installReads(
      defaultReads({ [`${PP}/wiki/entities/beta.md`]: "---\ntype: entity\n---\nOld" }),
    )
    installStreamChat([
      streamSuccess(["analysis"]),
      streamSuccess([GENERATION]),
      streamReject(new Error("merge failed")),
    ])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).not.toContain("wiki/entities/beta.md")
    expect(mocks.saveIngestCache).not.toHaveBeenCalled()
  })

  it("treats a failed page merge as a hard failure (rejection, string)", async () => {
    installReads(
      defaultReads({ [`${PP}/wiki/entities/beta.md`]: "---\ntype: entity\n---\nOld" }),
    )
    installStreamChat([
      streamSuccess(["analysis"]),
      streamSuccess([GENERATION]),
      streamReject("merge failed (string)"),
    ])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).not.toContain("wiki/entities/beta.md")
    expect(mocks.saveIngestCache).not.toHaveBeenCalled()
  })

  it("overwrites index / overview listing pages wholesale", async () => {
    const gen = [
      fileBlock("wiki/index.md", "# Index\nA.\n"),
      fileBlock("wiki/sub/index.md", "# Sub Index\nB.\n"),
      fileBlock("wiki/overview.md", "# Overview\nC.\n"),
      fileBlock("wiki/sub/overview.md", "# Sub Overview\nD.\n"),
      fileBlock("wiki/sources/doc.md", "# Source: doc.pdf\nSummary.\n"),
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([gen])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual([
      "wiki/index.md",
      "wiki/sub/index.md",
      "wiki/overview.md",
      "wiki/sub/overview.md",
      "wiki/sources/doc.md",
    ])
    // only the sources content page goes through the merge path (new page)
    expect(mocks.mergePageContent).toHaveBeenCalledTimes(1)
    expect(mocks.mergePageContent.mock.calls[0][1]).toBeNull()
    const writes = writtenFiles()
    expect(writes.find(([p]) => p === `${PP}/wiki/index.md`)![1]).toBe("# Index\nA.")
    expect(writes.find(([p]) => p === `${PP}/wiki/overview.md`)![1]).toBe("# Overview\nC.")
  })

  it("ignores listDirectory failures", async () => {
    installReads(defaultReads())
    mocks.listDirectory.mockRejectedValue(new Error("ls boom"))
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result.length).toBeGreaterThan(0)
    expect((mocks.wikiGetState() as FakeWiki).setFileTree).not.toHaveBeenCalled()
  })

  it("parses REVIEW blocks with unknown types, defaults and empty search segments", async () => {
    const generation = [
      fileBlock("wiki/concepts/alpha.md", "# Alpha\nBody.\n"),
      reviewBlock("mystery-type", "Unknown", "Just prose, no option lines\nSEARCH: q1 |  | q2"),
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([generation])])

    await autoIngest(PP, SP, LLM)

    const review = mocks.reviewGetState() as { addItems: ReturnType<typeof vi.fn> }
    const items = review.addItems.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(items[0].type).toBe("confirm")
    expect(items[0].options).toEqual([
      { label: "Approve", action: "Approve" },
      { label: "Skip", action: "Skip" },
    ])
    expect(items[0].affectedPages).toBeUndefined()
    expect(items[0].searchQueries).toEqual(["q1", "q2"])
    expect(items[0].description).toBe("Just prose, no option lines")
  })

  it("surfaces write warnings in the activity panel (single / multi-count variants)", async () => {
    const warnCases = [
      "---FILE: wiki/a.md---\npartial", // 1 warning
    ]
    const genA = fileBlock("wiki/concepts/alpha.md", "# Alpha\nBody.\n") + "\n\n" + warnCases[0]
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([genA])])

    await autoIngest(PP, SP, LLM)

    const activity = mocks.activityGetState() as FakeActivity
    const details = activity.updateItem.mock.calls
      .map((c) => (c[1] as Record<string, unknown>).detail as string)
      .filter((d) => typeof d === "string")
    expect(details.some((d) => d.includes("未闭合"))).toBe(true)
  })

  it("summarizes 3+ warnings with a console pointer", async () => {
    // warnings accumulate from: unsafe-path drops + a trailing unclosed block
    const gen = [
      fileBlock("../../../etc/passwd", "X"),
      fileBlock("wiki/../escape.md", "X"),
      fileBlock("wiki/concepts/alpha.md", "# Alpha\nBody.\n"),
      "---FILE: wiki/z.md---\npartial",
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([gen])])

    await autoIngest(PP, SP, LLM)

    const activity = mocks.activityGetState() as FakeActivity
    const details = activity.updateItem.mock.calls
      .map((c) => (c[1] as Record<string, unknown>).detail as string)
      .filter((d) => typeof d === "string")
    expect(details.some((d) => d.includes("条提取警告") && d.includes("(+1 条更多见控制台)"))).toBe(true)
  })

  it("omits the +N pointer for exactly two warnings", async () => {
    const gen = [
      fileBlock("../../../etc/passwd", "X"),
      fileBlock("wiki/concepts/alpha.md", "# Alpha\nBody.\n"),
      "---FILE: wiki/z.md---\npartial",
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([gen])])

    await autoIngest(PP, SP, LLM)

    const activity = mocks.activityGetState() as FakeActivity
    const details = activity.updateItem.mock.calls
      .map((c) => (c[1] as Record<string, unknown>).detail as string)
      .filter((d) => typeof d === "string")
    const summary = details.find((d) => d.includes("条提取警告"))
    expect(summary).toBeDefined()
    expect(summary).not.toContain("(+")
  })

  it("includes folder context in the analysis prompt when provided", async () => {
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    await autoIngest(PP, SP, LLM, undefined, "papers/energy")

    const analysisCall = mocks.streamChat.mock.calls[0]
    const userMsg = (analysisCall[1] as Array<{ role: string; content: string }>)[1]
    expect(userMsg.content).toContain("**Folder context:** papers/energy")
  })

  it("runs the language guard: drops mismatched concept pages", async () => {
    installWikiState({ outputLanguage: "Chinese" })
    mocks.detectLanguage.mockReturnValue("English")
    const gen = [
      fileBlock("wiki/concepts/alpha.md", "English body text here for detection.\n"),
      fileBlock("wiki/sources/doc.md", "# Source: doc.pdf\nSummary.\n"),
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([gen])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
    expect(console.warn).toHaveBeenCalled()
  })

  it("language guard: keeps matching CJK content and skips log/entity/source pages", async () => {
    installWikiState({ outputLanguage: "Chinese" })
    mocks.detectLanguage.mockReturnValue("Chinese")
    const gen = [
      fileBlock("wiki/concepts/alpha.md", "中文正文内容，用于语言检测，这里足够长了。\n"),
      fileBlock("wiki/log.md", "## [2026-07-01] ingest | doc"),
      fileBlock("wiki/entities/foo.md", "English proper nouns are fine here.\n"),
      fileBlock("wiki/sources/doc.md", "English summary ok.\n"),
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([gen])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual([
      "wiki/concepts/alpha.md",
      "wiki/log.md",
      "wiki/entities/foo.md",
      "wiki/sources/doc.md",
    ])
    expect(mocks.saveIngestCache).toHaveBeenCalled()
  })

  it("language guard: frontmatter is stripped before detection (closed and unclosed)", async () => {
    installWikiState({ outputLanguage: "Chinese" })
    mocks.detectLanguage.mockReturnValue("Chinese")
    const gen = [
      fileBlock("wiki/concepts/a.md", "---\ntitle: x\n---\n中文正文内容，用于语言检测，这里足够长了。\n"),
      fileBlock("wiki/concepts/b.md", "---\nnever closes, but long enough to reach detection\n"),
      fileBlock("wiki/concepts/c.md", "short"),
      fileBlock("wiki/sources/doc.md", "# Source: doc.pdf\nSummary.\n"),
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([gen])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual([
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
      "wiki/concepts/c.md",
      "wiki/sources/doc.md",
    ])
    // a + b reach detection; c is too short and short-circuits
    expect(mocks.detectLanguage).toHaveBeenCalledTimes(2)
  })

  it("language guard: Arabic target accepts only Arabic", async () => {
    installWikiState({ outputLanguage: "Arabic" })
    mocks.detectLanguage.mockReturnValueOnce("Arabic").mockReturnValueOnce("English")
    const gen = [
      fileBlock("wiki/concepts/ok.md", "نص عربي طويل بما يكفي للكشف.\n"),
      fileBlock("wiki/concepts/bad.md", "English text that must be dropped here.\n"),
      fileBlock("wiki/sources/doc.md", "# Source: doc.pdf\nSummary.\n"),
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([gen])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/concepts/ok.md", "wiki/sources/doc.md"])
  })

  it("language guard: non-Latin detected content is checked via script family", async () => {
    installWikiState({ outputLanguage: "English" })
    mocks.detectLanguage.mockReturnValue("Arabic")
    mocks.sameScriptFamily.mockReturnValue(true)
    const gen = [
      fileBlock("wiki/concepts/ok.md", "Some Arabic-script content of sufficient length.\n"),
      fileBlock("wiki/sources/doc.md", "# Source: doc.pdf\nSummary.\n"),
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([gen])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/concepts/ok.md", "wiki/sources/doc.md"])
    expect(mocks.sameScriptFamily).toHaveBeenCalledWith("English", "Arabic")
  })

  it("language guard: drops non-Latin content whose script family mismatches", async () => {
    installWikiState({ outputLanguage: "English" })
    mocks.detectLanguage.mockReturnValue("Arabic")
    mocks.sameScriptFamily.mockReturnValue(false)
    const gen = [
      fileBlock("wiki/concepts/bad.md", "Some Arabic-script content of sufficient length.\n"),
      fileBlock("wiki/sources/doc.md", "# Source: doc.pdf\nSummary.\n"),
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([gen])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
  })

  it("language guard: CJK-detected content is dropped for a Latin target", async () => {
    installWikiState({ outputLanguage: "English" })
    mocks.detectLanguage.mockReturnValue("Chinese")
    const gen = [
      fileBlock("wiki/concepts/bad.md", "中文正文内容，用于语言检测，这是足够长的内容。\n"),
      fileBlock("wiki/sources/doc.md", "# Source: doc.pdf\nSummary.\n"),
    ].join("\n\n")
    installReads(defaultReads())
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([gen])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual(["wiki/sources/doc.md"])
  })

  it("embeds written pages when embedding is enabled (skips index/log/overview)", async () => {
    installReads(
      defaultReads({
        [`${PP}/wiki/concepts/alpha.md`]: "---\ntitle: Alpha Title\n---\nBody",
        [`${PP}/wiki/entities/beta.md`]: "no frontmatter",
      }),
    )
    installWikiState({
      embeddingConfig: { enabled: true, endpoint: "e", apiKey: "", model: "m" },
    })
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result).toEqual([
      "wiki/concepts/alpha.md",
      "wiki/entities/beta.md",
      "wiki/log.md",
      "wiki/sources/doc.md",
    ])
    // alpha + beta embedded (title from frontmatter / pageId fallback)
    expect(mocks.embedPage).toHaveBeenCalledWith(
      PP,
      "alpha",
      "Alpha Title",
      "---\ntitle: Alpha Title\n---\nBody",
      expect.objectContaining({ model: "m" }),
    )
    expect(mocks.embedPage).toHaveBeenCalledWith(
      PP,
      "beta",
      "beta",
      "no frontmatter",
      expect.objectContaining({ model: "m" }),
    )
  })

  it("per-page embedding failures are non-fatal", async () => {
    installReads(defaultReads({ [`${PP}/wiki/concepts/alpha.md`]: new Error("gone") }))
    installWikiState({
      embeddingConfig: { enabled: true, endpoint: "e", apiKey: "", model: "m" },
    })
    mocks.embedPage.mockRejectedValue(new Error("embed boom"))
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result.length).toBeGreaterThan(0)
    expect(mocks.saveIngestCache).toHaveBeenCalled()
  })

  it("swallows embedding module load failure", async () => {
    failEmbeddingModule = true
    installReads(defaultReads())
    installWikiState({
      embeddingConfig: { enabled: true, endpoint: "e", apiKey: "", model: "m" },
    })
    installStreamChat([streamSuccess(["analysis"]), streamSuccess([GENERATION])])

    const result = await autoIngest(PP, SP, LLM)

    expect(result.length).toBeGreaterThan(0)
    expect(mocks.embedPage).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// startIngest
// ────────────────────────────────────────────────────────────────────────────

describe("startIngest", () => {
  it("prepares the chat store and streams the analysis", async () => {
    const chat = installChatState()
    installReads(defaultReads({ [`${PP}/schema.md`]: new Error("missing") }))
    installStreamChat([streamSuccess(["hello", " world"])])

    await startIngest(PP, SP, LLM)

    expect(chat.setMode).toHaveBeenCalledWith("ingest")
    expect(chat.setIngestSource).toHaveBeenCalledWith(SP)
    expect(chat.clearMessages).toHaveBeenCalled()
    expect(chat.startStreaming).toHaveBeenCalledWith("conv-1")
    expect(chat.appendStreamToken).toHaveBeenCalledWith("hello", "conv-1")
    expect(chat.appendStreamToken).toHaveBeenCalledWith(" world", "conv-1")
    expect(chat.finalizeStream).toHaveBeenCalledWith("hello world")
    expect(chat.messages.some((m) => m.role === "user")).toBe(true)
  })

  it("skips streaming state when there is no active conversation", async () => {
    const chat = installChatState()
    chat.activeConversationId = null
    installReads(defaultReads())
    installStreamChat([streamSuccess(["tok"])])

    await startIngest(PP, SP, LLM)

    expect(chat.clearStreaming).not.toHaveBeenCalled()
    expect(chat.startStreaming).not.toHaveBeenCalled()
    expect(chat.appendStreamToken).not.toHaveBeenCalled()
    expect(chat.finalizeStream).toHaveBeenCalledWith("tok")
  })

  it("finalizes the stream with a redacted error message on failure", async () => {
    const chat = installChatState()
    installReads(defaultReads())
    installStreamChat([streamError(new Error("boom https://api.example.com/v1 Bearer abc123"))])

    await startIngest(PP, SP, LLM)

    const [content] = chat.finalizeStream.mock.calls[0] as [string]
    expect(content).toContain("[url]")
    expect(content).toContain("[redacted]")
    expect(content).not.toContain("Bearer abc123")
  })

  it("handles non-Error stream failures", async () => {
    const chat = installChatState()
    installReads(defaultReads())
    installStreamChat([streamError("plain string failure")])

    await startIngest(PP, SP, LLM)

    const [content] = chat.finalizeStream.mock.calls[0] as [string]
    expect(content).toContain("plain string failure")
  })

  it("pre-extraction failures are non-fatal (Error)", async () => {
    installReads(defaultReads())
    mocks.extractAndSaveSourceImages.mockRejectedValue(new Error("extract boom"))
    installStreamChat([streamSuccess(["ok"])])

    await startIngest(PP, SP, LLM)

    expect(console.warn).toHaveBeenCalled()
  })

  it("pre-extraction failures are non-fatal (string)", async () => {
    installReads(defaultReads())
    mocks.extractAndSaveSourceImages.mockRejectedValue("extract boom (string)")
    installStreamChat([streamSuccess(["ok"])])

    await startIngest(PP, SP, LLM)

    expect(console.warn).toHaveBeenCalled()
  })

  it("uses wiki purpose/schema in the system prompt and handles empty source/index", async () => {
    installReads(
      defaultReads({
        [SP]: new Error("missing source"),
        [`${PP}/wiki/schema.md`]: "wiki schema",
        [`${PP}/wiki/purpose.md`]: "wiki purpose",
        [`${PP}/wiki/index.md`]: new Error("missing index"),
      }),
    )
    installStreamChat([streamSuccess(["ok"])])

    await startIngest(PP, SP, LLM)

    const call = mocks.streamChat.mock.calls[0]
    const systemMsg = (call[1] as Array<{ role: string; content: string }>)[0].content
    expect(systemMsg).toContain("## Wiki Purpose")
    expect(systemMsg).toContain("wiki purpose")
    expect(systemMsg).toContain("## Wiki Schema")
    expect(systemMsg).toContain("wiki schema")
    expect(systemMsg).not.toContain("## Current Wiki Index")
    const userMsg = (call[1] as Array<{ role: string; content: string }>)[1].content
    expect(userMsg).toContain("(empty file)")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// executeIngestWrites
// ────────────────────────────────────────────────────────────────────────────

describe("executeIngestWrites", () => {
  const blocksText = [
    fileBlock("wiki/log.md", "## [2026-07-01] ingest | doc"),
    fileBlock("wiki/concepts/alpha.md", "# Alpha\nBody.\n"),
  ].join("\n\n")

  it("writes parsed blocks and announces them in chat", async () => {
    const chat = installChatState()
    chat.messages.push(
      { role: "system", content: "sys-ignored" },
      { role: "user", content: "my question" },
      { role: "assistant", content: "some answer" },
    )
    chat.ingestSource = SP
    installReads(defaultReads({ [`${PP}/wiki/log.md`]: "## [2026-06-01] ingest | other" }))
    installStreamChat([streamSuccess([blocksText])])

    const result = await executeIngestWrites(PP, LLM)

    expect(result).toEqual([`${PP}/wiki/log.md`, `${PP}/wiki/concepts/alpha.md`])
    const logWrite = writtenFiles().find(([p]) => p === `${PP}/wiki/log.md`)
    expect(logWrite![1]).toContain("## [2026-06-01] ingest | other")
    expect(chat.startStreaming).toHaveBeenCalledWith("conv-1")
    expect(chat.finalizeStream).toHaveBeenCalledWith(blocksText)
    expect(chat.messages.some((m) => m.role === "system" && m.content.includes("已写入知识库文件"))).toBe(true)
  })

  it("honors user guidance and skips streaming without a conversation", async () => {
    const chat = installChatState()
    chat.activeConversationId = null
    chat.messages.push({ role: "user", content: "discussion" })
    installReads(defaultReads())
    installStreamChat([streamSuccess([blocksText])])

    await executeIngestWrites(PP, LLM, "focus on concepts")

    expect(chat.startStreaming).not.toHaveBeenCalled()
    const writePrompt = chat.addMessage.mock.calls.find(
      (c) => (c[0] as string) === "user",
    )?.[1] as string
    expect(writePrompt).toContain("focus on concepts")
  })

  it("keeps going when a write fails and reports the failure (Error)", async () => {
    const chat = installChatState()
    chat.ingestSource = null
    installReads(defaultReads())
    mocks.writeFile.mockRejectedValue(new Error("write boom"))
    installStreamChat([streamSuccess([blocksText])])

    const result = await executeIngestWrites(PP, LLM)

    expect(result).toEqual([])
    expect(console.error).toHaveBeenCalled()
    expect(chat.messages.some((m) => m.content.includes("未写入任何文件"))).toBe(true)
  })

  it("keeps going when a write fails and reports the failure (string)", async () => {
    const chat = installChatState()
    chat.ingestSource = null
    installReads(defaultReads())
    mocks.writeFile.mockRejectedValue("write boom (string)")
    installStreamChat([streamSuccess([blocksText])])

    const result = await executeIngestWrites(PP, LLM)

    expect(result).toEqual([])
    expect(console.error).toHaveBeenCalled()
    expect(chat.messages.some((m) => m.content.includes("未写入任何文件"))).toBe(true)
  })

  it("reports when the LLM emitted no valid blocks", async () => {
    const chat = installChatState()
    installReads(defaultReads())
    installStreamChat([streamSuccess(["no blocks here"])])

    const result = await executeIngestWrites(PP, LLM)

    expect(result).toEqual([])
    expect(chat.messages.some((m) => m.content.includes("未写入任何文件"))).toBe(true)
  })

  it("surfaces parse warnings as system messages", async () => {
    const chat = installChatState()
    installReads(defaultReads())
    installStreamChat([streamSuccess(["---FILE: wiki/a.md---\npartial"])])

    await executeIngestWrites(PP, LLM)

    expect(chat.messages.some((m) => m.role === "system" && m.content.includes("未闭合"))).toBe(true)
  })

  it("injects extracted images into the source summary when enabled", async () => {
    const chat = installChatState()
    chat.ingestSource = SP
    installReads(defaultReads())
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.extractAndSaveSourceImages.mockResolvedValue([IMAGE as never])
    installStreamChat([streamSuccess([blocksText])])

    await executeIngestWrites(PP, LLM)

    const writes = writtenFiles()
    expect(writes.some(([p]) => p === `${PP}/wiki/sources/doc.md`)).toBe(true)
  })

  it("skips the image cascade without an ingest source or with multimodal off", async () => {
    const chat = installChatState()
    installReads(defaultReads())
    installStreamChat([streamSuccess([blocksText])])

    await executeIngestWrites(PP, LLM)

    expect(mocks.extractAndSaveSourceImages).not.toHaveBeenCalled()
    expect(chat.messages.some((m) => m.content.includes("已写入知识库文件"))).toBe(true)
  })

  it("skips injection when extraction returns no images", async () => {
    const chat = installChatState()
    chat.ingestSource = SP
    installReads(defaultReads())
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.extractAndSaveSourceImages.mockResolvedValue([])
    installStreamChat([streamSuccess([blocksText])])

    await executeIngestWrites(PP, LLM)

    expect(mocks.buildImageMarkdownSection).not.toHaveBeenCalled()
  })

  it("swallows cascade extraction failures (Error)", async () => {
    const chat = installChatState()
    chat.ingestSource = SP
    installReads(defaultReads())
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.extractAndSaveSourceImages.mockRejectedValue(new Error("extract boom"))
    installStreamChat([streamSuccess([blocksText])])

    await executeIngestWrites(PP, LLM)

    expect(console.warn).toHaveBeenCalled()
    expect(chat.messages.some((m) => m.content.includes("已写入知识库文件"))).toBe(true)
  })

  it("swallows cascade extraction failures (string)", async () => {
    const chat = installChatState()
    chat.ingestSource = SP
    installReads(defaultReads())
    installWikiState({ multimodalConfig: { ...makeWikiState().multimodalConfig, enabled: true } })
    mocks.extractAndSaveSourceImages.mockRejectedValue("extract boom (string)")
    installStreamChat([streamSuccess([blocksText])])

    await executeIngestWrites(PP, LLM)

    expect(console.warn).toHaveBeenCalled()
    expect(chat.messages.some((m) => m.content.includes("已写入知识库文件"))).toBe(true)
  })

  it("finalizes the stream with a redacted error on failure", async () => {
    const chat = installChatState()
    installReads(defaultReads())
    installStreamChat([streamError(new Error("boom https://x.com Bearer tok"))])

    await executeIngestWrites(PP, LLM)

    const [content] = chat.finalizeStream.mock.calls[0] as [string]
    expect(content).toContain("[url]")
    expect(content).toContain("[redacted]")
  })

  it("handles non-Error stream failures", async () => {
    const chat = installChatState()
    installReads(defaultReads())
    installStreamChat([streamError("plain string failure")])

    await executeIngestWrites(PP, LLM)

    const [content] = chat.finalizeStream.mock.calls[0] as [string]
    expect(content).toContain("plain string failure")
  })

  it("uses wiki schema in prompts and tolerates a missing index", async () => {
    installReads(
      defaultReads({
        [`${PP}/wiki/schema.md`]: "wiki schema",
        [`${PP}/wiki/index.md`]: new Error("missing index"),
      }),
    )
    installStreamChat([streamSuccess([blocksText])])

    await executeIngestWrites(PP, LLM)

    const call = mocks.streamChat.mock.calls[0]
    const systemMsg = (call[1] as Array<{ role: string; content: string }>)[0].content
    expect(systemMsg).toContain("## Wiki Schema")
    expect(systemMsg).not.toContain("## Current Wiki Index")
    const userMsgs = call[1] as Array<{ role: string; content: string }>
    const writePrompt = userMsgs[userMsgs.length - 1].content
    expect(writePrompt).toContain("## Wiki Schema")
    expect(writePrompt).not.toContain("## Current Wiki Index")
  })
})
