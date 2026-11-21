/**
 * Rust ⇄ WebView 状态桥（方案 d23eb1df P0 只读 / P1 增加单键写入）。
 *
 * ## 为什么需要桥
 *
 * 两类事实只存在于 WebView：设置键在 `localStorage`，项目状态/章节正文走
 * `@/commands/fs` 与 `loadNovelSessionStatus`。MCP 服务端在 Rust 侧，所以必须有
 * 一次跨进程的请求/响应往返。
 *
 * **为什么不把这些逻辑搬到 Rust**：`status.json` 的读取链路（锁、降级、字段兼容）
 * 已经在 `novel-session-status.ts` 里写好了；章节文件读取走前端 fs 命令。在 Rust
 * 另写一份 JSON 解析与目录扫描就是第二套真源，迟早和既有链路不一致。
 *
 * ## 协议
 *
 * ```
 * Rust  --emit("mcp:state-request", {id, op, key?, path?, offset?, limit?})-->  WebView
 * Rust  <--invoke("mcp_state_respond", {id, ok, value, error})--  WebView
 * ```
 *
 * 用 `invoke` 回传而不是再 emit 一个事件：命令是有返回值的类型化调用，
 * 前端能感知 Rust 是否还在等，且不依赖事件监听器的注册顺序。
 *
 * ## 三类硬约束
 *
 * 1. **键白名单**。`get`/`list`/`set` 只放行 `settings-catalog.ts` 登记过的键。
 *    不做前缀匹配——前缀匹配会让桥变成「任意 localStorage 读写通道」。
 * 2. **异常必须回 error**。前端任何一步抛错都要回 `ok:false` + 错误信息，
 *    绝不静默丢弃——静默会让 Rust 侧只能靠超时兜底，把真实原因丢掉。
 * 3. **写入只对 `scope: "write"` 的键开放**，且必须经 `settings-writers.ts`
 *    注册的写入器（复用应用自己的 setter，保证界面即时刷新）。
 *    P0 的只读态可由服务端 scope 关掉整个 `settings.set` 工具恢复。
 *
 * 注意 `project` / `project-state` / `chapter-*` 是**不同形状**的请求（不是键值对），
 * 它们不参与键白名单；白名单语义只约束 `get`/`list`。
 *
 * P2 的四个 op 分两类，都只是**转发**：
 * - `pipeline-start` / `pipeline-status`：长任务登记（`pipeline-tasks.ts`）。前者立刻
 *   返回 taskId 不等待——深章管线跑几分钟，同步等必然撞上 15s 超时。
 * - `draft-write`：写章节草稿（`draft-actions.ts`）。正式正文与
 *   正式记忆一律不在此落盘，Draft-first 边界不因调用方是外部 Agent 而放松。
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

import { readFile } from "@/commands/fs"
import { listScopeFiles } from "@/lib/novel/agent-tools"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { upsertCharacterEntity } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"

import {
  SECRET_REF_CATEGORIES,
  SETTINGS_BY_KEY,
  SETTINGS_CATALOG,
  isBridgeAllowedKey,
} from "./settings-catalog"
import { SettingsValidationError, getWriter, validateValue } from "./settings-writers"
import { resolveFormalPath, writeChapterDraft } from "./draft-actions"
import { getPipelineTask, startDirectorAdvanceTask, startOutlineGenerationTask, startPipelineBatch, startPipelineTask } from "./pipeline-tasks"
import { inspectContext, sameInspectedChapter, type ContextInspectionRequest, type InspectedChapter } from "./context-inspection"

/** Rust → WebView 的请求事件名（与 Rust 侧 `state_bridge::REQUEST_EVENT` 必须一致）。 */
export const STATE_REQUEST_EVENT = "mcp:state-request"

/** 桥支持的操作。P0 只读 / P1 增单键写入 / P2 增项目动作 / P4 增一窗口全流程编排。 */
export type StateOp =
  | "get"
  | "list"
  | "schema"
  | "set"
  | "project"
  | "project-state"
  | "chapter-list"
  | "chapter-read"
  | "pipeline-start"
  | "pipeline-start-batch"
  | "pipeline-status"
  | "director-advance"
  | "outline-generate"
  | "character-upsert"
  | "draft-write"
  | "formal-path"
  | "context-inspect"
  | "context-inspect-start"
  | "context-inspect-poll"

export interface StateRequestPayload {
  id: string
  op: StateOp
  /** `get` 用。 */
  key?: string
  /** `chapter-read` 用：章节序号（1 起）或文件名。 */
  path?: string
  /** `chapter-read` 用：起始行（0 起）。 */
  offset?: number
  /** `chapter-read` 用：最多返回行数。 */
  limit?: number
  /** `set` 用：待写入的值（已由 Rust 侧透传的 JSON）。 */
  value?: unknown
  /** 项目动作用：原样透传的参数对象（各 op 自行校验，桥不解释）。 */
  params?: Record<string, unknown>
}

export interface StateResponse {
  ok: boolean
  value?: unknown
  error?: string
}

/** `chapter.read` 的默认返回行数上限：单章动辄上万字，不设限会撑爆 MCP 响应。 */
export const DEFAULT_CHAPTER_LIMIT = 200
/** `chapter.read` 的硬上限：客户端可以要更多，但不能无限。 */
export const MAX_CHAPTER_LIMIT = 2000

/**
 * 桥的依赖注入点。
 *
 * 抽出来是为了让 `handleStateRequest` 可以在没有 Tauri、没有真实项目目录的情况下
 * 被单测——否则这个模块只能靠端到端测，边界条件（未打开项目、章节越界、文件读失败）
 * 全都测不到。
 */
export interface StateBridgeDeps {
  readProjectPath: () => string
  loadStatus: (projectPath: string) => Promise<unknown>
  listChapters: (projectPath: string) => Promise<{ name: string; path: string }[]>
  readFileText: (path: string) => Promise<string>
  /** 读一个设置项的当前值（可写键走 store，其余走原始存储）。 */
  readSetting: (key: string) => unknown
  /** 写入一个设置项，返回落盘后的实际值（可能与传入不同，如钳制）。 */
  writeSetting: (key: string, value: unknown) => Promise<unknown>
  /** 起一个深章生成长任务，立刻返回 taskId。 */
  startPipeline: (params: Record<string, unknown>) => unknown
  /** 一次起多个深章任务（批量）；校验失败时不启动任何一个。 */
  startPipelineBatch: (params: Record<string, unknown>) => unknown
  /** 起一个导演阶段推进任务，立刻返回 taskId。 */
  startDirectorAdvance: (params: Record<string, unknown>) => unknown
  /** 起一个大纲生成任务，立刻返回 taskId。 */
  startOutlineGeneration: (params: Record<string, unknown>) => unknown
  /** 建/改一个角色实体（`wiki/entities/characters/*.md`）。 */
  upsertCharacter: (projectPath: string, params: Record<string, unknown>) => Promise<unknown>
  /** 查长任务快照；未知 id 返回 `null`。 */
  readPipeline: (taskId: string) => unknown
  /** 写章节草稿（Draft-first）。 */
  writeChapterDraft: (projectPath: string, params: Record<string, unknown>) => Promise<unknown>
  /**
   * 把「章节名 / 记忆名」解析成正式文件的**虚拟路径**。
   *
   * 只解析路径，不写文件：P3 的直写由 Rust 侧统一做（快照 → 写 → 审计），但
   * 「正式章节落在哪」这个知识只能有一份，它在前端（`formalChapterPathForDraft`
   * 与 `wiki/memory`）。Rust 再把它映射成物理路径，映射规则也只有一份。
   */
  resolveFormalPath: (projectPath: string, params: Record<string, unknown>) => unknown
  /**
   * 只读上下文回读（`context.inspect`）：生效配置 + 选定章来源/窗口/哈希，
   * 默认 0 次 pack 构建。项目/章节解析留在本模块（复用既有 `chapter-list`
   * 语义），构建与配置投影在 `context-inspection.ts`。
   */
  inspectContext: (request: ContextInspectionRequest) => Promise<unknown>
}

const defaultDeps: StateBridgeDeps = {
  readProjectPath: () => useWikiStore.getState().project?.path ?? "",
  loadStatus: (projectPath) => loadNovelSessionStatus(projectPath),
  listChapters: (projectPath) => listScopeFiles(projectPath, "chapters"),
  readFileText: (path) => readFile(path),
  readSetting: (key) => {
    const writer = getWriter(key)
    if (writer) return writer.read()
    const entry = SETTINGS_BY_KEY.get(key)
    return entry?.storage === "localStorage" ? readLocalStorage(key) : null
  },
  startPipeline: (params) => startPipelineTask(params),
  startPipelineBatch: (params) => startPipelineBatch(params),
  startDirectorAdvance: (params) => startDirectorAdvanceTask(params),
  startOutlineGeneration: (params) => startOutlineGenerationTask(params),
  upsertCharacter: (projectPath, params) => upsertCharacterEntityFromParams(projectPath, params),
  readPipeline: (taskId) => getPipelineTask(taskId),
  writeChapterDraft: (projectPath, params) => writeChapterDraft(projectPath, params),
  resolveFormalPath: (projectPath, params) => resolveFormalPath(projectPath, params),
  inspectContext: (request) => inspectContext(request),
  writeSetting: (key, value) => {
    const writer = getWriter(key)
    if (!writer) {
      // catalog 标了 write 却没有写入器就是登记错误（settings-writers 加载时已自检）。
      throw new Error(`${key} 没有注册写入器，拒绝写入`)
    }
    return writer.write(value)
  },
}

/**
 * 建/改一个角色实体。
 *
 * 落盘格式由 `upsertCharacterEntity` 单点持有（导演 `character` 阶段走同一个函数），
 * 这里只做参数校验与字段提取。
 */
async function upsertCharacterEntityFromParams(
  projectPath: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const read = (field: string): string => {
    const raw = params[field]
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`character.upsert 需要非空字符串参数 ${field}`)
    }
    return raw.trim()
  }
  const role = read("role")
  if (role !== "protagonist" && role !== "antagonist" && role !== "supporting") {
    throw new Error(`character.upsert 的 role 只接受 protagonist / antagonist / supporting，收到 ${role}`)
  }
  const entry = { name: read("name"), role, desire: read("desire"), flaw: read("flaw") }
  const path = await upsertCharacterEntity(projectPath, entry)
  return { name: entry.name, role: entry.role, path }
}

/** 读取单个 localStorage 键的原始值（不存在返回 null）。 */
function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    // 隐私模式 / 存储被禁用时会抛。如实报错，不伪装成 null（"未设置"与"读不到"不同）。
    throw new Error(`localStorage 不可读（键 ${key}）`)
  }
}

/** 取当前项目路径；未打开项目时抛出明确错误（不返回空字符串让上层自己猜）。 */
function requireProjectPath(deps: StateBridgeDeps): string {
  const path = deps.readProjectPath()
  if (!path || path.trim() === "") {
    throw new Error("未打开项目：请先在应用中打开一个项目")
  }
  return path
}

/**
 * 从文件名提取章号：`chapter-001.md` → 1，`第170章-新灵气契约.md` → 170。
 *
 * 真实项目（172 章）混用两套命名：既有一百多个 `chapter-NNN.md`，又有
 * `第170章-*.md`。单纯调 `localeCompare` 不够——实测 WebView2 的默认 locale
 * 把「第170章」排在 `chapter-001.md` **前面**（数字序和普通序都一样），
 * 于是 `chapter.read(1)` 读到的不是第 1 章。按文件名里的数字排才对得上
 * 界面上「第1章…第2章…」的顺序。
 */
function chapterOrderKey(name: string): number {
  const match = /(\d+)/.exec(name)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

/** 章节名排序：先按文件名里的章号，同号再按名称。 */
function compareChapterName(a: string, b: string): number {
  const diff = chapterOrderKey(a) - chapterOrderKey(b)
  if (diff !== 0) return diff
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}

/**
 * 把章节标识解析成文件。
 *
 * 支持两种写法：1 起的序号（`chapter.read(3)`）与文件名（`chapter-003.md`）。
 * 序号按文件名排序后取第 n 个——排序是必须的，目录枚举顺序不保证稳定。
 */
function resolveChapter(
  chapters: { name: string; path: string }[],
  selector: string,
): { name: string; path: string } {
  const trimmed = selector.trim()
  if (trimmed === "") {
    throw new Error("chapter.read 需要章节序号或文件名")
  }
  const sorted = [...chapters].sort((a, b) => compareChapterName(a.name, b.name))
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed)
    if (index < 1 || index > sorted.length) {
      throw new Error(
        `章节序号越界：${index}（当前共 ${sorted.length} 章）`,
      )
    }
    return sorted[index - 1]
  }
  const byName = sorted.find((c) => c.name === trimmed || c.path.endsWith(`/${trimmed}`))
  if (!byName) {
    throw new Error(`找不到章节文件：${trimmed}`)
  }
  return byName
}

/**
 * 把章节标识解析成**精确条目**（`context-inspect` 用）。
 *
 * 复用 [`resolveChapter`] 的既有语义（1 起序号 / 文件名），只是额外带上序号与
 * 章号：`context.inspect` 需要它们作为检索章节号与默认 task，且绝不允许调用方
 * 传任意文件路径。条目形状由 `context-inspection.ts` 持有（`InspectedChapter`），
 * 这里只负责生产它，不另建一份形状。
 */
export function selectChapter(
  chapters: { name: string; path: string }[],
  selector: string,
): InspectedChapter {
  const sorted = [...chapters].sort((a, b) => compareChapterName(a.name, b.name))
  const entry = resolveChapter(sorted, selector)
  const index = sorted.findIndex((c) => c.path === entry.path && c.name === entry.name)
  const ordinal = index >= 0 ? index + 1 : 1
  const number = chapterOrderKey(entry.name)
  return {
    index: ordinal,
    number: Number.isFinite(number) && number !== Number.MAX_SAFE_INTEGER ? number : ordinal,
    name: entry.name,
    path: entry.path,
  }
}

/** 按行切片，返回内容与是否被截断。 */
function sliceLines(
  content: string,
  offset: number,
  limit: number,
): { text: string; totalLines: number; truncated: boolean } {
  const lines = content.split(/\r?\n/)
  const start = Math.max(0, Math.min(offset, lines.length))
  const end = Math.min(lines.length, start + limit)
  return {
    text: lines.slice(start, end).join("\n"),
    totalLines: lines.length,
    truncated: end < lines.length,
  }
}

const MAX_INSPECT_JOBS = 16

type InspectJobEntry =
  | { status: "running"; startedAt: number }
  | { status: "done"; startedAt: number; finishedAt: number; value: unknown }
  | { status: "failed"; startedAt: number; finishedAt: number; error: string }

const inspectJobs = new Map<string, InspectJobEntry>()
let inspectJobSeq = 0

function nextInspectJobId(): string {
  inspectJobSeq += 1
  return `cinspect_${Date.now().toString(36)}_${inspectJobSeq.toString(36)}`
}

function pruneInspectJobsIfNeeded(): void {
  if (inspectJobs.size <= MAX_INSPECT_JOBS) return
  const finished = [...inspectJobs.entries()]
    .filter((entry): entry is [string, Extract<InspectJobEntry, { status: "done" | "failed" }>] => entry[1].status !== "running")
    .sort((a, b) => a[1].finishedAt - b[1].finishedAt)
  for (const [id] of finished) {
    if (inspectJobs.size <= MAX_INSPECT_JOBS) break
    inspectJobs.delete(id)
  }
}

async function prepareContextInspect(
  payload: StateRequestPayload,
  deps: StateBridgeDeps,
): Promise<{
  projectPath: string
  chapter: InspectedChapter
  params: Record<string, unknown>
  recheckChapter: () => Promise<void>
}> {
  const projectPath = requireProjectPath(deps)
  const params = payload.params ?? {}
  const selector = typeof params.chapter === "string" ? params.chapter : ""
  if (selector.trim() === "") {
    throw new Error("context-inspect 需要 params.chapter（章节序号或文件名）")
  }
  const chapters = await deps.listChapters(projectPath)
  if (chapters.length === 0) {
    throw new Error(`项目下没有章节文件：${projectPath}/wiki/chapters`)
  }
  const chapter = selectChapter(chapters, selector)
  // 构建可能持续数秒：期间项目被切换或章节集合变化（插入/删除/改名）
  // 都会让「这份回读」指向另一个目标，必须显式拒绝而不是返回混合快照。
  //
  // 该复查必须作为**内部异步回调**交给门面，而不是在 `inspectContext`
  // 返回之后再做：它内部还要读一次章节目录，那个 await 若留在外面，就会
  // 越过门面的正文 / 完整配置终检，那段窗口里的漂移会被漏报成稳定成功。
  // 分工不变：桥独占目录读取与章身份（listChapters / selectChapter /
  // 四元组比对），门面独占正文与完整配置终检。
  const recheckChapter = async (): Promise<void> => {
    if (deps.readProjectPath() !== projectPath) {
      throw new Error("context-inspect 拒绝：项目在回读期间发生变化，请重跑")
    }
    const after = await deps.listChapters(projectPath)
    // 最后的目录读取也会 await；该期间切换项目仍须拒绝。
    if (deps.readProjectPath() !== projectPath) {
      throw new Error("context-inspect 拒绝：项目在回读期间发生变化，请重跑")
    }
    let recheck: InspectedChapter
    try {
      recheck = selectChapter(after, selector)
    } catch {
      throw new Error("context-inspect 拒绝：章节在回读期间发生变化，请重跑")
    }
    if (!sameInspectedChapter(recheck, chapter)) {
      throw new Error(
        `context-inspect 拒绝：章节在回读期间发生变化（${chapter.name}, index=${chapter.index}, number=${chapter.number} → ${recheck.name}, index=${recheck.index}, number=${recheck.number}），请重跑`,
      )
    }
  }
  return { projectPath, chapter, params, recheckChapter }
}

/**
 * 处理一条桥请求。除 `handleStateRequest` 的同步分支外全部只读。
 *
 * @throws 不会抛出——所有异常都转成 `{ok:false, error}`。
 */
export async function handleStateRequest(
  payload: StateRequestPayload,
  deps: StateBridgeDeps = defaultDeps,
): Promise<StateResponse> {
  try {
    if (!payload || typeof payload.id !== "string" || payload.id.length === 0) {
      return { ok: false, error: "请求缺少 id" }
    }

    switch (payload.op) {
      case "schema":
        return { ok: true, value: SETTINGS_CATALOG }

      case "list": {
        const entries = SETTINGS_CATALOG.map((entry) => ({
          key: entry.key,
          storage: entry.storage,
          scope: entry.scope,
          value: deps.readSetting(entry.key),
        }))
        return { ok: true, value: entries }
      }

      case "set": {
        const key = payload.key
        if (!key) {
          return { ok: false, error: "op=set 需要 key" }
        }
        // 凭据类永不经桥写入（C-009）。它们本来就不在 catalog 里，这里单独拦一道
        // 是为了给出**说清原因**的错误，而不是笼统的「键未登记」。
        if (SECRET_REF_CATEGORIES.some((c) => c.key === key)) {
          return {
            ok: false,
            error: `凭据类设置不允许外部写入（C-009）：${key}。请在应用界面内修改。`,
          }
        }
        const entry = SETTINGS_BY_KEY.get(key)
        if (!entry) {
          return { ok: false, error: `键未登记，拒绝访问: ${key}` }
        }
        if (entry.scope !== "write") {
          return { ok: false, error: `${key} 是只读键，不允许写入` }
        }
        if (payload.value === undefined) {
          return { ok: false, error: "op=set 需要 value" }
        }
        try {
          validateValue(entry, payload.value)
        } catch (e) {
          // 校验失败是**调用方错误**，不是内部异常：原样把原因回上去。
          if (e instanceof SettingsValidationError) {
            return { ok: false, error: e.message }
          }
          throw e
        }
        const before = deps.readSetting(key)
        const after = await deps.writeSetting(key, payload.value)
        return { ok: true, value: { key, storage: entry.storage, before, after } }
      }

      case "get": {
        const key = payload.key
        if (!key) {
          return { ok: false, error: "op=get 需要 key" }
        }
        if (!isBridgeAllowedKey(key)) {
          return { ok: false, error: `键未登记，拒绝访问: ${key}` }
        }
        const entry = SETTINGS_BY_KEY.get(key)
        if (!entry) {
          // 理论上不可达（isBridgeAllowedKey 已查过），保留以便白名单实现变更时不静默。
          return { ok: false, error: `键未登记，拒绝访问: ${key}` }
        }
        return {
          ok: true,
          value: {
            key: entry.key,
            storage: entry.storage,
            scope: entry.scope,
            value: deps.readSetting(entry.key),
          },
        }
      }

      case "project": {
        const projectPath = requireProjectPath(deps)
        return { ok: true, value: { projectPath } }
      }

      case "project-state": {
        const projectPath = requireProjectPath(deps)
        // status.json 尚未生成时 `loadNovelSessionStatus` 返回 null（既有降级语义）。
        // 这是「项目已打开但还没开始写作」，与「未打开项目」是两件事，不能混报错。
        const status = await deps.loadStatus(projectPath)
        return { ok: true, value: { projectPath, status } }
      }

      case "chapter-list": {
        const projectPath = requireProjectPath(deps)
        const chapters = await deps.listChapters(projectPath)
        const sorted = [...chapters].sort((a, b) => compareChapterName(a.name, b.name))
        return {
          ok: true,
          value: {
            projectPath,
            total: sorted.length,
            chapters: sorted.map((c, i) => ({ index: i + 1, name: c.name, path: c.path })),
          },
        }
      }

      case "chapter-read": {
        const projectPath = requireProjectPath(deps)
        const selector = payload.path
        if (!selector) {
          return { ok: false, error: "chapter-read 需要章节序号或文件名（path）" }
        }
        const chapters = await deps.listChapters(projectPath)
        if (chapters.length === 0) {
          return { ok: false, error: `项目下没有章节文件：${projectPath}/wiki/chapters` }
        }
        const chapter = resolveChapter(chapters, selector)
        const content = await deps.readFileText(chapter.path)
        const offset = Math.max(0, payload.offset ?? 0)
        const rawLimit = payload.limit ?? DEFAULT_CHAPTER_LIMIT
        const limit = Math.max(1, Math.min(MAX_CHAPTER_LIMIT, rawLimit))
        const sliced = sliceLines(content, offset, limit)
        return {
          ok: true,
          value: {
            projectPath,
            name: chapter.name,
            path: chapter.path,
            offset,
            limit,
            totalLines: sliced.totalLines,
            truncated: sliced.truncated,
            content: sliced.text,
          },
        }
      }

      case "pipeline-start": {
        // 不 requireProjectPath：起任务前要给出的错误比"未打开项目"更具体
        // （缺 userRequest / 缺模型配置），让 startPipeline 自己判。
        const params = payload.params ?? {}
        const started = deps.startPipeline(params) as
          | { ok: true; taskId: string; stage: string }
          | { ok: false; error: string }
        if (!started.ok) return { ok: false, error: started.error }
        return { ok: true, value: started }
      }

      case "pipeline-start-batch": {
        // 与单章同一条校验链：任何一章的配置/参数不过，整批都不启动。
        const params = payload.params ?? {}
        const started = deps.startPipelineBatch(params) as
          | { ok: true; tasks: unknown[]; started: number }
          | { ok: false; error: string }
        if (!started.ok) return { ok: false, error: started.error }
        return { ok: true, value: started }
      }

      case "director-advance": {
        const params = payload.params ?? {}
        const started = deps.startDirectorAdvance(params) as
          | { ok: true; taskId: string; stage: string }
          | { ok: false; error: string }
        if (!started.ok) return { ok: false, error: started.error }
        return { ok: true, value: started }
      }

      case "outline-generate": {
        const params = payload.params ?? {}
        const started = deps.startOutlineGeneration(params) as
          | { ok: true; taskId: string; stage: string }
          | { ok: false; error: string }
        if (!started.ok) return { ok: false, error: started.error }
        return { ok: true, value: started }
      }

      case "character-upsert": {
        const projectPath = requireProjectPath(deps)
        const written = await deps.upsertCharacter(projectPath, payload.params ?? {})
        return { ok: true, value: written }
      }

      case "pipeline-status": {
        const taskId = typeof payload.params?.taskId === "string" ? payload.params.taskId : ""
        if (!taskId) return { ok: false, error: "op=pipeline-status 需要 params.taskId" }
        const snapshot = deps.readPipeline(taskId)
        if (!snapshot) {
          return { ok: false, error: `未知 taskId: ${taskId}（任务不存在或已被清理）` }
        }
        return { ok: true, value: snapshot }
      }

      case "draft-write": {
        const projectPath = requireProjectPath(deps)
        const result = await deps.writeChapterDraft(projectPath, payload.params ?? {})
        return { ok: true, value: result }
      }

      case "formal-path": {
        const projectPath = requireProjectPath(deps)
        const kind = payload.params?.kind
        if (kind !== "chapter" && kind !== "memory") {
          return { ok: false, error: "op=formal-path 需要 params.kind = chapter | memory" }
        }
        return { ok: true, value: deps.resolveFormalPath(projectPath, payload.params ?? {}) }
      }

      case "context-inspect": {
        // 章节解析走既有 `chapter-list` 语义：只接受 1 起序号或精确文件名，
        // 不开放任意路径读取。参数（task/dimension/分页/开关）由
        // `context-inspection.ts` 自行校验，桥不解释。
        const prepared = await prepareContextInspect(payload, deps)
        // 拿到 value 之后不再追加目录 await：终检顺序统一由门面持有。
        const value = await deps.inspectContext(prepared)
        return { ok: true, value }
      }

      case "context-inspect-start": {
        // 慢链路（真实检索网络 / 大项目首次构建）可能超过状态桥 15s 兜底；
        // 先同步校验项目与章身份，再登记异步任务立即返回 jobId 供 Rust 轮询。
        const prepared = await prepareContextInspect(payload, deps)
        const jobId = nextInspectJobId()
        const startedAt = Date.now()
        inspectJobs.set(jobId, { status: "running", startedAt })
        pruneInspectJobsIfNeeded()
        void deps
          .inspectContext(prepared)
          .then((value) => {
            inspectJobs.set(jobId, { status: "done", startedAt, finishedAt: Date.now(), value })
          })
          .catch((err: unknown) => {
            const error = err instanceof Error ? err.message : String(err)
            inspectJobs.set(jobId, { status: "failed", startedAt, finishedAt: Date.now(), error })
          })
        return { ok: true, value: { status: "running", jobId } }
      }

      case "context-inspect-poll": {
        const jobId = typeof payload.params?.jobId === "string" ? payload.params.jobId : ""
        if (!jobId) {
          return { ok: false, error: "op=context-inspect-poll 需要 params.jobId" }
        }
        const entry = inspectJobs.get(jobId)
        if (!entry) {
          return { ok: false, error: `未知 context-inspect 任务：${jobId}（任务不存在、已被清理或前端已重载）` }
        }
        if (entry.status === "running") {
          return { ok: true, value: { status: "running", jobId } }
        }
        if (entry.status === "done") {
          return { ok: true, value: { status: "done", jobId, value: entry.value } }
        }
        return { ok: true, value: { status: "failed", jobId, error: entry.error } }
      }

      default:
        return { ok: false, error: `不支持的 op: ${String(payload.op)}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}

/**
 * 安装状态桥监听器。应用启动时调用一次，返回卸载函数。
 *
 * 返回的 `UnlistenFn` 必须被调用（组件/模块卸载时），否则监听器泄漏：
 * 热重载会累积多个监听器，同一条请求被处理多次、回多个响应。
 */
export async function installStateBridge(): Promise<UnlistenFn> {
  return listen<StateRequestPayload>(STATE_REQUEST_EVENT, async (event) => {
    const payload = event.payload
    const response = await handleStateRequest(payload)
    try {
      // 命令名写成字面量，不抽常量：`ipc-surface-contract.spec.ts` 的注册面/调用面
      // 对账只认调用点的字面量，抽成常量会让 `mcp_state_respond` 看起来"注册了
      // 但没人调用"（纯攻击面），并把这个文件变成对账盲区。与 Rust 侧
      // `mcp_server::mcp_state_respond` 必须一致。
      await invoke("mcp_state_respond", {
        id: payload?.id ?? "",
        ok: response.ok,
        value: response.value ?? null,
        error: response.error ?? null,
      })
    } catch (error) {
      // 回传失败无处可报（Rust 侧会超时）。至少在控制台留下痕迹，
      // 否则这类故障会表现为"偶发 5s 超时"而无任何线索。
      console.error("[mcp-state-bridge] 回传响应失败", error)
    }
  })
}
