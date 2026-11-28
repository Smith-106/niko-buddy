#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
/**
 * weknora-novel-mcp-bridge.mjs — WeKnora 小说创作三库（只读）stdio MCP 桥接器。
 *
 * 定位与安全边界：
 *   1. 对齐 `niko-buddy` `RealMcpConnector`（仅支持 `stdio` 换行分隔 JSON-RPC 2.0）。
 *   2. 桥接本地 Docker 容器 `WeKnora-mcp`（`weknora-mcp-server`），**硬编码只读工具白名单**：
 *      仅开放检索/浏览工具，彻底屏蔽上游 `delete_*` / `create_*` / `chat` 等写入与会话接口。
 *   3. 默认白名单严格锁定 3 个小说创作专属知识库（屏蔽游戏开发 / 引擎文档等非小说库）：
 *      - `craft`（`b4f22fe9-8581-4a33-9d7e-000000000001`）：写作技法库（93 本技法论著 / 9,113 条 Wiki）
 *      - `lore` （`b4f22fe9-8581-4a33-9d7e-e1461eed5a4b`）：小说素材与人文库（1,375 册史料博物 / 69,349 条 Wiki，默认库）
 *      - `tech` （`b4f22fe9-8581-4a33-9d7e-000000000002`）：理工与计算机库（389 册理工医科文献 / 18,835 条 Wiki）
 *   4. 所有日志只写 `stderr`，`stdout` 严格只输出合法 JSON-RPC 2.0 单行帧。
 *
 * 环境变量（均可选）：
 *   WEKNORA_KB_ID            默认知识库 ID（默认: b4f22fe9-8581-4a33-9d7e-e1461eed5a4b，即小说素材与人文库）
 *   WEKNORA_ALLOWED_KB_IDS   逗号分隔白名单 KB ID 列表（默认包含 craft / lore / tech 三库）
 *   WEKNORA_LOCK_KB          "1"（默认）仅允许查询白名单三库；"0" 允许自定义 kb_id
 *   WEKNORA_DOCKER_CONTAINER Docker 容器名（默认: WeKnora-mcp）
 *   WEKNORA_BASE_URL         容器内 WeKnora API 地址（默认: http://WeKnora-app:8080/api/v1）
 *   WEKNORA_DOCKER_BIN       docker 可执行文件路径（默认: docker）
 *
 * 辅助命令：
 *   node scripts/weknora-novel-mcp-bridge.mjs --print-niko-buddy-config
 *   node scripts/weknora-novel-mcp-bridge.mjs --help
 */

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const NOVEL_KB_PROFILES = Object.freeze([
  {
    key: "craft",
    id: "b4f22fe9-8581-4a33-9d7e-000000000001",
    name: "写作技法库",
    docs: 93,
    wikiPages: 9113,
    scope: "叙事结构、开篇钩子、冲突与悬念、人物塑造、对白潜台词、视角调度、推理诡计与创意写作理论",
  },
  {
    key: "lore",
    id: "b4f22fe9-8581-4a33-9d7e-e1461eed5a4b",
    name: "小说素材与人文库",
    docs: 1375,
    wikiPages: 69349,
    scope: "历史制度、官制礼俗、饮食器物、地理博物、法律宗教、文学名作案例与时代社会细节（默认库）",
  },
  {
    key: "tech",
    id: "b4f22fe9-8581-4a33-9d7e-000000000002",
    name: "理工与计算机库",
    docs: 389,
    wikiPages: 18835,
    scope: "物理化学、医学法医、生物基因、计算机与AI、机械工程与硬科幻/职业考据细节",
  },
])

const KB_BY_KEY = new Map(NOVEL_KB_PROFILES.map((kb) => [kb.key, kb]))
const KB_BY_ID = new Map(NOVEL_KB_PROFILES.map((kb) => [kb.id, kb]))

const KB_ALIAS_MAP = new Map([
  ["craft", "b4f22fe9-8581-4a33-9d7e-000000000001"],
  ["写作技法库", "b4f22fe9-8581-4a33-9d7e-000000000001"],
  ["写作技法", "b4f22fe9-8581-4a33-9d7e-000000000001"],
  ["技法库", "b4f22fe9-8581-4a33-9d7e-000000000001"],
  ["技法", "b4f22fe9-8581-4a33-9d7e-000000000001"],
  ["文论", "b4f22fe9-8581-4a33-9d7e-000000000001"],
  ["lore", "b4f22fe9-8581-4a33-9d7e-e1461eed5a4b"],
  ["小说素材与人文库", "b4f22fe9-8581-4a33-9d7e-e1461eed5a4b"],
  ["小说素材库", "b4f22fe9-8581-4a33-9d7e-e1461eed5a4b"],
  ["人文库", "b4f22fe9-8581-4a33-9d7e-e1461eed5a4b"],
  ["人文", "b4f22fe9-8581-4a33-9d7e-e1461eed5a4b"],
  ["素材", "b4f22fe9-8581-4a33-9d7e-e1461eed5a4b"],
  ["写作参考库", "b4f22fe9-8581-4a33-9d7e-e1461eed5a4b"],
  ["tech", "b4f22fe9-8581-4a33-9d7e-000000000002"],
  ["理工与计算机库", "b4f22fe9-8581-4a33-9d7e-000000000002"],
  ["理工库", "b4f22fe9-8581-4a33-9d7e-000000000002"],
  ["理工", "b4f22fe9-8581-4a33-9d7e-000000000002"],
  ["计算机", "b4f22fe9-8581-4a33-9d7e-000000000002"],
  ["科幻", "b4f22fe9-8581-4a33-9d7e-000000000002"],
  ["医学", "b4f22fe9-8581-4a33-9d7e-000000000002"],
  ["刑侦", "b4f22fe9-8581-4a33-9d7e-000000000002"],
])

const DEFAULT_KB_ID = process.env.WEKNORA_KB_ID || KB_BY_KEY.get("lore").id
const ALLOWED_KB_IDS = new Set(
  (process.env.WEKNORA_ALLOWED_KB_IDS || NOVEL_KB_PROFILES.map((kb) => kb.id).join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)
if (DEFAULT_KB_ID) ALLOWED_KB_IDS.add(DEFAULT_KB_ID)
const LOCK_KB = process.env.WEKNORA_LOCK_KB !== "0"
const DOCKER_CONTAINER = process.env.WEKNORA_DOCKER_CONTAINER || "WeKnora-mcp"
const WEKNORA_BASE_URL = process.env.WEKNORA_BASE_URL || "http://WeKnora-app:8080/api/v1"
const DOCKER_BIN = process.env.WEKNORA_DOCKER_BIN || "docker"
const UPSTREAM_TIMEOUT_MS = Number(process.env.WEKNORA_TIMEOUT_MS || 25_000)
const HYBRID_TIMEOUT_MS = Number(process.env.WEKNORA_HYBRID_TIMEOUT_MS || 18_000)

const SERVER_DISPLAY_NAME = "WeKnora 小说知识三库（只读：技法 / 人文素材 / 理工）"
const SERVER_INFO = {
  name: "niko-buddy-weknora-writing-ref",
  version: "2.0.0",
}

const KB_PARAM_DESCRIPTION =
  "目标小说知识库：craft（写作技法库：叙事/悬念/人物/对白/视角，93本/9113词条）、lore（小说素材与人文库：历史/制度/民俗/器物，1375本/69349词条，默认）、tech（理工与计算机库：理化/医学法医/CS/工程，389本/18835词条）"

/** 严格只读工具白名单（与 niko-buddy McpToolDescriptor.operation="read" 对齐）。 */
const EXPOSED_TOOLS = [
  {
    name: "list_novel_knowledge_bases",
    upstreamName: null,
    localOnly: true,
    operation: "read",
    description:
      "列出当前绑定用于小说创作的 3 个 WeKnora 只读知识库（写作技法库 craft / 小说素材与人文库 lore / 理工与计算机库 tech）的适用领域、文档量与 Wiki 规模，先定库再检索。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    mapArgs: () => ({}),
  },
  {
    name: "search_writing_wiki",
    upstreamName: "wiki_search",
    operation: "read",
    description:
      "在 WeKnora 小说知识三库（合计 97,297 条结构化 Wiki 词条）中按关键词全文检索。支持通过 kb 指定 craft（技法）/ lore（人文素材，默认）/ tech（理工硬核）/ all（三库并发检索）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词或短语（建议 1–2 个精确中文核心词）" },
        kb: {
          type: "string",
          enum: ["craft", "lore", "tech", "all"],
          default: "lore",
          description: `${KB_PARAM_DESCRIPTION}，或传 all 并发查三库`,
        },
        limit: { type: "integer", description: "每库返回条数上限（1–20，默认 8）", default: 8 },
      },
      required: ["query"],
    },
    mapArgs: (args) => {
      const target = resolveKbTarget(args, { allowAll: true })
      return {
        ...target,
        query: String(args?.query ?? "").trim(),
        limit: clampInt(args?.limit, 8, 1, 20),
      }
    },
  },
  {
    name: "read_writing_wiki_page",
    upstreamName: "wiki_read_page",
    operation: "read",
    description:
      "按 slug 读取对应知识库单篇 Wiki 词条的完整 Markdown 内容、关联词条与来源参考（配合 search_writing_wiki 使用；若省略 kb 且在默认库未找到会自动尝试另两库）。",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Wiki 词条 slug（由 search_writing_wiki 返回）" },
        kb: {
          type: "string",
          enum: ["craft", "lore", "tech"],
          description: KB_PARAM_DESCRIPTION,
        },
      },
      required: ["slug"],
    },
    mapArgs: (args) => {
      const target = resolveKbTarget(args, { allowAll: false })
      return {
        ...target,
        slug: String(args?.slug ?? "").trim(),
      }
    },
  },
  {
    name: "search_writing_reference",
    upstreamName: "hybrid_search",
    operation: "read",
    description:
      "在指定 WeKnora 小说知识库（1,857 册原文 + 3584 维向量 + BM25 + Qwen3-Reranker-8B）中执行深度混合检索。仅在 search_writing_wiki 未命中或需长段原文引据时调用；超时会自动降级回 Wiki 检索。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "自然语言考据问题或技法问题" },
        kb: {
          type: "string",
          enum: ["craft", "lore", "tech"],
          default: "lore",
          description: KB_PARAM_DESCRIPTION,
        },
        match_count: { type: "integer", description: "返回片段数（1–15，默认 5）", default: 5 },
        vector_threshold: { type: "number", description: "向量相似度阈值（默认 0.5）", default: 0.5 },
        keyword_threshold: { type: "number", description: "关键词阈值（默认 0.3）", default: 0.3 },
      },
      required: ["query"],
    },
    mapArgs: (args) => {
      const target = resolveKbTarget(args, { allowAll: false })
      return {
        kb_id: target.kbIds[0],
        query: String(args?.query ?? "").trim(),
        match_count: clampInt(args?.match_count, 5, 1, 15),
        vector_threshold: clampNum(args?.vector_threshold, 0.5, 0, 1),
        keyword_threshold: clampNum(args?.keyword_threshold, 0.3, 0, 1),
      }
    },
  },
  {
    name: "browse_writing_wiki_index",
    upstreamName: "wiki_index_view",
    operation: "read",
    description:
      "浏览指定知识库（craft 技法库 / lore 人文素材库 / tech 理工库）的分类目录与结构化 Wiki 索引总览，摸清涵盖学科与目录树。",
    inputSchema: {
      type: "object",
      properties: {
        kb: {
          type: "string",
          enum: ["craft", "lore", "tech"],
          default: "lore",
          description: KB_PARAM_DESCRIPTION,
        },
        limit: { type: "integer", description: "返回目录条数上限（1–100，默认 30）", default: 30 },
      },
      required: [],
    },
    mapArgs: (args) => {
      const target = resolveKbTarget(args, { allowAll: false })
      return {
        kb_id: target.kbIds[0],
        limit: clampInt(args?.limit, 30, 1, 100),
      }
    },
  },
]

const TOOL_BY_NAME = new Map(EXPOSED_TOOLS.map((t) => [t.name, t]))

function resolveKbTarget(args, { allowAll = false } = {}) {
  const raw = String(args?.kb ?? args?.kb_id ?? "").trim()
  if (!raw) {
    return { explicit: false, isAll: false, kbIds: [DEFAULT_KB_ID] }
  }
  const lowered = raw.toLowerCase()
  if (lowered === "all" || raw === "全部" || raw === "三库") {
    if (!allowAll) {
      throw new Error("当前工具仅支持指定单个知识库（craft / lore / tech），不支持 kb=all。")
    }
    return {
      explicit: true,
      isAll: true,
      kbIds: NOVEL_KB_PROFILES.map((kb) => kb.id).filter((id) => !LOCK_KB || ALLOWED_KB_IDS.has(id)),
    }
  }
  const resolvedId = KB_ALIAS_MAP.get(raw) || KB_ALIAS_MAP.get(lowered) || raw
  if (LOCK_KB && !ALLOWED_KB_IDS.has(resolvedId)) {
    throw new Error(
      `拒绝访问未授权知识库「${raw}」：当前仅允许查询小说创作三库（craft=写作技法库, lore=小说素材与人文库, tech=理工与计算机库）。`,
    )
  }
  return { explicit: true, isAll: false, kbIds: [resolvedId] }
}

function clampInt(val, fallback, min, max) {
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function clampNum(val, fallback, min, max) {
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function buildNikoBuddyServerConfig() {
  const scriptPath = fileURLToPath(import.meta.url)
  return {
    id: "weknora-writing-ref",
    name: SERVER_DISPLAY_NAME,
    enabled: true,
    transport: "stdio",
    command: process.execPath,
    args: [scriptPath],
    env: {
      WEKNORA_KB_ID: DEFAULT_KB_ID,
      WEKNORA_ALLOWED_KB_IDS: Array.from(ALLOWED_KB_IDS).join(","),
      WEKNORA_LOCK_KB: "1",
      WEKNORA_DOCKER_CONTAINER: DOCKER_CONTAINER,
      WEKNORA_BASE_URL: WEKNORA_BASE_URL,
    },
    tools: EXPOSED_TOOLS.map((t) => ({
      serverId: "weknora-writing-ref",
      serverName: SERVER_DISPLAY_NAME,
      name: t.name,
      description: t.description,
      operation: t.operation,
      inputSchema: t.inputSchema,
    })),
  }
}

// ============================================================================
// 上游 Docker WeKnora-mcp stdio 代理客户端
// ============================================================================

class UpstreamWeKnoraClient {
  constructor() {
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.initPromise = null
  }

  ensureStarted() {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.#startAndHandshake().catch((err) => {
      this.close()
      throw err
    })
    return this.initPromise
  }

  async #startAndHandshake() {
    const child = spawn(
      DOCKER_BIN,
      [
        "exec",
        "-i",
        "-e",
        `WEKNORA_BASE_URL=${WEKNORA_BASE_URL}`,
        DOCKER_CONTAINER,
        "weknora-mcp-server",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    )
    this.child = child

    child.stderr.on("data", (chunk) => {
      // 上游日志全部转发到 stderr，严禁污染 stdout JSON-RPC 帧
      process.stderr.write(`[weknora-upstream] ${chunk.toString("utf8")}`)
    })

    child.on("error", (err) => {
      if (this.child !== child) return
      this.#rejectAll(new Error(`启动 Docker WeKnora-mcp 失败: ${err.message}`))
    })

    child.on("exit", (code, signal) => {
      // 只在仍是当前活跃子进程时清理状态，避免旧进程延迟 exit 误杀新拉起的子进程
      if (this.child !== child) return
      this.#rejectAll(new Error(`上游 WeKnora-mcp 进程已退出 (code=${code}, signal=${signal})`))
      this.child = null
      this.initPromise = null
    })

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg
      try {
        msg = JSON.parse(trimmed)
      } catch {
        process.stderr.write(`[weknora-bridge] 忽略非 JSON 上游行: ${trimmed.slice(0, 120)}\n`)
        return
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(entry.timer)
        if ("error" in msg) {
          entry.reject(new Error(msg.error?.message || "上游 MCP 返回错误"))
        } else {
          entry.resolve(msg.result)
        }
      }
    })

    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: SERVER_INFO,
    })
    this.notify("notifications/initialized")
  }

  call(method, params, timeoutMs = UPSTREAM_TIMEOUT_MS) {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error("上游 WeKnora-mcp 未连接"))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`上游 WeKnora-mcp 调用超时 (${method})`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const payload = params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params }
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8")
    })
  }

  notify(method, params) {
    if (!this.child || !this.child.stdin.writable) return
    const payload = params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8")
  }

  #rejectAll(err) {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer)
      entry.reject(err)
      this.pending.delete(id)
    }
  }

  close() {
    this.#rejectAll(new Error("桥接器关闭"))
    if (this.child) {
      try {
        this.child.stdin.end()
        this.child.kill()
      } catch {
        // 忽略清理异常
      }
      this.child = null
    }
    this.initPromise = null
  }
}

// ============================================================================
// 下游 JSON-RPC 2.0 服务器循环（面向 niko-buddy RealMcpConnector）
// ============================================================================

function writeJsonRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`, "utf8")
}

function writeSuccess(id, result) {
  writeJsonRpc({ jsonrpc: "2.0", id, result })
}

function writeError(id, code, message) {
  writeJsonRpc({ jsonrpc: "2.0", id, error: { code, message } })
}

async function runStdioServer() {
  const upstream = new UpstreamWeKnoraClient()

  const shutdown = () => {
    upstream.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let chain = Promise.resolve()

  rl.on("line", (rawLine) => {
    const trimmed = rawLine.trim()
    if (!trimmed) return
    chain = chain.then(() => handleLine(trimmed, upstream))
  })

  rl.on("close", () => {
    chain.finally(() => {
      upstream.close()
      process.exit(0)
    })
  })
}

async function handleLine(line, upstream) {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    writeError(null, -32700, "JSON 解析失败")
    return
  }

  const { id, method, params } = req
  // JSON-RPC 通知无 id，无需回包
  if (id === undefined || id === null) {
    return
  }

  try {
    if (method === "initialize") {
      // 握手阶段即验证上游 WeKnora-mcp 可达，使 niko-buddy「测试连接」真实探活
      await upstream.ensureStarted()
      writeSuccess(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })
      return
    }

    if (method === "ping") {
      writeSuccess(id, {})
      return
    }

    if (method === "tools/list") {
      writeSuccess(id, {
        tools: EXPOSED_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
      return
    }

    if (method === "tools/call") {
      const toolName = String(params?.name || "")
      const spec = TOOL_BY_NAME.get(toolName)
      if (!spec) {
        writeError(
          id,
          -32601,
          `拒绝调用未授权工具「${toolName}」：本桥接器仅开放只读检索白名单（${EXPOSED_TOOLS.map((t) => t.name).join(", ")}）`,
        )
        return
      }
      if (spec.localOnly) {
        writeSuccess(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  default_kb: KB_BY_ID.get(DEFAULT_KB_ID)?.key || DEFAULT_KB_ID,
                  lock_kb: LOCK_KB,
                  knowledge_bases: NOVEL_KB_PROFILES.map((kb) => ({
                    ...kb,
                    is_default: kb.id === DEFAULT_KB_ID,
                    allowed: !LOCK_KB || ALLOWED_KB_IDS.has(kb.id),
                  })),
                },
                null,
                2,
              ),
            },
          ],
        })
        return
      }
      let mappedArgs
      try {
        mappedArgs = spec.mapArgs(params?.arguments || {})
      } catch (argErr) {
        writeError(id, -32602, argErr instanceof Error ? argErr.message : String(argErr))
        return
      }
      if (spec.inputSchema.required?.includes("query") && !mappedArgs.query) {
        writeError(id, -32602, "参数 query 不能为空")
        return
      }
      if (spec.inputSchema.required?.includes("slug") && !mappedArgs.slug) {
        writeError(id, -32602, "参数 slug 不能为空")
        return
      }
      await upstream.ensureStarted()

      // 1) search_writing_wiki 支持 kb="all" 并发查三库并按库名标签聚合结果
      if (spec.name === "search_writing_wiki" && mappedArgs.kbIds) {
        const kbIds = mappedArgs.kbIds
        if (kbIds.length === 1) {
          const singleRes = await upstream.call(
            "tools/call",
            {
              name: spec.upstreamName,
              arguments: { kb_id: kbIds[0], query: mappedArgs.query, limit: mappedArgs.limit },
            },
            UPSTREAM_TIMEOUT_MS,
          )
          writeSuccess(id, singleRes)
          return
        }
        const results = await Promise.all(
          kbIds.map(async (kbId) => {
            const kbMeta = KB_BY_ID.get(kbId)
            const label = kbMeta ? `${kbMeta.name} (${kbMeta.key})` : kbId
            try {
              const res = await upstream.call(
                "tools/call",
                {
                  name: spec.upstreamName,
                  arguments: { kb_id: kbId, query: mappedArgs.query, limit: mappedArgs.limit },
                },
                UPSTREAM_TIMEOUT_MS,
              )
              return { label, kbId, res }
            } catch (err) {
              return { label, kbId, err: err instanceof Error ? err.message : String(err) }
            }
          }),
        )
        const mergedContent = []
        for (const item of results) {
          if (item.err) {
            mergedContent.push({ type: "text", text: `[${item.label}] 检索失败: ${item.err}` })
            continue
          }
          const blocks = Array.isArray(item.res?.content) ? item.res.content : []
          for (const block of blocks) {
            if (block?.type === "text") {
              mergedContent.push({ type: "text", text: `[${item.label}]\n${block.text}` })
            } else {
              mergedContent.push(block)
            }
          }
        }
        writeSuccess(id, { content: mergedContent })
        return
      }

      // 2) read_writing_wiki_page：若未显式指定 kb 且默认库未命中，自动轮询另两库容错
      if (spec.name === "read_writing_wiki_page" && mappedArgs.kbIds) {
        const candidateIds = mappedArgs.explicit
          ? mappedArgs.kbIds
          : [
              mappedArgs.kbIds[0],
              ...NOVEL_KB_PROFILES.map((kb) => kb.id).filter(
                (kid) => kid !== mappedArgs.kbIds[0] && (!LOCK_KB || ALLOWED_KB_IDS.has(kid)),
              ),
            ]
        let lastErr = null
        for (const kbId of candidateIds) {
          try {
            const pageRes = await upstream.call(
              "tools/call",
              {
                name: spec.upstreamName,
                arguments: { kb_id: kbId, slug: mappedArgs.slug },
              },
              UPSTREAM_TIMEOUT_MS,
            )
            const firstText = Array.isArray(pageRes?.content) ? String(pageRes.content[0]?.text || "") : ""
            const isMissing =
              !pageRes ||
              pageRes.isError ||
              !firstText ||
              firstText.includes("not found") ||
              firstText.includes("未找到") ||
              firstText === "{}" ||
              firstText === "null"
            if (!isMissing || candidateIds.length === 1) {
              writeSuccess(id, pageRes)
              return
            }
          } catch (err) {
            lastErr = err
          }
        }
        if (lastErr) throw lastErr
        writeError(id, -32000, `未在小说三库中找到 slug="${mappedArgs.slug}" 的 Wiki 页面`)
        return
      }

      // 3) 其余单库工具（search_writing_reference / browse_writing_wiki_index）
      const callTimeout = spec.name === "search_writing_reference" ? HYBRID_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS
      try {
        const upstreamResult = await upstream.call(
          "tools/call",
          {
            name: spec.upstreamName,
            arguments: mappedArgs,
          },
          callTimeout,
        )
        writeSuccess(id, upstreamResult)
      } catch (callErr) {
        // hybrid_search 在大库冷扫描时可能超过 niko-buddy 30s MCP 超时，自动降级为 wiki_search 避免硬超时
        const errMsg = callErr instanceof Error ? callErr.message : String(callErr)
        if (spec.name === "search_writing_reference" && errMsg.includes("超时")) {
          // 重启上游子进程以脱离可能仍在阻塞的慢查询，再用轻量 wiki_search 立即回退
          upstream.close()
          await upstream.ensureStarted()
          const fallbackQuery = mappedArgs.query.split(/\s+/)[0] || mappedArgs.query
          const wikiFallback = await upstream.call(
            "tools/call",
            {
              name: "wiki_search",
              arguments: { kb_id: mappedArgs.kb_id, query: fallbackQuery, limit: mappedArgs.match_count },
            },
            UPSTREAM_TIMEOUT_MS,
          )
          const content = Array.isArray(wikiFallback?.content) ? [...wikiFallback.content] : []
          content.unshift({
            type: "text",
            text: `（提示：全量 hybrid_search 超过 ${Math.round(HYBRID_TIMEOUT_MS / 1000)}s，已自动降级为 Wiki 词条检索「${fallbackQuery}」，建议后续优先调用 search_writing_wiki + read_writing_wiki_page。）`,
          })
          writeSuccess(id, { ...wikiFallback, content })
          return
        }
        throw callErr
      }
      return
    }

    writeError(id, -32601, `不支持的 MCP 方法: ${String(method)}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    writeError(id, -32000, msg)
  }
}

// ============================================================================
// 入口分发
// ============================================================================

const argv = process.argv.slice(2)
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`WeKnora 小说知识三库（craft/lore/tech）只读 stdio MCP 桥接器
用法:
  node scripts/weknora-novel-mcp-bridge.mjs                          # 作为 stdio MCP 服务运行
  node scripts/weknora-novel-mcp-bridge.mjs --print-niko-buddy-config # 输出 niko-buddy McpServerConfig JSON`)
  process.exit(0)
}

if (argv.includes("--print-niko-buddy-config")) {
  console.log(JSON.stringify(buildNikoBuddyServerConfig(), null, 2))
  process.exit(0)
}

void runStdioServer()
