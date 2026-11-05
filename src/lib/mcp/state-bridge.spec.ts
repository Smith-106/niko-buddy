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
    // 默认读/写都走同一个内存 Map，这样 list/get/set 的断言能互相对上。
    readSetting: (key) => (store.has(key) ? store.get(key) : null),
    writeSetting: async (key, value) => {
      store.set(key, value as string)
      return value
    },
    // 项目动作：默认给出"未实现"的失败，让各用例显式覆盖自己要验的分支，
    // 避免某个用例因为默认实现而"假通过"。
    startPipeline: () => ({ ok: false, error: "测试未注入 startPipeline" }),
    readPipeline: () => null,
    writeChapterDraft: async () => ({ draftId: "draft_test", chapterName: "x", path: "/proj/d.md", chars: 1 }),
    resolveFormalPath: () => ({ kind: "chapter", path: "/proj/wiki/chapters/x.md" }),
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

  it("P1 可写键是显式白名单，其余保持只读", () => {
    const writable = SETTINGS_CATALOG.filter((e) => e.scope === "write").map((e) => e.key)
    expect(writable.length).toBeGreaterThan(0)
    expect(writable).toContain("theme")
    expect(writable).toContain("niko-buddy-ui-font-size-scale")
    // 只改 localStorage 不改内存态的键不得开写（界面不会刷新）。
    expect(writable).not.toContain("lk-graph-edge-style")
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
    store.set("lk-chat-height", "300")
    const res = await handleStateRequest(request({ op: "list" }), deps())
    expect(res.ok).toBe(true)
    const entries = res.value as Array<{ key: string; value: string | null }>
    expect(entries.find((e) => e.key === "lk-chat-height")?.value).toBe("300")
    // 未设置的键如实返回 null（"未设置"不等于"读不到"）。
    expect(entries.find((e) => e.key === "lk-graph-edge-style")?.value).toBeNull()
  })

  it("op=get 返回已登记键的值", async () => {
    store.set("lk-sidebar-collapsed", "true")
    const res = await handleStateRequest(request({ key: "lk-sidebar-collapsed" }), deps())
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
    const res = await handleStateRequest({ id: "x", op: "remove" as never })
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
    // 不注入 deps：要验的就是默认路径（只读 localStorage 键直接读原始存储）。
    const res = await handleStateRequest(request({ key: "lk-sidebar-collapsed" }))
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it("P0 不存在任何写操作入口", async () => {
    const mod = await import("./state-bridge")
    const exported = Object.keys(mod)
    expect(exported.filter((name) => /^(set|write|remove|delete|update)/i.test(name))).toEqual([])
  })
})

describe("handleStateRequest — 写入（P1）", () => {
  it("op=set 写入可写键并返回 before/after", async () => {
    store.set("theme", "light")
    const res = await handleStateRequest(
      request({ op: "set", key: "theme", value: "dark" }),
      deps(),
    )
    expect(res.ok).toBe(true)
    expect(res.value).toMatchObject({ key: "theme", before: "light", after: "dark" })
    expect(store.get("theme")).toBe("dark")
  })

  it("op=set 拒绝只读键", async () => {
    const res = await handleStateRequest(
      request({ op: "set", key: "lk-graph-edge-style", value: "curve" }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("只读键")
  })

  it("op=set 拒绝凭据类键并说明原因（C-009）", async () => {
    const res = await handleStateRequest(
      request({ op: "set", key: "mcp-server:bearer-token", value: "x" }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("凭据类")
    expect(res.error).toContain("C-009")
  })

  it("op=set 拒绝未登记键", async () => {
    const res = await handleStateRequest(
      request({ op: "set", key: "niko-buddy-not-real", value: "x" }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未登记")
  })

  it("op=set 拒绝缺少 key / value", async () => {
    const noKey = await handleStateRequest(request({ op: "set", value: 1 }), deps())
    expect(noKey.ok).toBe(false)
    expect(noKey.error).toContain("需要 key")

    const noValue = await handleStateRequest(request({ op: "set", key: "theme" }), deps())
    expect(noValue.ok).toBe(false)
    expect(noValue.error).toContain("需要 value")
  })

  it("op=set 类型不符时拒绝且不落盘", async () => {
    const res = await handleStateRequest(
      request({ op: "set", key: "theme", value: 123 }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("只接受")
    expect(store.has("theme")).toBe(false)
  })

  it("op=set 枚举越界时拒绝", async () => {
    const res = await handleStateRequest(
      request({ op: "set", key: "theme", value: "midnight" }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("midnight")
  })

  it("op=set 数值越界时拒绝而不是静默钳制", async () => {
    const high = await handleStateRequest(
      request({ op: "set", key: "niko-buddy-ui-font-size-scale", value: 5 }),
      deps(),
    )
    expect(high.ok).toBe(false)
    expect(high.error).toContain("不得大于")

    const low = await handleStateRequest(
      request({ op: "set", key: "niko-buddy-ui-font-size-scale", value: 0.1 }),
      deps(),
    )
    expect(low.ok).toBe(false)
    expect(low.error).toContain("不得小于")
  })

  it("op=set 数字类型必须是有限数", async () => {
    const res = await handleStateRequest(
      request({ op: "set", key: "niko-buddy-ui-font-size-scale", value: "1.2" }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("有限数字")
  })

  it("op=set 布尔键拒绝字符串", async () => {
    const res = await handleStateRequest(
      request({ op: "set", key: "niko-buddy-focus-mode", value: "1" }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("布尔值")
  })

  it("op=set 写入器抛错时回 error（不静默）", async () => {
    const res = await handleStateRequest(
      request({ op: "set", key: "theme", value: "dark" }),
      deps({
        writeSetting: async () => {
          throw new Error("app-state 写入失败")
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("app-state 写入失败")
  })
})

describe("handleStateRequest — 项目动作（P2）", () => {
  it("pipeline-start 转发参数并回 taskId", async () => {
    const startPipeline = vi.fn(() => ({ ok: true as const, taskId: "ptask_1", stage: "queued" }))
    const res = await handleStateRequest(
      request({ op: "pipeline-start", params: { userRequest: "写一章", chapterNumber: 171 } }),
      deps({ startPipeline }),
    )
    expect(res.ok).toBe(true)
    expect(res.value).toMatchObject({ taskId: "ptask_1", stage: "queued" })
    expect(startPipeline).toHaveBeenCalledWith({ userRequest: "写一章", chapterNumber: 171 })
  })

  it("pipeline-start 的参数错误原样回传（不在桥里改写原因）", async () => {
    const res = await handleStateRequest(
      request({ op: "pipeline-start", params: {} }),
      deps({ startPipeline: () => ({ ok: false as const, error: "需要非空字符串参数 userRequest" }) }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("userRequest")
  })

  it("pipeline-status 缺 taskId 时报错", async () => {
    const res = await handleStateRequest(request({ op: "pipeline-status" }), deps())
    expect(res.ok).toBe(false)
    expect(res.error).toContain("taskId")
  })

  it("pipeline-status 未知 taskId 明确报未知，而不是回空对象", async () => {
    const res = await handleStateRequest(
      request({ op: "pipeline-status", params: { taskId: "ptask_nope" } }),
      deps({ readPipeline: () => null }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未知 taskId")
  })

  it("pipeline-status 回快照", async () => {
    const snapshot = { taskId: "ptask_1", status: "running", stage: "after_draft", startedAt: 1 }
    const res = await handleStateRequest(
      request({ op: "pipeline-status", params: { taskId: "ptask_1" } }),
      deps({ readPipeline: () => snapshot }),
    )
    expect(res.ok).toBe(true)
    expect(res.value).toEqual(snapshot)
  })

  it("draft-write 未打开项目时拒绝", async () => {
    const res = await handleStateRequest(
      request({ op: "draft-write", params: { chapterName: "第一章", content: "正文" } }),
      deps({ readProjectPath: () => "" }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未打开项目")
  })

  it("draft-write 带项目路径转发给草稿写入器", async () => {
    const writeChapterDraft = vi.fn(async () => ({ draftId: "draft_9", chapterName: "第一章" }))
    const res = await handleStateRequest(
      request({ op: "draft-write", params: { chapterName: "第一章", content: "正文" } }),
      deps({ writeChapterDraft }),
    )
    expect(res.ok).toBe(true)
    expect(res.value).toMatchObject({ draftId: "draft_9" })
    expect(writeChapterDraft).toHaveBeenCalledWith("/proj", {
      chapterName: "第一章",
      content: "正文",
    })
  })

  it("formal-path 要求项目，并把 kind 与名字原样转给解析器", async () => {
    const missing = await handleStateRequest(
      request({ op: "formal-path", params: { kind: "chapter", name: "第一章" } }),
      deps({ readProjectPath: () => "" }),
    )
    expect(missing.ok).toBe(false)

    const resolveFormalPath = vi.fn(() => ({ kind: "chapter", path: "/proj/wiki/chapters/第一章.md" }))
    const res = await handleStateRequest(
      request({ op: "formal-path", params: { kind: "chapter", name: "第一章" } }),
      deps({ resolveFormalPath }),
    )
    expect(res.ok).toBe(true)
    expect(resolveFormalPath).toHaveBeenCalledWith("/proj", { kind: "chapter", name: "第一章" })
  })

  it("formal-path 拒绝未知 kind（不猜成章节）", async () => {
    const resolveFormalPath = vi.fn()
    for (const kind of ["", "outline", "memory2", 1]) {
      const res = await handleStateRequest(
        request({ op: "formal-path", params: { kind, name: "x" } }),
        deps({ resolveFormalPath }),
      )
      expect(res.ok).toBe(false)
    }
    expect(resolveFormalPath).not.toHaveBeenCalled()
  })

  it("草稿写入器抛错时转成 error 响应，不伪装成成功", async () => {
    const res = await handleStateRequest(
      request({ op: "draft-write", params: { chapterName: "第一章", content: "正文" } }),
      deps({
        writeChapterDraft: async () => {
          throw new Error("磁盘只读")
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("磁盘只读")
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

  it("op=chapter-list 对中文数字混排按数值排序（第2章 < 第10章）", async () => {
    // 纯字典序会把「第170章」排到「第1章」前面（`7` 的码位小于 `章`），
    // 于是 chapter.read(1) 读到的是第 170 章。真实项目上实测踩到过。
    const res = await handleStateRequest(
      request({ op: "chapter-list" }),
      deps({
        listChapters: async () => [
          { name: "第170章-新灵气契约-2.md", path: "/p/第170章-新灵气契约-2.md" },
          { name: "第2章-租赁.md", path: "/p/第2章-租赁.md" },
          { name: "第10章-天枢.md", path: "/p/第10章-天枢.md" },
          { name: "第1章-赎回.md", path: "/p/第1章-赎回.md" },
        ],
      }),
    )
    expect(res.ok).toBe(true)
    const names = (res.value as { chapters: { name: string }[] }).chapters.map((c) => c.name)
    expect(names).toEqual([
      "第1章-赎回.md",
      "第2章-租赁.md",
      "第10章-天枢.md",
      "第170章-新灵气契约-2.md",
    ])
  })

  it("op=chapter-read 序号取的是数值序的第 n 章，不是字典序", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "1" }),
      deps({
        listChapters: async () => [
          { name: "第170章-新灵气契约-2.md", path: "/p/第170章-新灵气契约-2.md" },
          { name: "第2章-租赁.md", path: "/p/第2章-租赁.md" },
          { name: "第1章-赎回.md", path: "/p/第1章-赎回.md" },
        ],
      }),
    )
    expect(res.ok).toBe(true)
    expect((res.value as { name: string }).name).toBe("第1章-赎回.md")
  })

  it("op=chapter-list 混用命名时按文件名里的章号排序（真实项目回归）", async () => {
    // 真实项目（172 章）既有 chapter-NNN.md 又有 第170章-*.md。WebView2 的默认
    // locale 把「第170章」排在 `chapter-001.md` 前面（数字序和普通序都一样），
    // 只靠 localeCompare 不够，必须提取章号。
    const res = await handleStateRequest(
      request({ op: "chapter-list" }),
      deps({
        listChapters: async () => [
          { name: "第170章-新灵气契约-2.md", path: "/p/第170章-新灵气契约-2.md" },
          { name: "chapter-002.md", path: "/p/chapter-002.md" },
          { name: "第170章-新灵气契约.md", path: "/p/第170章-新灵气契约.md" },
          { name: "chapter-001.md", path: "/p/chapter-001.md" },
        ],
      }),
    )
    expect(res.ok).toBe(true)
    const names = (res.value as { chapters: { name: string }[] }).chapters.map((c) => c.name)
    expect(names).toEqual([
      "chapter-001.md",
      "chapter-002.md",
      "第170章-新灵气契约-2.md",
      "第170章-新灵气契约.md",
    ])
  })

  it("op=chapter-list 无章号的文件排在最后", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-list" }),
      deps({
        listChapters: async () => [
          { name: "appendix.md", path: "/p/appendix.md" },
          { name: "chapter-003.md", path: "/p/chapter-003.md" },
        ],
      }),
    )
    expect(res.ok).toBe(true)
    const names = (res.value as { chapters: { name: string }[] }).chapters.map((c) => c.name)
    expect(names).toEqual(["chapter-003.md", "appendix.md"])
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

// ===== 增补：默认依赖路径 / 空白选择器 / installStateBridge =====
// 覆盖：defaultDeps 各箭头函数（readProjectPath/loadStatus/listChapters/
// readSetting/startPipeline/readPipeline/writeChapterDraft/resolveFormalPath/
// writeSetting）、chapter-read 空白选择器、installStateBridge 全分支。
import { installStateBridge } from "./state-bridge"
import { useWikiStore } from "@/stores/wiki-store"

const tauriInvoke = vi.hoisted(() => vi.fn())
const tauriListen = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriListen }))

describe("handleStateRequest — 默认依赖（无项目）", () => {
  afterEach(() => {
    useWikiStore.getState().setProject(null)
  })

  it("op=project 无项目时经默认依赖报错", async () => {
    useWikiStore.getState().setProject(null)
    const res = await handleStateRequest({ id: "r1", op: "project" })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未打开项目")
  })

  it("op=get 走写入器读 theme，读到 setTheme 写入的值", async () => {
    useWikiStore.getState().setTheme("dark")
    try {
      const res = await handleStateRequest({ id: "r1", op: "get", key: "theme" })
      expect(res.ok).toBe(true)
      expect(res.value).toMatchObject({ key: "theme", value: "dark" })
    } finally {
      useWikiStore.getState().setTheme("system")
    }
  })

  it("op=get 无写入器的 localStorage 键在存储不可读时回 error 而非 null", async () => {
    // 文件级 beforeEach 会 stub window，这里显式还原出“存储不可读”的真实环境。
    vi.unstubAllGlobals()
    const res = await handleStateRequest({ id: "r1", op: "get", key: "lk-graph-edge-style" })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("localStorage 不可读")
  })

  it("op=set 默认写入器落盘 offline-mode 并回 before/after", async () => {
    useWikiStore.getState().setOfflineMode(false)
    try {
      const res = await handleStateRequest({
        id: "r1",
        op: "set",
        key: "niko-buddy-offline-mode",
        value: true,
      })
      expect(res.ok).toBe(true)
      expect(res.value).toMatchObject({
        key: "niko-buddy-offline-mode",
        before: false,
        after: true,
      })
    } finally {
      useWikiStore.getState().setOfflineMode(false)
    }
  })

  it("op=pipeline-start 默认登记器在无项目时拒绝", async () => {
    useWikiStore.getState().setProject(null)
    const res = await handleStateRequest({
      id: "r1",
      op: "pipeline-start",
      params: { userRequest: "写一章" },
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("没有打开的项目")
  })

  it("op=pipeline-status 默认登记器查无任务", async () => {
    const res = await handleStateRequest({
      id: "r1",
      op: "pipeline-status",
      params: { taskId: "ptask_nope" },
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未知 taskId")
  })

  it("op=chapter-read 空白选择器明确报错", async () => {
    const res = await handleStateRequest(request({ op: "chapter-read", path: "   " }), deps())
    expect(res.ok).toBe(false)
    expect(res.error).toContain("需要章节序号或文件名")
  })

  it("op=chapter-read 负 offset/零 limit 被钳制而非崩", async () => {
    const res = await handleStateRequest(
      request({ op: "chapter-read", path: "1", offset: -5, limit: 0 }),
      deps(),
    )
    expect(res.ok).toBe(true)
    const v = res.value as { offset: number; limit: number; content: string }
    expect(v.offset).toBe(0)
    expect(v.limit).toBe(1)
    expect(v.content).toBe("line1")
  })
})

describe("handleStateRequest — 默认依赖（有项目，无真实后端）", () => {
  const proj = { id: "probe-proj", name: "probe", path: "/tmp/qmai-bridge-probe-no-such-dir" }

  beforeEach(() => {
    useWikiStore.getState().setProject(proj)
  })

  afterEach(() => {
    useWikiStore.getState().setProject(null)
  })

  it("op=project-state 状态文件缺失时降级为 null 而非报错", async () => {
    const res = await handleStateRequest({ id: "r1", op: "project-state" })
    expect(res.ok).toBe(true)
    expect(res.value).toMatchObject({ projectPath: proj.path, status: null })
  })

  it("op=chapter-list 后端不可达时回 total 0", async () => {
    const res = await handleStateRequest({ id: "r1", op: "chapter-list" })
    expect(res.ok).toBe(true)
    expect(res.value).toMatchObject({ total: 0, chapters: [] })
  })

  it("op=draft-write 参数缺失时校验先于落盘报错", async () => {
    const res = await handleStateRequest({ id: "r1", op: "draft-write", params: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("chapterName")
  })

  it("op=formal-path 章节名解析为虚拟路径", async () => {
    const res = await handleStateRequest({
      id: "r1",
      op: "formal-path",
      params: { kind: "chapter", name: "第一章" },
    })
    expect(res.ok).toBe(true)
    const v = res.value as { kind: string; path: string }
    expect(v.kind).toBe("chapter")
    expect(v.path).toContain("第一章")
  })
})

describe("installStateBridge", () => {
  const unlisten = vi.fn()

  let captured!: (event: { payload: unknown }) => Promise<void>

  beforeEach(() => {
    tauriInvoke.mockReset()
    tauriListen.mockReset()
    tauriInvoke.mockResolvedValue(undefined)
    tauriListen.mockImplementation(async (_event: unknown, handler: unknown) => {
      captured = handler as (event: { payload: unknown }) => Promise<void>
      return unlisten as unknown as () => void
    })
  })

  it("注册 mcp:state-request 监听并把 schema 结果回传给 Rust", async () => {
    const off = await installStateBridge()
    expect(tauriListen).toHaveBeenCalledWith("mcp:state-request", expect.any(Function))
    expect(off).toBe(unlisten)
    await captured({ payload: { id: "r1", op: "schema" } })
    expect(tauriInvoke).toHaveBeenCalledWith(
      "mcp_state_respond",
      expect.objectContaining({ id: "r1", ok: true, error: null }),
    )
    const arg = tauriInvoke.mock.calls[0][1] as { value: unknown[] }
    expect(Array.isArray(arg.value)).toBe(true)
    expect(arg.value.length).toBe(SETTINGS_CATALOG.length)
  })

  it("缺 id 的请求回 error 响应", async () => {
    await installStateBridge()
    await captured({ payload: { id: "", op: "schema" } })
    expect(tauriInvoke).toHaveBeenCalledWith(
      "mcp_state_respond",
      expect.objectContaining({ id: "", ok: false }),
    )
  })

  it("回传失败时记日志而不抛", async () => {
    tauriInvoke.mockRejectedValue(new Error("rust gone"))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await installStateBridge()
      await captured({ payload: { id: "r1", op: "schema" } })
      expect(err).toHaveBeenCalledWith("[mcp-state-bridge] 回传响应失败", expect.any(Error))
    } finally {
      err.mockRestore()
    }
  })
})

// ===== 增补2：默认 fs 链 + 防御分支（覆盖 144/159/310/328）=====
const writerFault = vi.hoisted(() => ({ validateBomb: false, hideWriterFor: null as string | null }))
const catalogFault = vi.hoisted(() => ({ phantomAllowedKey: null as string | null }))

vi.mock("./settings-writers", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./settings-writers")>()
  return {
    ...orig,
    getWriter: (key: string) => {
      if (writerFault.hideWriterFor === key) return null
      return orig.getWriter(key)
    },
    validateValue: (entry: Parameters<typeof orig.validateValue>[0], value: unknown) => {
      if (writerFault.validateBomb) throw new Error("校验器内部故障")
      return orig.validateValue(entry, value)
    },
  }
})

vi.mock("./settings-catalog", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./settings-catalog")>()
  return {
    ...orig,
    isBridgeAllowedKey: (key: string) =>
      key === catalogFault.phantomAllowedKey || orig.isBridgeAllowedKey(key),
  }
})

describe("handleStateRequest — 默认 fs 链（增补2）", () => {
  const proj = { id: "probe-proj", name: "probe", path: "/tmp/qmai-bridge-probe-no-such-dir" }

  beforeEach(() => {
    useWikiStore.getState().setProject(proj)
  })

  afterEach(() => {
    useWikiStore.getState().setProject(null)
  })

  it("op=chapter-read 默认依赖走真实 fs 命令链：列目录→读文件→分页", async () => {
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_directory") return Promise.resolve([{ name: "chapter-001.md" }])
      if (cmd === "read_file") return Promise.resolve("hello\nworld")
      return Promise.resolve(undefined)
    })
    try {
      const res = await handleStateRequest({ id: "r1", op: "chapter-read", path: "1" })
      expect(res.ok).toBe(true)
      const v = res.value as { name: string; content: string; totalLines: number; truncated: boolean }
      expect(v.name).toBe("chapter-001.md")
      expect(v.content).toBe("hello\nworld")
      expect(v.totalLines).toBe(2)
      expect(v.truncated).toBe(false)
      expect(tauriInvoke).toHaveBeenCalledWith(
        "read_file",
        expect.objectContaining({ path: expect.stringContaining("wiki/chapters/chapter-001.md") }),
      )
    } finally {
      tauriInvoke.mockReset()
    }
  })
})

describe("handleStateRequest — 防御分支（增补2）", () => {
  afterEach(() => {
    writerFault.validateBomb = false
    writerFault.hideWriterFor = null
    catalogFault.phantomAllowedKey = null
    useWikiStore.getState().setProject(null)
  })

  it("校验器抛未知异常时不吞掉，透传为 error", async () => {
    writerFault.validateBomb = true
    const res = await handleStateRequest(request({ op: "set", key: "theme", value: "dark" }), deps())
    expect(res.ok).toBe(false)
    expect(res.error).toContain("校验器内部故障")
  })

  it("默认 writeSetting 无写入器时明确拒绝", async () => {
    writerFault.hideWriterFor = "theme"
    const res = await handleStateRequest({ id: "r1", op: "set", key: "theme", value: "dark" })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("没有注册写入器")
  })

  it("get 白名单与目录不一致时仍拒绝", async () => {
    catalogFault.phantomAllowedKey = "ghost-key"
    const res = await handleStateRequest(request({ key: "ghost-key" }), deps())
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未登记")
  })
})
