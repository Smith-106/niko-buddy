// @vitest-environment jsdom
/**
 * creative-hub-view.spec.tsx — 创作中枢视图契约（只读诊断＋下一步建议，不写盘）。
 *
 * 覆盖：
 *   1. 有绑定项目 → creative-binding 显示标题，诊断 verdict 渲染，建议为继续当前任务；
 *   2. 未初始化零数据 → creative-empty 诚实空态，建议含补全项目资料；
 *   3. blockingGate 存在 → 首条建议先修该门；
 *   4. verdict critical → 建议含先恢复健康；
 *   5. 装载失败 → creative-load-error（不伪装成空态）。
 *
 * @license MIT © Niko Buddy
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CreativeHubView, deriveCreativeNext } from "./creative-hub-view"

const mocks = vi.hoisted(() => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/lib/novel/doctor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/doctor")>()
  // 默认委派真实实现；单个用例可用 mockResolvedValueOnce 覆盖
  return { ...actual, runProjectDoctor: vi.fn(actual.runProjectDoctor) }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    fileExists: mocks.fileExists,
    readFile: mocks.readFile,
    listDirectory: mocks.listDirectory,
    writeFile: mocks.writeFile,
    createDirectory: mocks.createDirectory,
  }
})

afterEach(() => {
  cleanup()
  mocks.fileExists.mockReset()
  mocks.readFile.mockReset()
  mocks.listDirectory.mockReset()
})

const PROJECT = "/proj/book"

function metaJson(): string {
  return JSON.stringify({
    id: "novel-1",
    title: "测试之书",
    genre: "玄幻",
    targetWords: 100000,
    novelMode: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    currentChapter: 3,
    totalChapters: 10,
    totalWords: 9000,
    volumes: 1,
    description: "",
  })
}

function gateFailLine(): string {
  return JSON.stringify({
    seq: 0,
    eventId: "gate-run:0:consistency",
    ts: "2026-01-01T00:00:00.000Z",
    kind: "gate-run",
    actor: "system",
    evidenceRefs: [],
    payload: { gate: "consistency", status: "fail" },
  })
}

/** 按路径路由 fs：meta/status 缺失可配，账本缺省空串（空账本）。 */
function routeFiles(opts: { meta: boolean; status: boolean; ledger?: string }): void {
  const ledgerText = opts.ledger ?? ""
  mocks.fileExists.mockImplementation(async () => true)
  mocks.readFile.mockImplementation(async (path: string) => {
    if (path.endsWith("project-meta.json")) {
      if (!opts.meta) throw new Error("not found: project-meta.json")
      return metaJson()
    }
    if (path.endsWith("status.json")) {
      if (!opts.status) throw new Error("not found: status.json")
      return "{}"
    }
    if (path.endsWith("run-events.jsonl")) return ledgerText
    throw new Error(`unexpected read: ${path}`)
  })
  mocks.listDirectory.mockResolvedValue([])
}

describe("CreativeHubView", () => {
  it("批次三·13：元数据缺失 → 说明不影响写作 + 补全按钮写 project-meta（书名取文件夹名）", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockRejectedValue(new Error("not found"))
    mocks.listDirectory.mockResolvedValue([])
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.writeFile.mockResolvedValue(undefined)
    render(<CreativeHubView projectPath={PROJECT} />)
    const binding = await screen.findByTestId("creative-binding")
    expect(binding.textContent).toContain("不影响写作")
    fireEvent.click(screen.getByTestId("creative-fill-meta"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    const [path, body] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(path.endsWith(".novel/project-meta.json")).toBe(true)
    expect(JSON.parse(body).title).toBe("book")
  })

  it("复核 A3：project-meta.json 存在但损坏 → 不显示补全按钮、不写盘，提示先修文件", async () => {
    mocks.writeFile.mockClear()
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("project-meta.json")) return "{broken json"
      if (path.endsWith("status.json")) return "{}"
      if (path.endsWith("run-events.jsonl")) return ""
      throw new Error(`unexpected read: ${path}`)
    })
    mocks.listDirectory.mockResolvedValue([])
    render(<CreativeHubView projectPath={PROJECT} />)
    const corrupt = await screen.findByTestId("creative-meta-corrupt")
    expect(corrupt.textContent).toContain("读不出来")
    expect(screen.queryByTestId("creative-fill-meta")).toBeNull()
    expect(screen.queryByTestId("creative-empty")).toBeNull()
    const next = await screen.findAllByTestId("creative-next")
    expect(next.some((el) => el.textContent?.includes("meta=corrupt"))).toBe(true)
    expect(next.some((el) => el.textContent?.includes("补全项目资料"))).toBe(false)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("复核 A3：点补全时文件已被别处建好 → 不覆盖，只刷新显示", async () => {
    mocks.writeFile.mockClear()
    mocks.fileExists.mockResolvedValueOnce(false).mockResolvedValue(true)
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("project-meta.json")) return metaJson()
      if (path.endsWith("status.json")) return "{}"
      if (path.endsWith("run-events.jsonl")) return ""
      throw new Error(`unexpected read: ${path}`)
    })
    mocks.listDirectory.mockResolvedValue([])
    render(<CreativeHubView projectPath={PROJECT} />)
    fireEvent.click(await screen.findByTestId("creative-fill-meta"))
    await waitFor(() => expect(screen.getByTestId("creative-binding").textContent).toContain("测试之书"))
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("有绑定项目 → 标题＋诊断 verdict＋继续当前任务（无零数据空态）", async () => {
    routeFiles({ meta: true, status: true })
    render(<CreativeHubView projectPath={PROJECT} />)
    const binding = await screen.findByTestId("creative-binding")
    expect(binding.textContent).toContain("测试之书")
    const diagnosis = await screen.findByTestId("creative-diagnosis")
    expect(diagnosis.textContent).toContain("退化")
    expect(diagnosis.textContent).toContain("degraded")
    const next = await screen.findAllByTestId("creative-next")
    expect(next).toHaveLength(1)
    expect(next[0]?.textContent).toContain("继续当前任务")
    expect(next[0]?.textContent).toContain("依据")
    expect(screen.queryByTestId("creative-empty")).toBeNull()
    expect(screen.getByTestId("creative-hub-view")).toBeTruthy()
  })

  it("verdict healthy → 诊断区块走 ok 色调分支", async () => {
    const { runProjectDoctor } = await import("@/lib/novel/doctor")
    vi.mocked(runProjectDoctor).mockResolvedValueOnce({
      verdict: "healthy",
      findings: [],
    } as never)
    routeFiles({ meta: true, status: true })
    render(<CreativeHubView projectPath={PROJECT} />)
    const diagnosis = await screen.findByTestId("creative-diagnosis")
    expect(diagnosis.textContent).toContain("healthy")
  })

  it("未初始化零数据 → 诚实空态＋补全项目资料建议", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockRejectedValue(new Error("not found"))
    mocks.listDirectory.mockResolvedValue([])
    render(<CreativeHubView projectPath={PROJECT} />)
    const binding = await screen.findByTestId("creative-binding")
    expect(binding.textContent).toContain("尚未初始化")
    const empty = await screen.findByTestId("creative-empty")
    expect(empty.textContent).toContain("暂无项目数据")
    const next = await screen.findAllByTestId("creative-next")
    expect(next.some((el) => el.textContent?.includes("补全项目资料"))).toBe(true)
    expect(next.every((el) => el.textContent?.includes("依据"))).toBe(true)
  })

  it("blockingGate 存在 → 首条建议先修该门", async () => {
    routeFiles({ meta: true, status: true, ledger: `${gateFailLine()}\n` })
    render(<CreativeHubView projectPath={PROJECT} />)
    const diagnosis = await screen.findByTestId("creative-diagnosis")
    expect(diagnosis.textContent).toContain("阻塞")
    const next = await screen.findAllByTestId("creative-next")
    expect(next.length).toBeGreaterThan(0)
    expect(next[0]?.textContent).toContain("先修复被阻塞的门")
    expect(next[0]?.textContent).toContain("一致性门")
    expect(next[0]?.textContent).toContain("blockingGate=consistency")
  })

  it("verdict critical → 建议含先恢复健康", async () => {
    routeFiles({ meta: true, status: false })
    render(<CreativeHubView projectPath={PROJECT} />)
    const diagnosis = await screen.findByTestId("creative-diagnosis")
    expect(diagnosis.textContent).toContain("严重")
    expect(diagnosis.textContent).toContain("critical")
    const next = await screen.findAllByTestId("creative-next")
    expect(next.some((el) => el.textContent?.includes("先恢复项目健康"))).toBe(true)
    expect(next.some((el) => el.textContent?.includes("verdict=critical"))).toBe(true)
  })

  it("装载失败 → creative-load-error（不伪装成空态）", async () => {
    mocks.fileExists.mockRejectedValue(new Error("fs boom"))
    mocks.readFile.mockRejectedValue(new Error("fs boom"))
    mocks.listDirectory.mockResolvedValue([])
    render(<CreativeHubView projectPath={PROJECT} />)
    const err = await screen.findByTestId("creative-load-error")
    expect(err.textContent).toContain("fs boom")
    expect(screen.queryByTestId("creative-binding")).toBeNull()
    expect(screen.queryByTestId("creative-empty")).toBeNull()
  })
})

describe("deriveCreativeNext（纯函数优先级）", () => {
  it("metaCorrupt → 建议先检查资料文件，不建议一键补全", () => {
    const items = deriveCreativeNext({ meta: null, metaCorrupt: true, verdict: "healthy", blockingGate: null })
    expect(items.map((i) => i.code)).toEqual(["meta=corrupt"])
  })

  it("blockingGate 优先于 critical 与 meta 缺失", () => {
    const items = deriveCreativeNext({ meta: null, verdict: "critical", blockingGate: "quality" })
    expect(items[0]?.text).toContain("先修复被阻塞的门")
    expect(items[0]?.text).toContain("质量门")
    expect(items[1]?.text).toContain("先恢复项目健康")
    expect(items[2]?.text).toContain("补全项目资料")
  })

  it("健康已初始化无阻断 → 继续当前任务（含章节号）", () => {
    const items = deriveCreativeNext({
      meta: {
        id: "n",
        title: "t",
        genre: "",
        targetWords: 0,
        novelMode: true,
        createdAt: "x",
        updatedAt: "x",
        currentChapter: 5,
        totalChapters: 10,
        totalWords: 1,
        volumes: 0,
        description: "",
      },
      verdict: "healthy",
      blockingGate: null,
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.text).toContain("继续当前任务")
    expect(items[0]?.text).toContain("第 5 章")
  })
})

describe("deriveCreativeNext 分支覆盖补齐", () => {
  const baseMeta = {
    id: "n",
    title: "t",
    genre: "玄幻",
    targetWords: 0,
    novelMode: true,
    createdAt: "x",
    updatedAt: "x",
    currentChapter: 5,
    totalChapters: 10,
    totalWords: 1,
    volumes: 0,
    description: "",
  }

  it("currentChapter 为 0 时用通用继续文案（无章节号）", () => {
    const items = deriveCreativeNext({
      meta: { ...baseMeta, currentChapter: 0 },
      verdict: "healthy",
      blockingGate: null,
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.text).toBe("继续当前任务")
  })
})

describe("CreativeHubView 分支覆盖补齐", () => {
  it("空项目路径直接装载失败（不读盘）", async () => {
    render(<CreativeHubView projectPath="" />)
    const err = await screen.findByTestId("creative-load-error")
    expect(err.textContent).toContain("项目路径为空")
  })

  it("缺失转损坏竞态：点补全时文件已损坏则报错不覆盖", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockRejectedValue(new Error("not found"))
    mocks.listDirectory.mockResolvedValue([])
    mocks.writeFile.mockClear()
    mocks.writeFile.mockResolvedValue(undefined)
    render(<CreativeHubView projectPath={PROJECT} />)
    const btn = await screen.findByTestId("creative-fill-meta")
    // 点击前文件被别处写坏：再次检查时已存在但损坏
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("project-meta.json")) return "{broken json"
      if (path.endsWith("status.json")) return "{}"
      if (path.endsWith("run-events.jsonl")) return ""
      throw new Error(`unexpected read: ${path}`)
    })
    fireEvent.click(btn)
    const corrupt = await screen.findByTestId("creative-meta-corrupt")
    expect(corrupt.textContent).toContain("读不出来")
    expect(corrupt.textContent).toContain("没有写入")
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("项目路径为根时补全用默认书名（空文件夹名回退）", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockRejectedValue(new Error("not found"))
    mocks.listDirectory.mockResolvedValue([])
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.writeFile.mockClear()
    mocks.writeFile.mockResolvedValue(undefined)
    render(<CreativeHubView projectPath="/" />)
    fireEvent.click(await screen.findByTestId("creative-fill-meta"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    const [, body] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(JSON.parse(body).title).toBe("未命名作品")
  })

  it("补全写盘失败显示补全失败", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockRejectedValue(new Error("not found"))
    mocks.listDirectory.mockResolvedValue([])
    mocks.writeFile.mockRejectedValue(new Error("disk full"))
    render(<CreativeHubView projectPath={PROJECT} />)
    fireEvent.click(await screen.findByTestId("creative-fill-meta"))
    const fail = await screen.findByText(/补全失败/)
    expect(fail.textContent).toContain("disk full")
  })

  it("题材为空显示未填写", async () => {
    const noGenre = metaJson().replace('"玄幻"', '""')
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("project-meta.json")) return noGenre
      if (path.endsWith("status.json")) return "{}"
      if (path.endsWith("run-events.jsonl")) return ""
      throw new Error(`unexpected read: ${path}`)
    })
    mocks.listDirectory.mockResolvedValue([])
    render(<CreativeHubView projectPath={PROJECT} />)
    const binding = await screen.findByTestId("creative-binding")
    expect(binding.textContent).toContain("未填写")
  })

  it("卸载后装载完成不再写状态（取消守卫）", async () => {
    let resolveExists!: (v: boolean) => void
    mocks.fileExists.mockImplementation(() => new Promise<boolean>((res) => { resolveExists = res }))
    mocks.readFile.mockRejectedValue(new Error("not found"))
    mocks.listDirectory.mockResolvedValue([])
    const { unmount, container } = render(<CreativeHubView projectPath={PROJECT} />)
    unmount()
    resolveExists(false)
    await new Promise((r) => setTimeout(r, 50))
    expect(container.innerHTML).toBe("")
  })

  it("卸载后账本损坏也不写错误态", async () => {
    let resolveExists!: (v: boolean) => void
    mocks.fileExists.mockImplementation(() => new Promise<boolean>((res) => { resolveExists = res }))
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("project-meta.json")) return metaJson()
      if (path.endsWith("status.json")) return "{}"
      if (path.endsWith("run-events.jsonl")) return "{bad json\n"
      throw new Error(`unexpected read: ${path}`)
    })
    mocks.listDirectory.mockResolvedValue([])
    const { unmount, container } = render(<CreativeHubView projectPath={PROJECT} />)
    unmount()
    resolveExists(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(container.innerHTML).toBe("")
  })
})
