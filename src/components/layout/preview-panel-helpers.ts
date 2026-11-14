import { fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { parseChapterMeta } from "@/lib/novel"
import { parseFrontmatter } from "@/lib/frontmatter"
import { formatChapterWriting } from "@/lib/chapter-formatting"
import { makeChapterFileName } from "@/lib/wiki-filename"
import type { FileNode } from "@/types/wiki"

export function inferEditorMode(path: string): "read" | "edit" {
  const normalized = path.replace(/\\/g, "/")
  // QM 为当前知识根，wiki 为 legacy——两者都进编辑模式
  if (
    normalized.includes("/QM/chapters/") || normalized.includes("/wiki/chapters/") ||
    normalized.includes("/QM/outlines/") || normalized.includes("/wiki/outlines/")
  ) {
    return "edit"
  }
  return "read"
}

// 选中文本去AI味/AI润色入口：组件级 deadline（统一约束 HTTP 与 Claude-CLI 通道，
// 并截断 5 分钟网络重试）。不改动 llm-client.ts 的全局 30 分钟默认值。
export const DE_AI_SELECTION_TIMEOUT_MS = 90_000

// 区分「模型全程零输出（疑似网络黑洞/冷启动失败）」与「部分生成后超时」的中文报错。
export function selectionTimeoutMessage(label: string, gotAnyToken: boolean): string {
  if (gotAnyToken) {
    return `${label}生成超时：已收到部分内容但 90 秒内未完成。请缩短选中文本或更换更快的模型后重试。`
  }
  return `${label}超时：模型在 90 秒内未返回任何内容，可能网络不通或代理不可达（本地代理 127.0.0.1:8756 未响应）、模型服务不可用或冷启动失败。请检查网络与模型设置后重试。`
}

export function isChapterPath(path: string): boolean {
  const n = path.replace(/\\/g, "/")
  return n.includes("/wiki/chapters/") || n.includes("/QM/chapters/")
}

export function isOutlinePath(path: string): boolean {
  const n = path.replace(/\\/g, "/")
  return n.includes("/wiki/outlines/") || n.includes("/QM/outlines/")
}

export function getDirName(path: string): string {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf("/")
  /* v8 ignore start */
  return index >= 0 ? normalized.slice(0, index) : ""
  /* v8 ignore stop */
}

export async function getUniqueSiblingPath(dir: string, fileName: string, currentPath: string): Promise<string> {
  const firstPath = `${dir}/${fileName}`
  if (firstPath === currentPath || !(await fileExists(firstPath))) return firstPath
  const extensionIndex = fileName.lastIndexOf(".")
  /* v8 ignore start */
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
  /* v8 ignore stop */
  /* v8 ignore start */
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : ""
  /* v8 ignore stop */
  for (let i = 2; i <= 99; i++) {
    const candidate = `${dir}/${stem}-${i}${extension}`
    if (candidate === currentPath || !(await fileExists(candidate))) return candidate
  }
  return `${dir}/${stem}-${Date.now()}${extension}`
}

export async function getCanonicalChapterPath(currentPath: string, markdown: string, chapterNumber: number | null): Promise<string> {
  const { frontmatter, body } = parseFrontmatter(markdown)
  const title = typeof (frontmatter as Record<string, unknown> | null)?.title === "string"
    ? String((frontmatter as Record<string, unknown>).title).trim()
    : body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ""
  if (!title) return currentPath
  return getUniqueSiblingPath(getDirName(currentPath), makeChapterFileName(title, chapterNumber), currentPath)
}

export function extractChapterNumberFromMarkdown(markdown: string): number | null {
  const { frontmatter } = parseFrontmatter(markdown)
  if (!frontmatter || typeof frontmatter !== "object") return null
  return parseChapterMeta(frontmatter as Record<string, unknown>)?.chapterNumber ?? null
}

export function formatWritingBodyWithIndent(markdown: string): string {
  return formatChapterWriting(markdown)
  /*
  const lines = body.split("\n")
  let inFence = false
  const formatted = lines.map((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    if (!trimmed) return line
    if (/^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|\|)/.test(trimmed)) return line
    if (/^\s*[-]{3,}\s*$/.test(trimmed)) return line
    if (/^\s*[　 ]{2}/.test(line)) return line
    return `　　${line}`
  })
  return rawBlock + formatted.join("\n")
  */
}

export function normalizeChapterWriting(markdown: string): string {
  return formatWritingBodyWithIndent(syncChapterFrontmatterTitle(markdown))
}

export function updateChapterHeading(markdown: string, nextTitle: string): string {
  const { rawBlock, body } = parseFrontmatter(markdown)
  const normalizedTitle = nextTitle.trim()
  const bodyWithoutHeading = body.replace(/^#\s+.+$(\r?\n)?/m, "").replace(/^\n+/, "")
  /* v8 ignore start */
  const nextBody = normalizedTitle
    ? `# ${normalizedTitle}${bodyWithoutHeading ? `\n\n${bodyWithoutHeading}` : "\n"}`
    : bodyWithoutHeading
  /* v8 ignore stop */
  return rawBlock + nextBody
}

export function syncChapterFrontmatterTitle(markdown: string): string {
  const { rawBlock, body, frontmatter } = parseFrontmatter(markdown)
  if (!rawBlock || !frontmatter) return markdown
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (!heading) return markdown
  const fmTitle = typeof (frontmatter as Record<string, unknown>).title === "string"
    ? String((frontmatter as Record<string, unknown>).title).trim()
    : ""
  if (!fmTitle || fmTitle === heading) return markdown
  const escaped = heading.replace(/"/g, '\\"')
  const nextRaw = rawBlock.replace(/^title:\s*.*$/m, `title: "${escaped}"`)
  return nextRaw + body
}

export function getChapterTitleFromPath(path: string): string {
  /* v8 ignore next */
  const fileName = normalizePath(path).split("/").pop() ?? ""
  return fileName.replace(/\.md$/i, "").trim()
}

export const CHAPTER_TITLE_MIN_WIDTH_PX = 48

/** 文件树 → 章节快捷入口（展示层只读投影：按章号倒序，最多 6 条）。 */
export function chapterOrderFromFileName(name: string): number {
  const match = name.match(/(\d{1,4})/)
  return match ? Number(match[1]) : 0
}

export function collectRecentChapterFiles(nodes: FileNode[]): { path: string; label: string; order: number }[] {
  const out: { path: string; label: string; order: number }[] = []
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.is_dir) {
        if (node.children) walk(node.children)
        continue
      }
      if (!/\.md$/i.test(node.name)) continue
      if (!isChapterPath(node.path)) continue
      out.push({ path: node.path, label: getChapterTitleFromPath(node.path), order: chapterOrderFromFileName(node.name) })
    }
  }
  walk(nodes)
  return out.sort((a, b) => b.order - a.order).slice(0, 6)
}
export const CHAPTER_TITLE_RESTING_EXTRA_WIDTH_PX = 2
export const CHAPTER_TITLE_EDITING_EXTRA_WIDTH_PX = 16

/* ------------------------------------------------------------------------- *
 * 编辑区统一写入协议（G2 统一写入门）—— 纯瞬时协调层
 *
 * 只协调「意图 / 实际 I/O 准入 / 采纳栅栏 / lease 归属」这四件瞬时事实：
 * - 意图（ChapterWriteIntent）在任何 await 之前捕获，只取一个逻辑序号，不占 I/O 尾链；
 *   未完成的评审/路径解析因此永远不会进入别人必须等待的尾链。
 * - 实际 mutation（admitMutation）先同步登记受影响路径组的真实前驱，再执行；同目标的
 *   后续 mutation 等的是这一整条 FIFO 尾链，而不是「最后一笔」单槽。
 * - 已开始的真实 I/O 不可取消：栅栏只拦「尚未准入」的旧意图，已准入者先落定。
 * - 采纳（beginAdoption）推进该目标栅栏并独占 lease；比较的是「意图序号 vs 最近采纳序号」，
 *   所以采纳解锁之后迟到的旧意图仍然被拒绝。
 *
 * 本层不持有正文/标题/草稿/状态权威：正文与标题快照仍由 PreviewPanel 与采纳调用方持有；
 * 只有「UI 已不在场时不得丢稿」所需的恢复登记是这里的瞬时条目（永不自动回写正式文件）。
 * ------------------------------------------------------------------------- */

/** 编辑区自己的全部写者（都必须经过同一个准入入口）。 */
export const CHAPTER_WRITE_KINDS = [
  "debounce-save",
  "leave-flush",
  "title",
  "format",
  "final-save",
  "de-ai-draft",
] as const

export type ChapterWriteKind = (typeof CHAPTER_WRITE_KINDS)[number]

/** 一次写入意图：必须在任何 await 之前捕获。 */
export interface ChapterWriteIntent {
  /** 单调逻辑序号：只用于比较「本意图开始之后是否发生过采纳」。 */
  readonly id: number
  readonly kind: ChapterWriteKind
  /** 发起时的请求路径（解析后的实际目标另算受影响路径组）。 */
  readonly requestedPath: string
}

export interface ChapterWriteFenceRefusal {
  readonly path: string
  readonly adoptionSeq: number
  readonly leased: boolean
}

/** 一次已准入的实际 mutation（受影响路径组 + 该组唯一的新 barrier）。 */
export interface ChapterWriteAdmission<T> {
  readonly kind: "admitted"
  readonly paths: readonly string[]
  /** 实际 mutation 的结果；业务错误按原样向上传递。 */
  readonly result: Promise<T>
  /** 仅表示 continuation 已释放（永不 reject），让后继 mutation 继续。 */
  readonly barrier: Promise<void>
  /** 这些路径上是否仍是最后一笔：提交后动作 / ingest 的归属校验用。 */
  isCurrent(): boolean
}

export type ChapterWriteAdmissionResult<T> =
  | ChapterWriteAdmission<T>
  | { readonly kind: "fenced"; readonly refusals: readonly ChapterWriteFenceRefusal[] }

/** 采纳 lease：按 owner 归属，只有持有者（或同 owner 的清理）能释放。 */
export interface ChapterAdoptionLease {
  readonly id: number
  readonly path: string
  readonly owner: object
}

export interface ChapterTargetRelocation {
  readonly fromPath: string
  readonly toPath: string
  readonly intentId: number
  /** 新路径写入已完成、旧路径 delete 已发出；不把 throw 当作「零 I/O」。 */
  readonly deleteIssued: true
}

export interface ChapterAdoptionBegin {
  readonly ok: true
  readonly fenceSeq: number
  readonly lease: ChapterAdoptionLease | null
  /** 受理本 begin 之前已准入的全部真实 I/O（不含未完成的评审/解析）。 */
  readonly admittedTail: Promise<void>
}

/** 仅内部编排错误，不新增 novel/draft/ingest 状态。 */
export class ChapterAdoptionUnavailableError extends Error {
  constructor(readonly reason: "cancelled" | "relocated", readonly relocation: ChapterTargetRelocation | null = null) {
    super(reason === "relocated"
      ? "已确认章节在等待旧写入时发生路径迁移，请重新确认采纳目标"
      : "编辑区已离开：本次采纳尚未写入，请重新确认后再试")
  }
}

export type ChapterAdoptionBeginResult =
  | ChapterAdoptionBegin
  | { readonly ok: false; readonly reason: "busy" }

/** UI 不在场时保留的未存输入归属（永不自动回写正式文件）。 */
export interface ChapterWriteRecovery {
  readonly path: string
  /** 标题失败可以只恢复标题，不拿旧正文覆盖后来读到的正文。 */
  readonly buffer?: string
  readonly titleDraft: string
  readonly titleEditing: boolean
  readonly message?: string
  readonly adoptionId?: number
  /** 正式采纳已落盘，但旧输入要等权威读成功后才消费。 */
  readonly adoptionCommitted?: boolean
  /** 显式迁移的原归属，只搬恢复输入，不用它重定向 confirmed accept。 */
  readonly originalPath?: string
}

export interface ChapterWriteCoordinator {
  captureIntent(kind: ChapterWriteKind, requestedPath: string): ChapterWriteIntent
  admitMutation<T>(
    intent: ChapterWriteIntent,
    affectedPaths: readonly string[],
    run: () => Promise<T>,
  ): ChapterWriteAdmissionResult<T>
  beginAdoption(
    targetPath: string,
    owner: object,
    options?: { exclusive?: boolean },
  ): ChapterAdoptionBeginResult
  /** confirmed accept 本身也登记到同一目标尾链，不随 UI 卸载取消在途 I/O。 */
  runAdoption<T>(lease: ChapterAdoptionLease, run: () => Promise<T>): Promise<T>
  /** 实际 accept 或匹配的旧成功令牌确认本 lease，读失败仍保留快照。 */
  markAdoptionCommitted(lease: ChapterAdoptionLease): void
  /** 权威读与安装 refs 同属本 lease；卸载只能移交观察，不能提前释放在途读。 */
  runAdoptionReload<T>(lease: ChapterAdoptionLease, run: () => Promise<T>): Promise<T>
  adoptionSettled(lease: ChapterAdoptionLease): Promise<void>
  /** 只查这一份恢复输入的归属（包括已登记的实际迁移），不重定向采纳参数。 */
  recoveryForAdoption(lease: ChapterAdoptionLease): ChapterWriteRecovery | null
  relocationSinceBegin(lease: ChapterAdoptionLease): ChapterTargetRelocation | null
  noteRelocation(intent: ChapterWriteIntent, fromPath: string, toPath: string): void
  tailOf(path: string): Promise<void>
  subscribe(path: string, listener: (event: "lease" | "recovery" | "release") => void): () => void
  releaseAdoption(lease: ChapterAdoptionLease): boolean
  releaseOwnedAdoptions(owner: object): number
  leaseOf(path: string): ChapterAdoptionLease | null
  isFenced(path: string): boolean
  retainRecovery(entry: ChapterWriteRecovery): void
  peekRecovery(path: string): ChapterWriteRecovery | null
  dropRecovery(path: string): void
}

interface ChapterWriteTargetState {
  /** 该目标全部已准入 mutation 的 FIFO 尾链（永不 reject）。 */
  tail: Promise<void>
  /** 最近一次采纳受理序号；比较对象是「意图捕获序号」。 */
  adoptionSeq: number
  lease: ChapterAdoptionLease | null
  /** 单次实际迁移事实；不是永久 alias 链，也不是路径解析权威。 */
  relocation: ChapterTargetRelocation | null
}

interface ChapterAdoptionLifetime {
  phase: "preparing" | "writing" | "settled"
  relocationAtBegin: ChapterTargetRelocation | null
  settled: Promise<void>
  resolve: () => void
  releaseAfterIo: boolean
  pendingReloads: number
}

const RESOLVED_TAIL: Promise<void> = Promise.resolve()

export function createChapterWriteCoordinator(): ChapterWriteCoordinator {
  let sequence = 0
  const targets = new Map<string, ChapterWriteTargetState>()
  const recoveries = new Map<string, ChapterWriteRecovery>()
  const lifetimes = new WeakMap<ChapterAdoptionLease, ChapterAdoptionLifetime>()
  const listeners = new Map<string, Set<(event: "lease" | "recovery" | "release") => void>>()

  const keyOf = (path: string) => normalizePath(path)
  const notify = (path: string, event: "lease" | "recovery" | "release") => {
    for (const listener of listeners.get(keyOf(path)) ?? []) listener(event)
  }

  function stateOf(path: string): ChapterWriteTargetState {
    const key = keyOf(path)
    const existing = targets.get(key)
    if (existing) return existing
    const created: ChapterWriteTargetState = { tail: RESOLVED_TAIL, adoptionSeq: 0, lease: null, relocation: null }
    targets.set(key, created)
    return created
  }

  function captureIntent(kind: ChapterWriteKind, requestedPath: string): ChapterWriteIntent {
    sequence += 1
    return { id: sequence, kind, requestedPath: keyOf(requestedPath) }
  }

  function admitMutation<T>(
    intent: ChapterWriteIntent,
    affectedPaths: readonly string[],
    run: () => Promise<T>,
  ): ChapterWriteAdmissionResult<T> {
    const paths = Array.from(new Set(affectedPaths.map(keyOf)))
    const refusals: ChapterWriteFenceRefusal[] = []
    for (const path of paths) {
      const state = stateOf(path)
      if (state.lease) {
        refusals.push({ path, adoptionSeq: state.adoptionSeq, leased: true })
        continue
      }
      // 采纳发生在意图捕获之后 ⇒ 旧意图不得再准入（采纳解锁后依然成立）。
      if (state.adoptionSeq > intent.id) {
        refusals.push({ path, adoptionSeq: state.adoptionSeq, leased: false })
      }
    }
    if (refusals.length > 0) return { kind: "fenced", refusals }

    // 同一同步段：先捕获整组真实前驱，再给整组登记同一个新 barrier（无 await、无自等）。
    const predecessor = Promise.all(paths.map((path) => stateOf(path).tail))
    const result = predecessor.then(() => run())
    const barrier = result.then(
      () => undefined,
      () => undefined,
    )
    for (const path of paths) stateOf(path).tail = barrier
    return {
      kind: "admitted",
      paths,
      result,
      barrier,
      isCurrent: () => paths.every((path) => {
        const state = stateOf(path)
        return state.tail === barrier && state.adoptionSeq <= intent.id && state.lease === null
      }),
    }
  }

  function beginAdoption(
    targetPath: string,
    owner: object,
    options?: { exclusive?: boolean },
  ): ChapterAdoptionBeginResult {
    const path = keyOf(targetPath)
    const state = stateOf(path)
    // 同目标只允许一个采纳 lease：并发采纳如实拒绝，不排队、不静默合并。
    if (state.lease) return { ok: false, reason: "busy" }
    sequence += 1
    const fenceSeq = sequence
    state.adoptionSeq = fenceSeq
    const admittedTail = state.tail
    const exclusive = options?.exclusive ?? true
    const lease: ChapterAdoptionLease | null = exclusive ? { id: fenceSeq, path, owner } : null
    if (lease) {
      let resolve!: () => void
      const settled = new Promise<void>((done) => { resolve = done })
      lifetimes.set(lease, { phase: "preparing", relocationAtBegin: state.relocation, settled, resolve, releaseAfterIo: false, pendingReloads: 0 })
      state.lease = lease
      const recovery = peekRecovery(path)
      // 无 UI 的新采纳也接手快照，不能借上次成功标记消费本次失败的输入。
      if (recovery) retainRecovery({ ...recovery, adoptionId: lease.id, adoptionCommitted: false })
      notify(path, "lease")
    }
    return { ok: true, fenceSeq, lease, admittedTail }
  }

  function relocationSinceBegin(lease: ChapterAdoptionLease): ChapterTargetRelocation | null {
    const lifetime = lifetimes.get(lease)
    const relocation = stateOf(lease.path).relocation
    return lifetime && relocation !== lifetime.relocationAtBegin ? relocation : null
  }

  function markAdoptionCommitted(lease: ChapterAdoptionLease): void {
    if (stateOf(lease.path).lease !== lease) return
    const recovery = peekRecovery(lease.path)
    if (recovery?.adoptionId === lease.id) retainRecovery({ ...recovery, adoptionCommitted: true })
  }

  function runAdoption<T>(lease: ChapterAdoptionLease, run: () => Promise<T>): Promise<T> {
    const state = stateOf(lease.path)
    const lifetime = lifetimes.get(lease)
    if (state.lease !== lease || !lifetime || lifetime.phase !== "preparing") {
      return Promise.reject(new ChapterAdoptionUnavailableError("cancelled"))
    }
    // 同步准入 confirmed accept：沿用该目标真实前驱，不嵌套等自己的 barrier。
    lifetime.phase = "writing"
    const result = state.tail.then(() => {
      const relocation = relocationSinceBegin(lease)
      if (relocation) throw new ChapterAdoptionUnavailableError("relocated", relocation)
      return run()
    })
    const finish = () => {
      lifetime.phase = "settled"
      lifetime.resolve()
      // 新挂载的观察者正在等本 I/O：由它的真实读/refs 安装终结 lease。
      // 无 UI 则在 I/O 落定后释放；不猜测超时，也不等 ingest/onAdopted。
      if (lifetime.releaseAfterIo && lifetime.pendingReloads === 0 && !listeners.has(lease.path)) {
        releaseAdoption(lease)
      }
    }
    state.tail = result.then(
      () => {
        // 写成功不等于读回成功：跨卸载保留输入，权威读安装后再消费旧正文。
        markAdoptionCommitted(lease)
        finish()
      },
      () => { finish() },
    )
    return result // 业务错误保持 reject，不能用 continuation barrier 吞掉它。
  }

  function runAdoptionReload<T>(lease: ChapterAdoptionLease, run: () => Promise<T>): Promise<T> {
    const lifetime = lifetimes.get(lease)
    if (stateOf(lease.path).lease !== lease || !lifetime) {
      return Promise.reject(new ChapterAdoptionUnavailableError("cancelled"))
    }
    lifetime.pendingReloads += 1
    return Promise.resolve().then(run).finally(() => {
      lifetime.pendingReloads -= 1
      if (lifetime.releaseAfterIo && lifetime.phase !== "writing" && lifetime.pendingReloads === 0) {
        releaseAdoption(lease)
      }
    })
  }

  function recoveryForAdoption(lease: ChapterAdoptionLease): ChapterWriteRecovery | null {
    for (const entry of recoveries.values()) {
      if (entry.adoptionId === lease.id) return entry
    }
    return recoveries.get(lease.path)
      ?? Array.from(recoveries.values()).find((entry) => entry.originalPath === lease.path)
      ?? null
  }

  function adoptionSettled(lease: ChapterAdoptionLease): Promise<void> {
    return lifetimes.get(lease)?.settled ?? RESOLVED_TAIL
  }

  function noteRelocation(intent: ChapterWriteIntent, fromPath: string, toPath: string): void {
    const from = keyOf(fromPath)
    const to = keyOf(toPath)
    if (from === to) return
    stateOf(from).relocation = { fromPath: from, toPath: to, intentId: intent.id, deleteIssued: true }
    // 只移动这一笔已发出的 canonical 迁移的恢复归属；不合并 alias 或 accept 参数。
    const recovery = recoveries.get(from)
    if (recovery && !recoveries.has(to)) {
      recoveries.delete(from)
      retainRecovery({ ...recovery, path: to, originalPath: recovery.originalPath ?? from })
    }
  }

  function tailOf(path: string): Promise<void> {
    return stateOf(path).tail
  }

  function subscribe(path: string, listener: (event: "lease" | "recovery" | "release") => void): () => void {
    const key = keyOf(path)
    const group = listeners.get(key) ?? new Set()
    group.add(listener)
    listeners.set(key, group)
    return () => {
      group.delete(listener)
      if (group.size === 0) {
        listeners.delete(key)
        const lease = stateOf(key).lease
        const lifetime = lease ? lifetimes.get(lease) : undefined
        if (lease && lifetime?.releaseAfterIo && lifetime.phase !== "writing" && lifetime.pendingReloads === 0) {
          releaseAdoption(lease)
        }
      }
    }
  }

  function releaseAdoption(lease: ChapterAdoptionLease): boolean {
    const state = stateOf(lease.path)
    // 身份校验：旧 cleanup / 旧结果不能释放新一代 lease。
    if (state.lease !== lease) return false
    const lifetime = lifetimes.get(lease)
    if (lifetime && (lifetime.phase === "writing" || lifetime.pendingReloads > 0)) {
      // UI 离开只是结束观察，不能取消已准入 accept/read 或提前解锁它。
      lifetime.releaseAfterIo = true
      return false
    }
    state.lease = null
    if (lifetime) {
      lifetime.phase = "settled"
      lifetime.resolve()
    }
    notify(lease.path, "release")
    return true
  }

  function releaseOwnedAdoptions(owner: object): number {
    let released = 0
    for (const state of targets.values()) {
      if (state.lease?.owner === owner && releaseAdoption(state.lease)) released += 1
    }
    return released
  }

  function leaseOf(path: string): ChapterAdoptionLease | null {
    return stateOf(path).lease
  }

  function isFenced(path: string): boolean {
    const state = stateOf(path)
    return state.lease !== null
  }

  function retainRecovery(entry: ChapterWriteRecovery): void {
    recoveries.set(keyOf(entry.path), { ...entry, path: keyOf(entry.path) })
    notify(entry.path, "recovery")
  }

  function peekRecovery(path: string): ChapterWriteRecovery | null {
    return recoveries.get(keyOf(path)) ?? null
  }

  function dropRecovery(path: string): void {
    recoveries.delete(keyOf(path))
  }

  return {
    captureIntent,
    admitMutation,
    beginAdoption,
    runAdoption,
    markAdoptionCommitted,
    runAdoptionReload,
    adoptionSettled,
    recoveryForAdoption,
    relocationSinceBegin,
    noteRelocation,
    tailOf,
    subscribe,
    releaseAdoption,
    releaseOwnedAdoptions,
    leaseOf,
    isFenced,
    retainRecovery,
    peekRecovery,
    dropRecovery,
  }
}

/** 仅在权威读成功且 refs 已安装后消费已确认采纳的旧正文；raw 标题仍属用户。 */
export function settleChapterAdoptionRecoveryAfterRead(coordinator: ChapterWriteCoordinator, path: string): void {
  const recovery = coordinator.peekRecovery(path)
  if (!recovery?.adoptionCommitted) return
  if (recovery.titleEditing) {
    coordinator.retainRecovery({
      ...recovery,
      buffer: undefined,
      adoptionCommitted: false,
      message: "章节采纳已读回；未提交标题已保留，请检查后继续编辑或保存。",
    })
  } else coordinator.dropRecovery(path)
}

/** 只消费这笔已写正文；更新的脏输入或采纳快照、未提交标题仍归原输入所有。 */
export function settleChapterRecoveryBodyWrite(
  coordinator: ChapterWriteCoordinator,
  intent: ChapterWriteIntent,
  path: string,
  persistedMarkdown: string,
): void {
  const recovery = coordinator.peekRecovery(path)
  if (!recovery || (recovery.adoptionId ?? 0) > intent.id
    || (coordinator.leaseOf(recovery.originalPath ?? path)?.id ?? 0) > intent.id
    || (recovery.buffer !== undefined && normalizeChapterWriting(recovery.buffer) !== persistedMarkdown)) return
  if (recovery.titleEditing) {
    coordinator.retainRecovery({
      ...recovery,
      buffer: undefined,
      adoptionCommitted: false,
      message: "正文已保存；未提交标题已保留，请继续编辑或确认标题。",
    })
  } else coordinator.dropRecovery(path)
}

/** 同进程共享实例：两个互斥挂载点与布局切换后的新实例共用同一条尾链/栅栏。 */
let sharedChapterWriteCoordinator: ChapterWriteCoordinator | null = null

export function getChapterWriteCoordinator(): ChapterWriteCoordinator {
  if (!sharedChapterWriteCoordinator) {
    sharedChapterWriteCoordinator = createChapterWriteCoordinator()
  }
  return sharedChapterWriteCoordinator
}

/** 示意：仅供测试在同一进程内复位瞬时协调状态（不涉及任何内容权威）。 */
export function resetChapterWriteCoordinator(): void {
  sharedChapterWriteCoordinator = null
}
