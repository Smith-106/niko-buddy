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
  MAX_MECHANICAL_GATE_TEXT_CHARS,
  MAX_OUTLINE_WRITE_CHARS,
  handleStateRequest,
  type StateBridgeDeps,
  type StateRequestPayload,
} from "./state-bridge"
import {
  createContextInspectionCache,
  inspectContext as inspectContextFacade,
  type ContextInspectionDeps,
  type ContextInspectionResult,
  type ContextRuntimeConfig,
} from "./context-inspection"
import { createDirectorPipeline, draftNeedsGateReview, type ChapterDraft, type ContextPack, type DirectorPersistedFile, type WorldBlueprint } from "@/lib/novel"
import { DEFAULT_NOVEL_CONFIG, DEFAULT_RERANK_CONFIG } from "@/stores/wiki-store"

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
    startPipelineBatch: () => ({ ok: false, error: "测试未注入 startPipelineBatch" }),
    startDirectorAdvance: () => ({ ok: false, error: "测试未注入 startDirectorAdvance" }),
    startOutlineGeneration: () => ({ ok: false, error: "测试未注入 startOutlineGeneration" }),
    upsertCharacter: async () => ({ name: "x", role: "supporting", path: "/proj/wiki/entities/characters/x.md" }),
    readPipeline: () => null,
    writeChapterDraft: async () => ({ draftId: "draft_test", chapterName: "x", path: "/proj/d.md", chars: 1 }),
    resolveFormalPath: () => ({ kind: "chapter", path: "/proj/wiki/chapters/x.md" }),
    // 上下文回读：默认给出「未实现」标记，让各用例显式注入自己要验的行为。
    inspectContext: async (input) => {
      await input.recheckChapter?.()
      return { stub: true }
    },
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

  it("pipeline-start-batch 转发整批参数并回多个 taskId", async () => {
    const startPipelineBatch = vi.fn(() => ({
      ok: true as const,
      tasks: [
        { taskId: "ptask_1", chapterNumber: 1 },
        { taskId: "ptask_2", chapterNumber: 2 },
      ],
      started: 2,
    }))
    const requests = [{ userRequest: "写第1章" }, { userRequest: "写第2章", chapterNumber: 2 }]
    const res = await handleStateRequest(
      request({ op: "pipeline-start-batch", params: { requests } }),
      deps({ startPipelineBatch }),
    )
    expect(res.ok).toBe(true)
    expect(res.value).toMatchObject({ started: 2 })
    expect(startPipelineBatch).toHaveBeenCalledWith({ requests })
  })

  it("pipeline-start-batch 整批校验失败时不回半个批次", async () => {
    const res = await handleStateRequest(
      request({ op: "pipeline-start-batch", params: { requests: [{ userRequest: "好的" }, { userRequest: "" }] } }),
      deps({
        startPipelineBatch: () => ({ ok: false as const, error: "requests[1]: 需要非空字符串参数 userRequest" }),
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("requests[1]")
  })

  it("director-advance 转发参数并回 taskId", async () => {
    const startDirectorAdvance = vi.fn(() => ({ ok: true as const, taskId: "ptask_d1", stage: "loading" }))
    const res = await handleStateRequest(
      request({ op: "director-advance", params: { maxPhases: 2, brief: "偏冷硬" } }),
      deps({ startDirectorAdvance }),
    )
    expect(res.ok).toBe(true)
    expect(res.value).toMatchObject({ taskId: "ptask_d1" })
    expect(startDirectorAdvance).toHaveBeenCalledWith({ maxPhases: 2, brief: "偏冷硬" })
  })

  it("director-advance 的拒绝原因原样回传（不在桥里改写）", async () => {
    const res = await handleStateRequest(
      request({ op: "director-advance", params: {} }),
      deps({ startDirectorAdvance: () => ({ ok: false as const, error: "尚未配置模型（缺少 apiKey）" }) }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("apiKey")
  })

  it("outline-generate 转发 prompt 与 multiAgent 开关", async () => {
    const startOutlineGeneration = vi.fn(() => ({ ok: true as const, taskId: "ptask_o1", stage: "generating" }))
    const res = await handleStateRequest(
      request({ op: "outline-generate", params: { prompt: "三卷仙侠", multiAgent: true } }),
      deps({ startOutlineGeneration }),
    )
    expect(res.ok).toBe(true)
    expect(res.value).toMatchObject({ taskId: "ptask_o1" })
    expect(startOutlineGeneration).toHaveBeenCalledWith({ prompt: "三卷仙侠", multiAgent: true })
  })

  it("character-upsert 未打开项目时拒绝", async () => {
    const res = await handleStateRequest(
      request({
        op: "character-upsert",
        params: { name: "甲", role: "protagonist", desire: "复仇", flaw: "多疑" },
      }),
      deps({ readProjectPath: () => "" }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未打开项目")
  })

  it("character-upsert 把项目路径与字段一起交给写入器", async () => {
    const upsertCharacter = vi.fn(async () => ({ name: "甲", role: "protagonist", path: "/proj/wiki/entities/characters/甲.md" }))
    const params = { name: "甲", role: "protagonist", desire: "复仇", flaw: "多疑" }
    const res = await handleStateRequest(
      request({ op: "character-upsert", params }),
      deps({ upsertCharacter }),
    )
    expect(res.ok).toBe(true)
    expect(upsertCharacter).toHaveBeenCalledWith("/proj", params)
  })

  it("character-upsert 写入器抛错时转成 error 响应", async () => {
    const res = await handleStateRequest(
      request({ op: "character-upsert", params: { name: "甲" } }),
      deps({
        upsertCharacter: async () => {
          throw new Error("character.upsert 的 role 只接受 protagonist / antagonist / supporting")
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("role")
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

describe("handleStateRequest — context-inspect", () => {
  it("缺 params.chapter 时显式报错（不开放任意路径）", async () => {
    const res = await handleStateRequest(request({ op: "context-inspect" }), deps())
    expect(res.ok).toBe(false)
    expect(res.error).toContain("params.chapter")
  })

  it("未打开项目时明确报错", async () => {
    const res = await handleStateRequest(
      request({ op: "context-inspect", params: { chapter: "1" } }),
      deps({ readProjectPath: () => "" }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未打开项目")
  })

  it("项目下没有章节文件时明确报错", async () => {
    const res = await handleStateRequest(
      request({ op: "context-inspect", params: { chapter: "1" } }),
      deps({ listChapters: async () => [] }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("没有章节文件")
  })

  it("序号选择器解析成精确条目（index/number/name/path）后交给门面", async () => {
    const seen: unknown[] = []
    const res = await handleStateRequest(
      request({ op: "context-inspect", params: { chapter: "2", includePack: false, inspectionId: "batch-test" } }),
      deps({
        inspectContext: async (input) => {
          await input.recheckChapter?.()
          seen.push(input)
          return { ok: "from-inspection" }
        },
      }),
    )
    expect(res.ok).toBe(true)
    expect(res.value).toEqual({ ok: "from-inspection" })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      recheckChapter: expect.any(Function),
      projectPath: "/proj",
      chapter: {
        index: 2,
        number: 2,
        name: "chapter-002.md",
        path: "/proj/wiki/chapters/chapter-002.md",
      },
      params: { chapter: "2", includePack: false, inspectionId: "batch-test" },
    })
  })

  it("文件名选择器同样解析（含中文命名里的章号）", async () => {
    const seen: { chapter: { index: number; number: number } }[] = []
    const res = await handleStateRequest(
      request({ op: "context-inspect", params: { chapter: "第170章-新灵气契约.md" } }),
      deps({
        listChapters: async () => [
          { name: "第170章-新灵气契约.md", path: "/p/第170章-新灵气契约.md" },
          { name: "chapter-001.md", path: "/p/chapter-001.md" },
        ],
        inspectContext: async (input) => {
          await input.recheckChapter?.()
          seen.push(input as { chapter: { index: number; number: number } })
          return null
        },
      }),
    )
    expect(res.ok).toBe(true)
    expect(seen[0].chapter).toMatchObject({ index: 2, number: 170 })
  })

  it("未知章节选择器拒绝", async () => {
    const res = await handleStateRequest(
      request({ op: "context-inspect", params: { chapter: "chapter-999.md" } }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("找不到章节文件")
  })

  it("越界序号拒绝", async () => {
    const res = await handleStateRequest(
      request({ op: "context-inspect", params: { chapter: "9" } }),
      deps(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("越界")
  })

  it("门面抛错时回 ok:false + 原因（不静默）", async () => {
    const res = await handleStateRequest(
      request({ op: "context-inspect", params: { chapter: "1", dimension: "thril" } }),
      deps({
        inspectContext: async () => {
          throw new Error("dimension 非法：thril")
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("dimension 非法")
  })

  it("项目在回读期间被切换 → 拒绝（不返回混合快照）", async () => {
    let reads = 0
    const res = await handleStateRequest(
      request({ op: "context-inspect", params: { chapter: "1" } }),
      deps({
        readProjectPath: () => {
          reads += 1
          return reads === 1 ? "/proj" : "/another-project"
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("项目在回读期间发生变化")
  })

  it("章节集合在回读期间变化（同名序号指向别的文件）→ 拒绝", async () => {
    let calls = 0
    const res = await handleStateRequest(
      request({ op: "context-inspect", params: { chapter: "1" } }),
      deps({
        listChapters: async () => {
          calls += 1
          return calls === 1
            ? [
                { name: "chapter-001.md", path: "/p/chapter-001.md" },
                { name: "chapter-002.md", path: "/p/chapter-002.md" },
              ]
            : [
                { name: "chapter-000.md", path: "/p/chapter-000.md" },
                { name: "chapter-001.md", path: "/p/chapter-001.md" },
              ]
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain("章节在回读期间发生变化")
  })

  it("最后的 listChapters await 期间切换项目仍拒绝", async () => {
    let projectPath = "/proj"
    let lists = 0
    const res = await handleStateRequest(
      request({ op: "context-inspect", params: { chapter: "1" } }),
      deps({
        readProjectPath: () => projectPath,
        listChapters: async () => {
          await Promise.resolve()
          if (++lists === 2) projectPath = "/another-project"
          return [{ name: "chapter-001.md", path: "/p/chapter-001.md" }]
        },
      }),
    )
    expect(lists).toBe(2)
    expect(res.ok).toBe(false)
    expect(res.error).toContain("项目在回读期间发生变化")
  })

  it.each(["insert", "remove-before", "delete-selected", "rename", "renumber"])(
    "文件名选择器的 %s 漂移拒绝，路径相同也不接受过期序号",
    async (change) => {
      const first = [
        { name: "chapter-001.md", path: "/p/chapter-001.md" },
        { name: "chapter-002.md", path: "/p/chapter-002.md" },
      ]
      const changed = change === "insert"
        ? [{ name: "chapter-000.md", path: "/p/chapter-000.md" }, ...first]
        : change === "remove-before"
          ? [first[1]]
          : change === "delete-selected"
            ? [first[0]]
            : [first[0], { ...first[1], name: change === "rename" ? "chapter-002-renamed.md" : "chapter-004.md" }]
      let lists = 0
      const res = await handleStateRequest(
        request({ op: "context-inspect", params: { chapter: "chapter-002.md" } }),
        deps({ listChapters: async () => ++lists === 1 ? first : changed }),
      )
      expect(lists).toBe(2)
      expect(res.ok).toBe(false)
      expect(res.error).toContain("章节在回读期间发生变化")
    },
  )
})

function deferredValue<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** 真正 facade 的可控 IO；桥仍使用实际 selectChapter 与回调接线。 */
function facadeFixture() {
  const config: ContextRuntimeConfig = {
    novelMode: true,
    novelConfig: { ...DEFAULT_NOVEL_CONFIG },
    llmConfig: { provider: "openai", apiKey: "TEST-PRIVATE-M5", model: "fixture",
      ollamaUrl: "", customEndpoint: "", maxContextSize: 128_000 },
    embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "fixture" },
    rerankConfig: { ...DEFAULT_RERANK_CONFIG },
    revisionFeedbackWindowConfig: { currentChapterIncludeShouldImprove: true,
      previousChapterCarryEnabled: true, lookbackChapterCount: 2, lookbackIncludeMustFixOnly: false },
  }
  const pack: ContextPack = {
    task: "六维审查第1章", chapterGoal: "", outline: "本章章纲", recentSummaries: [],
    previousChapterEnding: "", characterStates: "", soulDoc: "", characterAuras: "",
    cognitionStates: "", foreshadowingStates: "", timeline: "", relatedSettings: "",
    canonRules: "", writingStyle: "", searchResults: "", graphSearchResults: "", mustDo: "",
    mustAvoid: "", nextChapterAdvice: "", revisionDirectives: "",
  }
  const state = { projectPath: "/proj", chapterText: "原始章节正文", config, textReads: 0, builds: 0, goldLoads: 0 }
  const facadeDeps: ContextInspectionDeps = {
    readProjectPath: () => state.projectPath,
    readFileText: async () => { state.textReads += 1; return state.chapterText },
    readRuntimeConfig: () => state.config,
    buildContextPack: async () => { state.builds += 1; return pack },
    loadGoldMaterials: async () => { state.goldLoads += 1; return { anchors: [], exemplars: [], merged: [] } },
    inspectionCache: createContextInspectionCache(),
    now: () => 0,
  }
  return { state, facadeDeps }
}

const finalDirectoryCases = (["metadata", "fresh", "cache"] as const).flatMap((mode) =>
  (["config-public", "config-private", "body", "chapter"] as const).map((drift) => ({ mode, drift })),
)

describe("context-inspect — 最后目录 await 与真正 facade 的终检顺序", () => {
  it.each(finalDirectoryCases)("$mode / $drift：deferred 目录之后仍拒绝漂移", async ({ mode, drift }) => {
    const { state, facadeDeps } = facadeFixture()
    const chapters = [{ name: "chapter-001.md", path: "/proj/wiki/chapters/chapter-001.md" }]
    const lastDirectory = deferredValue<typeof chapters>()
    const directoryStarted = deferredValue<void>()
    let gateEnabled = false
    let entered = false
    let lists = 0
    const bridgeDeps = deps({
      readProjectPath: () => state.projectPath,
      listChapters: async () => {
        lists += 1
        if (gateEnabled && lists === 2) {
          entered = true
          directoryStarted.resolve(undefined)
          return await lastDirectory.promise
        }
        return chapters
      },
      // 不用跳过 callback 的 stub：这就是生产 facade 加可控 IO 的实际接线。
      inspectContext: (input) => inspectContextFacade(input, facadeDeps),
    })
    let inspectionId: string | undefined
    if (mode === "cache") {
      const seed = await handleStateRequest(request({ op: "context-inspect",
        params: { chapter: "chapter-001.md", includePack: true } }), bridgeDeps)
      expect(seed.ok).toBe(true)
      inspectionId = (seed.value as ContextInspectionResult).inspectionId
      if (!inspectionId) throw new Error("cache seed 缺少 inspectionId")
    }
    lists = 0
    gateEnabled = true
    const params = mode === "metadata" ? { chapter: "chapter-001.md" }
      : { chapter: "chapter-001.md", inspectionId, includePack: true, dimension: "pull" }
    const pending = handleStateRequest(request({ op: "context-inspect", params }), bridgeDeps)
    await Promise.race([directoryStarted.promise, pending.then(() => {
      if (!entered) throw new Error("最终目录 callback 未执行就返回了响应")
    })])
    const readsAtDirectory = state.textReads
    const buildsAtDirectory = state.builds
    const goldAtDirectory = state.goldLoads
    if (drift === "config-public") state.config.novelConfig.chapterTargetChars += 1
    if (drift === "config-private") state.config.llmConfig.apiKey = "TEST-PRIVATE-M5-ROTATED"
    if (drift === "body") state.chapterText += "\n最后目录 await 期间改写"
    lastDirectory.resolve(drift === "chapter"
      ? [{ name: "chapter-000.md", path: "/proj/wiki/chapters/chapter-000.md" }, ...chapters]
      : chapters)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(drift.startsWith("config") ? /生效配置/ : drift === "body" ? /章节正文/ : /章节在回读期间发生变化/)
    expect(result.value).toBeUndefined()
    expect(lists).toBe(2)
    // 身份 callback 拒绝时不再读正文；其他漂移必须在目录完成后再读正文终检。
    expect(state.textReads).toBe(readsAtDirectory + (drift === "chapter" ? 0 : 1))
    expect(state.builds).toBe(mode === "metadata" ? 0 : 1)
    expect(state.goldLoads).toBe(mode === "metadata" ? 0 : 1)
    expect(state.builds).toBe(buildsAtDirectory)
    expect(state.goldLoads).toBe(goldAtDirectory)
    expect(facadeDeps.inspectionCache?.size).toBe(0)
    expect(JSON.stringify(result)).not.toContain("TEST-PRIVATE-M5-ROTATED")
    if (inspectionId) {
      gateEnabled = false
      const retry = await handleStateRequest(request({ op: "context-inspect",
        params: { chapter: "chapter-001.md", inspectionId, includePack: true } }), bridgeDeps)
      expect(retry.ok).toBe(false)
      expect(retry.error).toMatch(/inspectionId 未知或已失效/)
      expect(state.builds).toBe(1)
      expect(state.goldLoads).toBe(1)
    }
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

describe("handleStateRequest — context-inspect-start / poll 异步慢构建路径", () => {
  it("start 立即返回 running + jobId，完成后 poll 返回完整结果", async () => {
    const deferred = deferredValue<unknown>()
    const testDeps = deps({
      inspectContext: async (input) => {
        await input.recheckChapter?.()
        return await deferred.promise
      },
    })

    const started = await handleStateRequest(
      request({ op: "context-inspect-start", params: { chapter: "1", includePack: true } }),
      testDeps,
    )
    expect(started.ok).toBe(true)
    const startVal = started.value as { status: string; jobId: string }
    expect(startVal.status).toBe("running")
    expect(startVal.jobId).toMatch(/^cinspect_/)

    const runningPoll = await handleStateRequest(
      request({ op: "context-inspect-poll", params: { jobId: startVal.jobId } }),
      testDeps,
    )
    expect(runningPoll).toEqual({ ok: true, value: { status: "running", jobId: startVal.jobId } })

    deferred.resolve({ inspectionId: "insp-async-1", contextPackBuilt: true })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const donePoll = await handleStateRequest(
      request({ op: "context-inspect-poll", params: { jobId: startVal.jobId } }),
      testDeps,
    )
    expect(donePoll).toEqual({
      ok: true,
      value: {
        status: "done",
        jobId: startVal.jobId,
        value: { inspectionId: "insp-async-1", contextPackBuilt: true },
      },
    })
  })

  it("后台任务抛错时 poll 明确回 failed + error 文本", async () => {
    const started = await handleStateRequest(
      request({ op: "context-inspect-start", params: { chapter: "1", includePack: true } }),
      deps({
        inspectContext: async () => {
          throw new Error("需要检索网络授权")
        },
      }),
    )
    expect(started.ok).toBe(true)
    const { jobId } = started.value as { jobId: string }
    await new Promise<void>((resolve) => setImmediate(resolve))

    const failedPoll = await handleStateRequest(
      request({ op: "context-inspect-poll", params: { jobId } }),
      deps(),
    )
    expect(failedPoll).toEqual({
      ok: true,
      value: { status: "failed", jobId, error: "需要检索网络授权" },
    })
  })

  it("在途 inspect 任务达上限时拒绝新任务，释放后可再起", async () => {
    const deferred = deferredValue<unknown>()
    const inspectCalls: unknown[] = []
    const testDeps = deps({
      inspectContext: async (input) => {
        inspectCalls.push(input)
        return await deferred.promise
      },
    })

    // 16 个 running 任务把 MAX_INSPECT_JOBS 占满。
    const jobIds: string[] = []
    for (let i = 0; i < 16; i++) {
      const started = await handleStateRequest(
        request({ op: "context-inspect-start", params: { chapter: "1", includePack: true } }),
        testDeps,
      )
      expect(started.ok).toBe(true)
      jobIds.push((started.value as { jobId: string }).jobId)
    }
    expect(inspectCalls).toHaveLength(16)

    // 第 17 个：容量拒绝，不再触发新的 inspect 调用。
    const overflow = await handleStateRequest(
      request({ op: "context-inspect-start", params: { chapter: "17", includePack: true } }),
      testDeps,
    )
    expect(overflow.ok).toBe(false)
    expect(inspectCalls).toHaveLength(16)

    // 释放一个任务（完成）后，新任务可以再起。
    deferred.resolve({ inspectionId: "done" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const admitted = await handleStateRequest(
      request({ op: "context-inspect-start", params: { chapter: "1", includePack: true } }),
      testDeps,
    )
    expect(admitted.ok).toBe(true)
    expect(inspectCalls).toHaveLength(17)
  })

  it("poll 缺 jobId 或未知 jobId（含前端重载丢失）立即报错", async () => {
    const missingParam = await handleStateRequest(
      request({ op: "context-inspect-poll", params: {} }),
      deps(),
    )
    expect(missingParam.ok).toBe(false)
    expect(missingParam.error).toContain("params.jobId")

    const unknownJob = await handleStateRequest(
      request({ op: "context-inspect-poll", params: { jobId: "cinspect_missing" } }),
      deps(),
    )
    expect(unknownJob.ok).toBe(false)
    expect(unknownJob.error).toContain("未知 context-inspect 任务")
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

describe("handleStateRequest — B3 新增 op（draft-list / draft-read / rules-get / gate-check-mechanical / onDraftWritten / 路径遍历防护）", () => {
  const sampleDrafts: ChapterDraft[] = [
    {
      id: "draft_old_1",
      chapterName: "第1章-启程",
      content: "旧草稿第一行\n旧草稿第二行\n旧草稿第三行",
      createdAt: 1_700_000_100_000,
      status: "draft",
      sourceConversationId: "mcp:chapter.write",
    },
    {
      id: "draft_new_2",
      chapterName: "第2章-夜雨",
      content: "新草稿正文L1\n新草稿正文L2\n新草稿正文L3\n新草稿正文L4",
      createdAt: 1_700_000_200_000,
      status: "draft",
      partial: true,
      adoptionGate: { status: "partial" },
      sourceConversationId: "mcp:deep-chapter",
    },
  ]

  afterEach(() => {
    useWikiStore.getState().setProject(null)
    tauriInvoke.mockReset()
  })

  it("draft-write 成功时触发 onDraftWritten，失败时不触发", async () => {
    const onDraftWritten = vi.fn()
    const okRes = await handleStateRequest(
      request({ op: "draft-write", params: { chapterName: "第3章", content: "正文" } }),
      deps({ onDraftWritten }),
    )
    expect(okRes.ok).toBe(true)
    expect(onDraftWritten).toHaveBeenCalledTimes(1)

    const failRes = await handleStateRequest(
      request({ op: "draft-write", params: { chapterName: "第3章", content: "正文" } }),
      deps({
        onDraftWritten,
        writeChapterDraft: async () => {
          throw new Error("写盘失败")
        },
      }),
    )
    expect(failRes.ok).toBe(false)
    expect(onDraftWritten).toHaveBeenCalledTimes(1)
  })

  it("chapter-read 与 context-inspect 拒绝路径分隔符与 .. 遍历", async () => {
    for (const malicious of ["../secret.md", "sub/chapter-001.md", "..\\secret.md", "chapter\0.md", ".."]) {
      const chRes = await handleStateRequest(request({ op: "chapter-read", path: malicious }), deps())
      expect(chRes.ok).toBe(false)
      expect(chRes.error).toContain("非法章节选择器")

      const ctxRes = await handleStateRequest(
        request({ op: "context-inspect", params: { chapter: malicious } }),
        deps(),
      )
      expect(ctxRes.ok).toBe(false)
      expect(ctxRes.error).toContain("非法章节选择器")
    }
  })

  it("draft-list 按 createdAt 倒序返回元信息摘要，绝不返回正文 content", async () => {
    const res = await handleStateRequest(
      request({ op: "draft-list", params: {} }),
      deps({ listDrafts: async () => sampleDrafts }),
    )
    expect(res.ok).toBe(true)
    const val = res.value as {
      projectPath: string
      total: number
      drafts: Array<Record<string, unknown>>
    }
    expect(val.total).toBe(2)
    expect(val.drafts.map((d) => d.draftId)).toEqual(["draft_new_2", "draft_old_1"])
    expect(val.drafts[0]).toMatchObject({
      draftId: "draft_new_2",
      chapterName: "第2章-夜雨",
      chapterNumber: 2,
      partial: true,
      gateStatus: "partial",
      needsGateReview: true,
    })
    for (const d of val.drafts) {
      expect("content" in d).toBe(false)
    }
    expect(JSON.stringify(res.value)).not.toContain("新草稿正文L1")
    expect(JSON.stringify(res.value)).not.toContain("旧草稿第一行")
  })

  it("draft-read 仅匹配枚举列表（零直接路径读取），支持 0-based offset/limit 切片与全文 bodySha256", async () => {
    const readFileText = vi.fn(async () => "不应被直接调用")
    const res = await handleStateRequest(
      request({ op: "draft-read", params: { draftId: "draft_new_2", offset: 1, limit: 2 } }),
      deps({ listDrafts: async () => sampleDrafts, readFileText }),
    )
    expect(res.ok).toBe(true)
    expect(readFileText).not.toHaveBeenCalled()
    const val = res.value as {
      draftId: string
      content: string
      offset: number
      limit: number
      totalLines: number
      truncated: boolean
      bodySha256: string
    }
    expect(val.draftId).toBe("draft_new_2")
    expect(val.offset).toBe(1)
    expect(val.limit).toBe(2)
    expect(val.totalLines).toBe(4)
    expect(val.truncated).toBe(true)
    expect(val.content).toBe("新草稿正文L2\n新草稿正文L3")
    expect(val.bodySha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("draft-read 拒绝路径遍历 / 非法 draftId 与未知 draftId", async () => {
    const listDrafts = vi.fn(async () => sampleDrafts)
    for (const badId of ["../etc/passwd", "a/b", "a\\b", "draft_1.md", "", "a".repeat(129)]) {
      const res = await handleStateRequest(
        request({ op: "draft-read", params: { draftId: badId } }),
        deps({ listDrafts }),
      )
      expect(res.ok).toBe(false)
    }
    expect(listDrafts).not.toHaveBeenCalled()

    const missing = await handleStateRequest(
      request({ op: "draft-read", params: { draftId: "draft_not_found" } }),
      deps({ listDrafts }),
    )
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain("找不到草稿")
  })

  it("rules-get 严格只读（零磁盘写）、零凭据泄漏、支持 legacy de-ai 与 book-rules 回退", async () => {
    const prevLlm = useWikiStore.getState().llmConfig
    const prevProviders = useWikiStore.getState().providerConfigs
    const prevNovel = useWikiStore.getState().novelConfig
    useWikiStore.getState().setLlmConfig({
      ...prevLlm,
      apiKey: "SECRET-LLM-KEY-SHOULD-NEVER-LEAK",
      customEndpoint: "https://secret.internal.example/v1?token=TOPSECRET",
    })
    useWikiStore.getState().setProviderConfigs({
      openai: { apiKey: "SECRET-PROVIDER-OVERRIDE-KEY", baseUrl: "https://private.provider" },
    })
    useWikiStore.getState().setNovelConfig({ genre: "悬疑", chapterTargetChars: 2800 })

    const files = new Map<string, string>([
      ["/proj/soul.md", "# 项目灵魂\n克制、悬疑"],
      ["/proj/de-ai-skills.json", JSON.stringify({
        version: 1,
        defaultSkillId: "project:custom-1",
        disabledSkillIds: [],
        projectSkills: [
          {
            id: "project:custom-1",
            name: "项目定制去AI味",
            description: "来自旧根路径",
            templateId: "custom",
            content: "删总结腔",
            source: "project",
          },
        ],
        builtInSkillOverrides: [],
        lastChapterDeAiSkillId: null,
      })],
      ["/proj/.novel/book-rules.json", JSON.stringify({
        version: "1.0",
        prohibitions: ["现代热梗"],
        allowedDeviations: [],
      })],
      ["/proj/.novel/user-memory.json", JSON.stringify({
        version: "user-memory/1.0",
        preferences: [{ id: "u1", key: "avoid_words_1", value: "陡然, 骤然", category: "vocabulary", createdAt: "", updatedAt: "" }],
        deAiWeights: { categoryBoosts: {}, severityThreshold: "medium", genreOverrides: {} },
        reviewCalibration: { dimensionWeights: {}, severityDeductions: {} },
        updatedAt: "",
      })],
    ])

    try {
      const res = await handleStateRequest(
        request({ op: "rules-get", params: {} }),
        deps({
          readFileText: async (path) => {
            if (files.has(path)) return files.get(path)!
            throw new Error(`ENOENT: ${path}`)
          },
        }),
      )
      expect(res.ok).toBe(true)
      const serialized = JSON.stringify(res.value)
      // 严禁任何密钥/端点/providerConfigs 泄漏
      expect(serialized).not.toContain("SECRET-LLM-KEY-SHOULD-NEVER-LEAK")
      expect(serialized).not.toContain("TOPSECRET")
      expect(serialized).not.toContain("SECRET-PROVIDER-OVERRIDE-KEY")
      expect(serialized).not.toContain("private.provider")
      // 严禁触发任何 Tauri 写盘命令（特别是 legacy de-ai-skills.json 不得惰性迁移写盘！）
      expect(tauriInvoke).not.toHaveBeenCalled()

      const val = res.value as {
        sections: string[]
        writingStyle: { soulDoc: string; genre: string }
        antiAi: { configSource: string; effectiveSkill: { id: string } | null; avoidWords: string[] }
        bookRules: { loaded: boolean; rules: { prohibitions: string[] } }
        planning: { novelMode: boolean }
      }
      expect(val.sections).toEqual(["writingStyle", "antiAi", "bookRules", "planning"])
      expect(val.writingStyle.soulDoc).toContain("克制、悬疑")
      expect(val.writingStyle.genre).toBe("悬疑")
      expect(val.antiAi.configSource).toBe("legacy_json")
      expect(val.antiAi.effectiveSkill?.id).toBe("project:custom-1")
      expect(val.antiAi.avoidWords).toEqual(["陡然", "骤然"])
      expect(val.bookRules.loaded).toBe(true)
      expect(val.bookRules.rules.prohibitions).toEqual(["现代热梗"])

      // 按需过滤 sections & 校验非法 sections
      const partial = await handleStateRequest(
        request({ op: "rules-get", params: { sections: ["bookRules"] } }),
        deps({ readFileText: async () => { throw new Error("ENOENT") } }),
      )
      expect(partial.ok).toBe(true)
      const pVal = partial.value as Record<string, unknown>
      expect(pVal.bookRules).toBeDefined()
      expect(pVal.antiAi).toBeUndefined()
      expect((pVal.bookRules as { loaded: boolean; rules: { prohibitions: string[] } }).loaded).toBe(false)
      expect((pVal.bookRules as { rules: { prohibitions: string[] } }).rules.prohibitions).toEqual([])

      const invalidSec = await handleStateRequest(
        request({ op: "rules-get", params: { sections: ["secrets"] } }),
        deps(),
      )
      expect(invalidSec.ok).toBe(false)
      expect(invalidSec.error).toContain("不支持的 section")
    } finally {
      useWikiStore.getState().setLlmConfig(prevLlm)
      useWikiStore.getState().setProviderConfigs(prevProviders)
      useWikiStore.getState().setNovelConfig(prevNovel)
    }
  })

  it("gate-check-mechanical 严格执行 1-of-3 校验、100000 字符上限与路径遍历拒绝", async () => {
    // 0 个目标 -> 拒绝
    const none = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: {} }),
      deps(),
    )
    expect(none.ok).toBe(false)
    expect(none.error).toContain("三者之一")

    // >1 个目标 -> 拒绝
    const two = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { draftId: "draft_old_1", text: "正文" } }),
      deps(),
    )
    expect(two.ok).toBe(false)
    expect(two.error).toContain("1-of-3")

    const allThree = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { draftId: "draft_old_1", chapter: "1", text: "正文" } }),
      deps(),
    )
    expect(allThree.ok).toBe(false)
    expect(allThree.error).toContain("1-of-3")

    // 超 100_000 字符 -> 拒绝
    const tooLong = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { text: "甲".repeat(MAX_MECHANICAL_GATE_TEXT_CHARS + 1) } }),
      deps(),
    )
    expect(tooLong.ok).toBe(false)
    expect(tooLong.error).toContain("超过上限")

    // 路径遍历 draftId / chapter -> 拒绝
    const badDraft = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { draftId: "../evil" } }),
      deps(),
    )
    expect(badDraft.ok).toBe(false)

    const badChapter = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { chapter: "../evil.md" } }),
      deps(),
    )
    expect(badChapter.ok).toBe(false)
    expect(badChapter.error).toContain("非法章节选择器")

    // 合法 text / draftId / chapter 三路径分别透传并回机械报告
    const seenInputs: unknown[] = []
    const stubReport = {
      mechanicalOnly: true as const,
      semanticReviewCompleted: false as const,
      verdict: "mechanical_pass_pending_semantic" as const,
      blockingGate: null,
      chapterNumber: 2,
      genre: "悬疑",
      gates: {
        consistency: { priority: "P0" as const, status: "mechanical_passed_pending_semantic" as const, verdict: "pending" as const, errorCount: 0, warningCount: 0, infoCount: 0, issues: [] },
        anti_ai: { priority: "P1" as const, status: "mechanical_passed_pending_semantic" as const, verdict: "pending" as const, errorCount: 0, warningCount: 0, infoCount: 0, issues: [] },
        quality: { priority: "P2" as const, status: "pending" as const, verdict: "pending" as const, note: "pending" },
      },
    }
    const runMechanicalGate = vi.fn(async (input) => {
      seenInputs.push(input)
      return stubReport as never
    })

    const byDraft = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { draftId: "draft_new_2", genre: "悬疑" } }),
      deps({ listDrafts: async () => sampleDrafts, runMechanicalGate }),
    )
    expect(byDraft.ok).toBe(true)
    expect(byDraft.value).toMatchObject({
      mechanicalOnly: true,
      semanticReviewCompleted: false,
      verdict: "mechanical_pass_pending_semantic",
      target: { kind: "draft", draftId: "draft_new_2" },
    })
    expect(seenInputs[0]).toMatchObject({ projectPath: "/proj", chapterNumber: 2, genre: "悬疑" })

    const byChapter = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { chapter: "2" } }),
      deps({ runMechanicalGate }),
    )
    expect(byChapter.ok).toBe(true)
    expect(seenInputs[1]).toMatchObject({ projectPath: "/proj", chapterNumber: 2, text: "line1\nline2\nline3\nline4\nline5" })

    const byText = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { text: "一段测试正文", chapterNumber: 9 } }),
      deps({ runMechanicalGate }),
    )
    expect(byText.ok).toBe(true)
    expect(seenInputs[2]).toMatchObject({ projectPath: "/proj", chapterNumber: 9, text: "一段测试正文" })
  })
})

describe("handleStateRequest — R2-B3（诚实草稿元数据 / context-prepare / kind 隔离 / director-check / outline-write）", () => {
  afterEach(() => {
    useWikiStore.getState().setProject(null)
    tauriInvoke.mockReset()
  })

  it("summarizeDraftMetadata 诚实报告 adoptionGated，且无采纳门回执的 mcp:chapter.write 与 acp:* 草稿返回 gateStatus=unassessed 与 needsGateReview=false（零死锁）", async () => {
    const acpUngatedDraft: ChapterDraft = {
      id: "draft_acp_ungated",
      chapterName: "第4章-风暴",
      content: "通过 Antigravity ACP 面板保存的草稿正文",
      createdAt: 1_700_000_400_000,
      status: "draft",
      sourceConversationId: "acp:sess-1",
    }
    // 零 API Key 可直接采纳：draftNeedsGateReview 恒为 false，不死锁 acceptChapterDraft
    expect(draftNeedsGateReview(acpUngatedDraft)).toBe(false)

    const drafts: ChapterDraft[] = [
      acpUngatedDraft,
      {
        id: "draft_mcp_ungated",
        chapterName: "第1章-启程",
        content: "外部 Agent 通过 chapter.write 写入的草稿正文",
        createdAt: 1_700_000_300_000,
        status: "draft",
        sourceConversationId: "mcp:chapter.write",
      },
      {
        id: "draft_mcp_partial",
        chapterName: "第2章-残篇",
        content: "截断草稿",
        createdAt: 1_700_000_200_000,
        status: "draft",
        partial: true,
        sourceConversationId: "mcp:chapter.write",
      },
      {
        id: "draft_deep_passed",
        chapterName: "第3章-过门",
        content: "已过门草稿",
        createdAt: 1_700_000_100_000,
        status: "draft",
        adoptionGate: { status: "passed", bodySha256: "a".repeat(64) },
        sourceConversationId: "mcp:deep-chapter",
      },
    ]

    const res = await handleStateRequest(
      request({ op: "draft-list", params: {} }),
      deps({ listDrafts: async () => drafts }),
    )
    expect(res.ok).toBe(true)
    const list = (res.value as { drafts: Array<Record<string, unknown>> }).drafts
    expect(list[0]).toMatchObject({
      draftId: "draft_acp_ungated",
      adoptionGated: false,
      gateStatus: "unassessed",
      needsGateReview: false,
      sourceConversationId: "acp:sess-1",
    })
    expect(list[1]).toMatchObject({
      draftId: "draft_mcp_ungated",
      adoptionGated: false,
      gateStatus: "unassessed",
      needsGateReview: false,
    })
    expect(list[2]).toMatchObject({
      draftId: "draft_mcp_partial",
      adoptionGated: true,
      gateStatus: "partial",
      needsGateReview: true,
    })
    expect(list[3]).toMatchObject({
      draftId: "draft_deep_passed",
      adoptionGated: true,
      gateStatus: "passed",
      needsGateReview: false,
    })
  })

  it("context-prepare-start / poll 正常异步完结，且与 context-inspect 严格按 kind 隔离（拒绝跨 kind jobId）", async () => {
    const prepDeferred = deferredValue<unknown>()
    const inspectDeferred = deferredValue<unknown>()
    const bridgeDeps = deps({
      prepareWriteContext: async () => await prepDeferred.promise,
      inspectContext: async (input) => {
        await input.recheckChapter?.()
        return await inspectDeferred.promise
      },
    })

    // 参数错误在 start 阶段即同步拒绝
    const badStart = await handleStateRequest(
      request({ op: "context-prepare-start", params: { dimension: "thril" } }),
      bridgeDeps,
    )
    expect(badStart.ok).toBe(false)
    expect(badStart.error).toContain("dimension")

    const prepStart = await handleStateRequest(
      request({ op: "context-prepare-start", params: { targetChapter: 2 } }),
      bridgeDeps,
    )
    expect(prepStart.ok).toBe(true)
    const prepJobId = (prepStart.value as { jobId: string }).jobId
    expect(prepJobId).toMatch(/^cprepare_/)

    const inspectStart = await handleStateRequest(
      request({ op: "context-inspect-start", params: { chapter: "1" } }),
      bridgeDeps,
    )
    expect(inspectStart.ok).toBe(true)
    const inspectJobId = (inspectStart.value as { jobId: string }).jobId
    expect(inspectJobId).toMatch(/^cinspect_/)

    // 跨 kind 轮询严格拒绝
    const crossInspect = await handleStateRequest(
      request({ op: "context-inspect-poll", params: { jobId: prepJobId } }),
      bridgeDeps,
    )
    expect(crossInspect.ok).toBe(false)
    expect(crossInspect.error).toContain("任务类型不匹配")

    const crossPrepare = await handleStateRequest(
      request({ op: "context-prepare-poll", params: { jobId: inspectJobId } }),
      bridgeDeps,
    )
    expect(crossPrepare.ok).toBe(false)
    expect(crossPrepare.error).toContain("任务类型不匹配")

    // 同 kind 轮询 running → done
    const runningPoll = await handleStateRequest(
      request({ op: "context-prepare-poll", params: { jobId: prepJobId } }),
      bridgeDeps,
    )
    expect(runningPoll).toEqual({ ok: true, value: { status: "running", jobId: prepJobId } })

    prepDeferred.resolve({ mode: "next_chapter", targetChapter: 2 })
    inspectDeferred.resolve({ ok: true })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const donePoll = await handleStateRequest(
      request({ op: "context-prepare-poll", params: { jobId: prepJobId } }),
      bridgeDeps,
    )
    expect(donePoll).toEqual({
      ok: true,
      value: { status: "done", jobId: prepJobId, value: { mode: "next_chapter", targetChapter: 2 } },
    })
  })

  it("director-check 严格拒绝非空 params，零 LLM 零写盘聚合导演状态与缺口/推进探针", async () => {
    const badParams = await handleStateRequest(
      request({ op: "director-check", params: { force: true } }),
      deps(),
    )
    expect(badParams.ok).toBe(false)
    expect(badParams.error).toContain("不接受参数")

    const persistedBlocked: DirectorPersistedFile = {
      fileVersion: 1,
      state: createDirectorPipeline(),
      ideaInput: { title: "雾港旧案", genre: "悬疑", coreConflict: "" },
    }
    const incompleteBp: WorldBlueprint = {
      version: "1.0",
      worldType: "mystery",
      layers: { axioms: ["现实逻辑"] },
    }
    const blockedRes = await handleStateRequest(
      request({ op: "director-check", params: {} }),
      deps({
        directorCheckDeps: {
          hasPersistedDirectorState: async () => true,
          loadDirectorPersisted: async () => persistedBlocked,
          loadWorldBlueprint: async () => incompleteBp,
          collectProjectSnapshot: async (_pp, idea) => ({
            idea,
            worldComplete: false,
            protagonistNamed: false,
            antagonistNamed: false,
            frameworkChosen: false,
            volumesPlanned: false,
            firstChapterReady: false,
          }),
        },
      }),
    )
    expect(blockedRes.ok).toBe(true)
    expect(tauriInvoke).not.toHaveBeenCalled()
    expect(blockedRes.value).toMatchObject({
      projectPath: "/proj",
      hasPersistedState: true,
      currentPhase: "idea",
      completed: false,
      worldBlueprintPresent: true,
      worldValidation: { verdict: "incomplete" },
      probe: {
        canAdvance: false,
        wouldAdvanceTo: null,
        wouldComplete: false,
        blockedReason: "核心冲突缺失",
        gapHint: "请先描述核心冲突",
      },
      meta: { readOnly: true, llmCalls: 0, diskWrites: 0 },
    })

    // 立意完备时 probe 预告可推进至 world（仍不落盘修改状态）
    const persistedReady: DirectorPersistedFile = {
      fileVersion: 1,
      state: createDirectorPipeline(),
      ideaInput: { title: "雾港旧案", genre: "悬疑", coreConflict: "追查十年前失踪案" },
    }
    const readyRes = await handleStateRequest(
      request({ op: "director-check" }),
      deps({
        directorCheckDeps: {
          hasPersistedDirectorState: async () => true,
          loadDirectorPersisted: async () => persistedReady,
          loadWorldBlueprint: async () => null,
          collectProjectSnapshot: async (_pp, idea) => ({
            idea,
            worldComplete: false,
            protagonistNamed: false,
            antagonistNamed: false,
            frameworkChosen: false,
            volumesPlanned: false,
            firstChapterReady: false,
          }),
        },
      }),
    )
    expect(readyRes.ok).toBe(true)
    expect(tauriInvoke).not.toHaveBeenCalled()
    expect(readyRes.value).toMatchObject({
      currentPhase: "idea",
      worldBlueprintPresent: false,
      worldValidation: null,
      probe: {
        canAdvance: true,
        wouldAdvanceTo: "world",
        wouldComplete: false,
        blockedReason: null,
        gapHint: null,
      },
    })
  })

  it("outline-write 严守先 createDirectory 再写盘、路径安全校验、有效章节才同步模型以及 onDraftWritten 刷新", async () => {
    const callOrder: string[] = []
    const ensureDir = vi.fn(async (dir: string) => {
      callOrder.push(`mkdir:${dir}`)
    })
    const writeAtomic = vi.fn(async (path: string, _content: string) => {
      callOrder.push(`write:${path}`)
    })
    const saveModel = vi.fn(async (pp: string) => {
      callOrder.push(`model:${pp}`)
      return { path: `${pp}/.novel/outline-model.json` }
    })
    const onDraftWritten = vi.fn()

    // 1) 非法文件名（遍历/分隔符/冒号/控制字符/非 .md/Windows 保留名/超长）与非法内容全部先于落盘拒绝
    const badFilenames = [
      "",
      "../escape.md",
      "sub/outline.md",
      "sub\\outline.md",
      "a:b.md",
      "bad\x00.md",
      ".hidden.md",
      "outline.txt",
      "CON.md",
      "CON .md",
      "nul.md",
      "NUL .md",
      "COM1.md",
      "LPT9.md",
      " leading.md",
      `${"a".repeat(126)}.md`,
    ]
    for (const filename of badFilenames) {
      const res = await handleStateRequest(
        request({ op: "outline-write", params: { filename, content: "# 第1卷 启程\n## 第1章 雨夜" } }),
        deps({ outlineWriteDeps: { createDirectory: ensureDir, writeFileAtomic: writeAtomic, saveOutlineModel: saveModel }, onDraftWritten }),
      )
      expect(res.ok).toBe(false)
    }
    const emptyContent = await handleStateRequest(
      request({ op: "outline-write", params: { filename: "main.md", content: "   " } }),
      deps({ outlineWriteDeps: { createDirectory: ensureDir, writeFileAtomic: writeAtomic, saveOutlineModel: saveModel }, onDraftWritten }),
    )
    expect(emptyContent.ok).toBe(false)
    const hugeContent = await handleStateRequest(
      request({ op: "outline-write", params: { filename: "main.md", content: "甲".repeat(MAX_OUTLINE_WRITE_CHARS + 1) } }),
      deps({ outlineWriteDeps: { createDirectory: ensureDir, writeFileAtomic: writeAtomic, saveOutlineModel: saveModel }, onDraftWritten }),
    )
    expect(hugeContent.ok).toBe(false)
    expect(ensureDir).not.toHaveBeenCalled()
    expect(writeAtomic).not.toHaveBeenCalled()
    expect(saveModel).not.toHaveBeenCalled()
    expect(onDraftWritten).not.toHaveBeenCalled()

    // 2) 结构化大纲（chapterCount > 0 且校验通过）：先 createDirectory -> writeFileAtomic -> saveOutlineModel -> onDraftWritten
    const validOutline = [
      "# 第1卷 雾港暗潮",
      "",
      "## 第1章 雨夜来客",
      "### 本章目标",
      "主角陈砚在雨夜接到一封失踪案密信。",
    ].join("\n")
    const okRes = await handleStateRequest(
      request({ op: "outline-write", params: { filename: "master-outline.md", content: validOutline } }),
      deps({
        outlineWriteDeps: { createDirectory: ensureDir, writeFileAtomic: writeAtomic, saveOutlineModel: saveModel },
        onDraftWritten,
      }),
    )
    expect(okRes.ok).toBe(true)
    expect(callOrder).toEqual([
      "mkdir:/proj/wiki/outlines",
      "write:/proj/wiki/outlines/master-outline.md",
      "model:/proj",
    ])
    expect(onDraftWritten).toHaveBeenCalledTimes(1)
    expect(okRes.value).toMatchObject({
      filename: "master-outline.md",
      path: "/proj/wiki/outlines/master-outline.md",
      modelSynced: true,
      modelPath: "/proj/.novel/outline-model.json",
      modelSyncSkippedReason: null,
      parseSummary: { chapterCount: 1, validationOk: true, validationIssues: [] },
    })

    // 3) 无章节散文大纲（chapterCount === 0）：只写 wiki/outlines，不覆写 .novel/outline-model.json
    saveModel.mockClear()
    const proseOnlyRes = await handleStateRequest(
      request({ op: "outline-write", params: { filename: "notes.md", content: "纯构思笔记，不含任何章标题。" } }),
      deps({
        outlineWriteDeps: { createDirectory: ensureDir, writeFileAtomic: writeAtomic, saveOutlineModel: saveModel },
        onDraftWritten,
      }),
    )
    expect(proseOnlyRes.ok).toBe(true)
    expect(saveModel).not.toHaveBeenCalled()
    expect(proseOnlyRes.value).toMatchObject({
      modelSynced: false,
      modelPath: null,
      modelSyncSkippedReason: "no_chapters_parsed",
    })
    expect(onDraftWritten).toHaveBeenCalledTimes(2)

    // 4) syncModel=false 显式关闭侧车同步，同时接受大写 .MD 后缀（与 Rust validate_outline_filename 对齐）
    saveModel.mockClear()
    const noSyncRes = await handleStateRequest(
      request({ op: "outline-write", params: { filename: "MAIN-OUTLINE.MD", content: validOutline, syncModel: false } }),
      deps({
        outlineWriteDeps: { createDirectory: ensureDir, writeFileAtomic: writeAtomic, saveOutlineModel: saveModel },
        onDraftWritten,
      }),
    )
    expect(noSyncRes.ok).toBe(true)
    expect(saveModel).not.toHaveBeenCalled()
    expect(noSyncRes.value).toMatchObject({
      filename: "MAIN-OUTLINE.MD",
      path: "/proj/wiki/outlines/MAIN-OUTLINE.MD",
      modelSynced: false,
      modelSyncSkippedReason: "disabled_by_caller",
    })
    expect(onDraftWritten).toHaveBeenCalledTimes(3)

    // 5) 正文写入成功后即便 saveOutlineModel 抛错，finally 仍必须触发 onDraftWritten 刷新 UI
    const failingSaveModel = vi.fn(async () => {
      throw new Error("outline-model 磁盘写入失败")
    })
    const syncFailRes = await handleStateRequest(
      request({ op: "outline-write", params: { filename: "sync-fail.md", content: validOutline } }),
      deps({
        outlineWriteDeps: { createDirectory: ensureDir, writeFileAtomic: writeAtomic, saveOutlineModel: failingSaveModel },
        onDraftWritten,
      }),
    )
    expect(syncFailRes.ok).toBe(false)
    expect(syncFailRes.error).toContain("outline-model 磁盘写入失败")
    expect(onDraftWritten).toHaveBeenCalledTimes(4)
  })
})

describe("handleStateRequest — P1-B3（rules-get compact / gate-check-mechanical detailLevel / workflowHint / 零写导出守卫）", () => {
  afterEach(() => {
    useWikiStore.getState().setProject(null)
    tauriInvoke.mockReset()
  })

  it("1) rules-get compact=true 跳过 soul.md 与 writing-style.json 读盘，省略 soulDoc/enabledPreset/structuredRules 并标注 omittedAsProvidedByPrepareWrite", async () => {
    const readPaths: string[] = []
    const files = new Map<string, string>([
      ["/proj/soul.md", "# 不应被读取的灵魂文档"],
      ["/proj/.niko-buddy/writing-style.json", JSON.stringify({ enabledStyleId: "s1", styles: [{ id: "s1", name: "冷硬" }] })],
      ["/proj/.novel/book-rules.json", JSON.stringify({ version: "1.0", prohibitions: ["禁词"], allowedDeviations: [] })],
    ])

    const res = await handleStateRequest(
      request({ op: "rules-get", params: { compact: true } }),
      deps({
        readFileText: async (path) => {
          readPaths.push(path)
          if (files.has(path)) return files.get(path)!
          throw new Error(`ENOENT: ${path}`)
        },
      }),
    )

    expect(res.ok).toBe(true)
    expect(tauriInvoke).not.toHaveBeenCalled()
    expect(readPaths.some((p) => p.endsWith("/soul.md"))).toBe(false)
    expect(readPaths.some((p) => p.endsWith("/.niko-buddy/writing-style.json"))).toBe(false)

    const val = res.value as {
      compact: boolean
      omittedAsProvidedByPrepareWrite: string[]
      writingStyle: Record<string, unknown>
      antiAi: Record<string, unknown>
      bookRules: { loaded: boolean; rules: { prohibitions: string[] } }
      planning: Record<string, unknown>
    }
    expect(val.compact).toBe(true)
    expect(val.omittedAsProvidedByPrepareWrite).toEqual(["soulDoc", "enabledPreset"])
    expect(val.writingStyle.omittedAsProvidedByPrepareWrite).toEqual(["soulDoc", "enabledPreset"])
    expect("soulDoc" in val.writingStyle).toBe(false)
    expect("enabledPreset" in val.writingStyle).toBe(false)
    expect("structuredRules" in val.antiAi).toBe(false)
    expect(typeof val.antiAi.structuredRuleCount).toBe("number")
    expect(val.bookRules.loaded).toBe(true)
    expect(val.bookRules.rules.prohibitions).toEqual(["禁词"])
    expect(val.planning).toBeDefined()

    // 非 boolean 的 compact 参数显式拒绝
    for (const badCompact of ["true", 1, null, {}]) {
      const badRes = await handleStateRequest(
        request({ op: "rules-get", params: { compact: badCompact } }),
        deps(),
      )
      expect(badRes.ok).toBe(false)
      expect(badRes.error).toContain("compact")
    }
  })

  it("2) rules-get 缺省与 compact=false 保持既有完整结构（含 soulDoc/enabledPreset/structuredRules）", async () => {
    const files = new Map<string, string>([
      ["/proj/soul.md", "# 完整灵魂文档"],
      [
        "/proj/.niko-buddy/writing-style.json",
        JSON.stringify({
          enabledStyleId: "s1",
          styles: [{ id: "s1", name: "冷硬叙事", description: "克制", rules: [] }],
        }),
      ],
    ])
    const readFileText = async (path: string) => {
      if (files.has(path)) return files.get(path)!
      throw new Error(`ENOENT: ${path}`)
    }

    for (const params of [{}, { compact: false }]) {
      const res = await handleStateRequest(
        request({ op: "rules-get", params }),
        deps({ readFileText }),
      )
      expect(res.ok).toBe(true)
      const val = res.value as {
        writingStyle: { soulDoc: string; enabledPreset: { id: string } | null }
        antiAi: { structuredRules: unknown[] }
      }
      expect(val.writingStyle.soulDoc).toBe("# 完整灵魂文档")
      expect(val.writingStyle.enabledPreset?.id).toBe("s1")
      expect(Array.isArray(val.antiAi.structuredRules)).toBe(true)
      expect(val.antiAi.structuredRules.length).toBeGreaterThan(0)
      expect("omittedAsProvidedByPrepareWrite" in (res.value as Record<string, unknown>)).toBe(false)
    }
  })

  it("3) gate-check-mechanical 透传 detailLevel（默认 full / compact），拒绝非法值并恒定附带 workflowHint", async () => {
    const badLevel = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { text: "测试正文", detailLevel: "brief" } }),
      deps(),
    )
    expect(badLevel.ok).toBe(false)
    expect(badLevel.error).toContain("detailLevel")

    const seenLevels: unknown[] = []
    const runMechanicalGate = vi.fn(async (input) => {
      seenLevels.push(input.detailLevel)
      return {
        detailLevel: input.detailLevel ?? "full",
        mechanicalOnly: true as const,
        semanticReviewCompleted: false as const,
        verdict: "mechanical_pass_pending_semantic" as const,
        blockingGate: null,
        chapterNumber: 1,
        genre: null,
      } as never
    })

    const defaultRes = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { text: "测试正文" } }),
      deps({ runMechanicalGate }),
    )
    expect(defaultRes.ok).toBe(true)
    expect(seenLevels[0]).toBe("full")
    expect(typeof (defaultRes.value as { workflowHint?: unknown }).workflowHint).toBe("string")

    const compactStubRes = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { text: "测试正文", detailLevel: "compact" } }),
      deps({ runMechanicalGate }),
    )
    expect(compactStubRes.ok).toBe(true)
    expect(seenLevels[1]).toBe("compact")
    expect((compactStubRes.value as { workflowHint: string }).workflowHint).toContain("pending")

    // 真实机械门面端到端 compact 路径：无 gates/decisionGates/metrics，含 summary 与 workflowHint
    const realCompact = await handleStateRequest(
      request({ op: "gate-check-mechanical", params: { text: "这是一段包含毫无疑问的短草稿。", detailLevel: "compact" } }),
      deps({ readFileText: async () => { throw new Error("ENOENT") } }),
    )
    expect(realCompact.ok).toBe(true)
    const realVal = realCompact.value as Record<string, unknown>
    expect(realVal.detailLevel).toBe("compact")
    expect("gates" in realVal).toBe(false)
    expect("decisionGates" in realVal).toBe(false)
    expect("metrics" in realVal).toBe(false)
    expect(realVal.summary).toBeDefined()
    expect(typeof realVal.workflowHint).toBe("string")
  })

  it("4) draft-write 附带 Draft-first workflowHint（指向 draftId 与 gate.check_mechanical）", async () => {
    const onDraftWritten = vi.fn()
    const res = await handleStateRequest(
      request({ op: "draft-write", params: { chapterName: "第5章", content: "草稿正文" } }),
      deps({
        onDraftWritten,
        writeChapterDraft: async () => ({ draftId: "draft_wf_5", chapterName: "第5章", path: "/proj/.qm-drafts/draft_wf_5.md", chars: 4 }),
      }),
    )
    expect(res.ok).toBe(true)
    expect(onDraftWritten).toHaveBeenCalledTimes(1)
    const val = res.value as { draftId: string; workflowHint: string }
    expect(val.draftId).toBe("draft_wf_5")
    expect(val.workflowHint).toContain("draft_wf_5")
    expect(val.workflowHint).toContain("gate.check_mechanical")
    expect(val.workflowHint).toContain('detailLevel="compact"')
  })

  it("5) context-prepare-start 同步拦截 retrievalMode 冲突且 context-prepare-poll 原样透传 entry.value（同时维持零写前缀导出）", async () => {
    const conflictRes = await handleStateRequest(
      request({
        op: "context-prepare-start",
        params: { retrievalMode: "local_only", allowRetrievalNetwork: true },
      }),
      deps(),
    )
    expect(conflictRes.ok).toBe(false)
    expect(conflictRes.error).toContain("参数冲突")

    // 再次断言模块导出面严守零写前缀门禁
    const mod = await import("./state-bridge")
    expect(Object.keys(mod).filter((name) => /^(set|write|remove|delete|update)/i.test(name))).toEqual([])
  })
})
