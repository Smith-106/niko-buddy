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
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

import { readFile } from "@/commands/fs"
import { listScopeFiles } from "@/lib/novel/agent-tools"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { useWikiStore } from "@/stores/wiki-store"

import {
  SECRET_REF_CATEGORIES,
  SETTINGS_BY_KEY,
  SETTINGS_CATALOG,
  isBridgeAllowedKey,
} from "./settings-catalog"
import { SettingsValidationError, getWriter, validateValue } from "./settings-writers"

/** Rust → WebView 的请求事件名（与 Rust 侧 `state_bridge::REQUEST_EVENT` 必须一致）。 */
export const STATE_REQUEST_EVENT = "mcp:state-request"
/** WebView → Rust 的回传命令名（与 Rust 侧 `mcp_state_respond` 必须一致）。 */
export const STATE_RESPOND_COMMAND = "mcp_state_respond"

/** 桥支持的操作。`set` 是 P1 新增的唯一写入操作。 */
export type StateOp =
  | "get"
  | "list"
  | "schema"
  | "set"
  | "project"
  | "project-state"
  | "chapter-list"
  | "chapter-read"

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
  writeSetting: (key, value) => {
    const writer = getWriter(key)
    if (!writer) {
      // catalog 标了 write 却没有写入器就是登记错误（settings-writers 加载时已自检）。
      throw new Error(`${key} 没有注册写入器，拒绝写入`)
    }
    return writer.write(value)
  },
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
      await invoke(STATE_RESPOND_COMMAND, {
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
