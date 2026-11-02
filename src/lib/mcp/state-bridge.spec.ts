/**
 * 状态桥测试（方案 d23eb1df P0）。
 *
 * 重点不在 happy path，而在几条硬约束：
 * 1. 白名单外键必须被拒（否则桥就是任意 localStorage 读写通道）
 * 2. 任何异常必须回 error，不能静默丢弃（否则 Rust 只能靠 5s 超时兜底）
 * 3. 未打开项目必须明确报错，而不是返回空对象让上层自己猜
 * 4. P0 不得存在任何写操作
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  SETTINGS_BY_KEY,
  SETTINGS_CATALOG,
  isBridgeAllowedKey,
} from "./settings-catalog"
import {
  DEFAULT_CHAPTER_LIMIT,
  MAX_CHAPTER_LIMIT,
  handleStateRequest,
  type StateBridgeDeps,
  type StateRequestPayload,
} from "./state-bridge"

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function request(overrides: Partial<StateRequestPayload>): StateRequestPayload {
  return { id: "req-1", op: "get", ...overrides }
}

/** 构造一份可控的假依赖：项目路径、状态、章节文件全部由测试给定。 */
function deps(overrides: Partial<StateBridgeDeps> = {}): StateBridgeDeps {
  return {
    readProjectPath: () => "/proj",
    loadStatus: async () => null,
    listChapters: async () => [
      { name: "chapter-002.md", path: "/proj/wiki/chapters/chapter-002.md" },
      { name: "chapter-001.md", path: "/proj/wiki/chapters/chapter-001.md" },
    ],
    readFileText: async () => "line1\nline2\nline3\nline4\nline5",
    ...overrides,
  }
}

describe("settings catalog", () => {
  it("键名唯一", () => {
    const keys = SETTINGS_CATALOG.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("索引与数组一致", () => {
    expect(SETTINGS_BY_KEY.size).toBe(SETTINGS_CATALOG.length)
  })

  it("P0 全部为只读", () => {
    expect(SETTINGS_CATALOG.every((e) => e.scope === "read")).toBe(true)
  })

  it("白名单按精确键名判定，不做前缀放行", () => {
    expect(isBridgeAllowedKey("niko-buddy-focus-mode")).toBe(true)
    // 同前缀但未登记的键必须拒绝——前缀匹配会把桥变成任意读写通道。
    expect(isBridgeAllowedKey("niko-buddy-not-registered")).toBe(false)
    expect(isBridgeAllowedKey("lk-something-else")).toBe(false)
  })
})

describe("handleStateRequest — 设置", () => {
  it("op=schema 返回全量目录", async () => {
    const res = await handleStateRequest(request({ op: "schema" }))
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.value)).toBe(true)
    expect((res.value as unknown[]).length).toBe(SETTINGS_CATALOG.length)
  })

  it("op=list 返回每项的当前值", async () => {
    store.set("niko-buddy-focus-mode", "1")
    const res = await handleStateRequest(request({ op: "list" }))
    expect(res.ok).toBe(true)
    const entries = res.value as Array<{ key: string; value: string | null }>
    expect(entries.find((e) => e.key === "niko-buddy-focus-mode")?.value).toBe("1")
    // 未设置的键如实返回 null（"未设置"不等于"读不到"）。
    expect(entries.find((e) => e.key === "lk-chat-height")?.value).toBeNull()
  })

  it("op=get 返回已登记键的值", async () => {
    store.set("lk-sidebar-collapsed", "true")
    const res = await handleStateRequest(request({ key: "lk-sidebar-collapsed" }))
    expect(res.ok).toBe(true)
    expect((res.value as { value: string }).value).toBe("true")
  })

  it("op=get 拒绝未登记键", async () => {
    const res = await handleStateRequest(request({ key: "definitely-not-registered" }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未登记")
  })

  it("op=get 缺少 key 时明确报错", async () => {
    const res = await handleStateRequest(request({}))
    expect(res.ok).toBe(false)
    expect(res.error).toContain("需要 key")
  })

  it("缺少 id 的请求被拒", async () => {
    const res = await handleStateRequest({ id: "", op: "schema" })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("id")
  })

  it("不支持的 op 明确报错而非静默成功", async () => {
    const res = await handleStateRequest({ id: "x", op: "set" as never })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("不支持的 op")
  })

  it("localStorage 抛错时转成 error 响应，不伪装成 null", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("storage disabled")
        },
      },
    })
    const res = await handleStateRequest(request({ key: "niko-buddy-focus-mode" }))
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it("P0 不存在任何写操作入口", async () => {
    const mod = await import("./state-bridge")
    const exported = Object.keys(mod)
    expect(exported.filter((name) => /^(set|write|remove|delete|update)/i.test(name))).toEqual([])
  })
})

describe("handleStateRequest — 项目", () => {
  it("op=project 返回当前项目路径", async () => {
    const res = await handleStateRequest(request({ op: "project" }), deps())
    expect(res.ok).toBe(true)
    expect(res.value).toEqual({ projectPath: "/proj" })
  })

  it("未打开项目时明确报错，不返回空对象", async () => {
    const res = await handleStateRequest(
      request({ op: "project" }),
      deps({ readProjectPath: () => "" }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未打开项目")
  })

  it("op=project-state 返回 status；status 为 null 是合法降级而非错误", async () => {
    const res = await handleStateRequest(request({ op: "project-state" }), deps())
    expect(res.ok).toBe(true)
    expect(res.value).toEqual({ projectPath: "/proj", status: null })
  })

  it("op=project-state 透传 status 内容", async () => {
    const res = await handleStateRequest(
      request({ op: "project-state" }),
      deps({ loadStatus: async () => ({ session_id: "s1", status: "running" }) }),
    )
    expect(res.ok).toBe(true)
    expect((res.value as { status: { session_id: string } }).status.session_id).toBe("s1")
  })

  it("op=project-state 读取失败时回 error", async () => {
    const res = await handleStateRequest(
      request({ op: "project-state" }),
      deps({
        loadStatus: async () => {
          throw new Error("status.json 损坏")
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("status.json 损坏")
  })
})

describe("handleStateRequest — 章节", () => {
  it("op=chapter-list 按文件名排序并给 1 起序号", async () => {
    const res = await handleStateRequest(request({ op: "chapter-list" }), deps())
    expect(res.ok).toBe(true)
    const value = res.value as {
      total: number
      chapters: { index: number; name: string }[]
    }
    expect(value.total).toBe(2)
    expect(value.chapters.map((c) => c.name)).toEqual([
      "chapter-001.md",
      "chapter-002.md",
    ])
    expect(value.chapters.map((c) => c.index)).toEqual([1, 2])
  })

  it("op=chapter-read 支持按序号读", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "2" }),
      deps(),
    )
    expect(res.ok).toBe(true)
    const value = res.value as { name: string; content: string }
    expect(value.name).toBe("chapter-002.md")
    expect(value.content).toContain("line1")
  })

  it("op=chapter-read 支持按文件名读", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "chapter-001.md" }),
      deps(),
    )
    expect(res.ok).toBe(true)
    expect((res.value as { name: string }).name).toBe("chapter-001.md")
  })

  it("序号越界时报错并给出总章数", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "99" }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("越界")
    expect(res.error).toContain("2")
  })

  it("找不到文件名时报错", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "nope.md" }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("找不到章节")
  })

  it("章节目录为空时报错而不是返回空内容", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "1" }),
      deps({ listChapters: async () => [] }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("没有章节文件")
  })

  it("offset/limit 生效，并正确标记 truncated", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "1", offset: 1, limit: 2 }),
      deps(),
    )
    expect(res.ok).toBe(true)
    const value = res.value as {
      content: string
      totalLines: number
      truncated: boolean
      offset: number
      limit: number
    }
    expect(value.content).toBe("line2\nline3")
    expect(value.totalLines).toBe(5)
    expect(value.truncated).toBe(true)
    expect(value.offset).toBe(1)
    expect(value.limit).toBe(2)
  })

  it("limit 被硬上限钳制", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "1", limit: 999_999 }),
      deps(),
    )
    expect(res.ok).toBe(true)
    expect((res.value as { limit: number }).limit).toBe(MAX_CHAPTER_LIMIT)
  })

  it("缺省 limit 是 DEFAULT_CHAPTER_LIMIT", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "1" }),
      deps(),
    )
    expect(res.ok).toBe(true)
    expect((res.value as { limit: number }).limit).toBe(DEFAULT_CHAPTER_LIMIT)
  })

  it("读完最后一页时 truncated=false", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "1", offset: 3, limit: 2 }),
      deps(),
    )
    expect(res.ok).toBe(true)
    expect((res.value as { truncated: boolean }).truncated).toBe(false)
  })

  it("缺少章节选择器时报错", async () => {
    const res = await handleStateRequest(request({ op: "chapter-read" }), deps())
    expect(res.ok).toBe(false)
    expect(res.error).toContain("需要章节序号或文件名")
  })
})
