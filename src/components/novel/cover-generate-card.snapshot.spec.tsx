/** @vitest-environment jsdom */
/**
 * cover-generate-card.snapshot.spec.tsx — 封面卡的成功路径（M3 生产接线）。
 *
 * 与 cover-generate-card.spec.tsx 分工：
 *   - 既有 spec 锁「未注入 port 的降级」与「真实 fs 缺省失败」两条；
 *   - 本文件锁成功路径：ok 结果 → 写 `snapshot-cover` 运行记录（快照元数据不含正文）、
 *     幂等 skip 不调 port.generate、promptOverride 覆盖、写历史失败落 catch。
 *
 * 约定：只 mock 边界（`@/commands/fs` 的读存 + `saveGenerationHistoryEntry` 写盘），
 * runCoverImageGeneration 走真实实现，断言真实任务组装与真实返回语义。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@testing-library/react"

import { CoverGenerateCard } from "./cover-generate-card"
import type { CoverImagePort } from "@/lib/novel"

const fsMock = vi.hoisted(() => ({
  fileExists: vi.fn<(path: string) => Promise<boolean>>(async () => false),
  createDirectory: vi.fn<(path: string) => Promise<void>>(async () => undefined),
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(async () => undefined),
}))

const historyMock = vi.hoisted(() => ({
  saveGenerationHistoryEntry: vi.fn(
    async (_projectPath: string, _input: unknown): Promise<unknown> => ({ id: "h1" }),
  ),
}))

const storeMock = vi.hoisted(() => ({ projectPath: "E:\\Novel" }))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    fileExists: fsMock.fileExists,
    createDirectory: fsMock.createDirectory,
    writeFile: fsMock.writeFile,
  }
})

vi.mock("@/lib/novel/generation-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/generation-history")>()
  return { ...actual, saveGenerationHistoryEntry: historyMock.saveGenerationHistoryEntry }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
      selector({ project: { path: storeMock.projectPath } }),
  }
})

const META = { title: "雾都", genre: "悬疑", protagonistBrief: "侦探", tone: "冷峻", keyImagery: ["雾", "巷"] }
const TITLE_SLUG = "雾都-cover.png"

/** 记录入参的注入式图像端口（生成成功固定返回一段字节）。 */
function makePort() {
  return vi.fn(async (_input: Parameters<CoverImagePort["generate"]>[0]) => new TextEncoder().encode("PNG"))
}

beforeEach(() => {
  vi.clearAllMocks()
  storeMock.projectPath = "E:\\Novel"
  fsMock.fileExists.mockResolvedValue(false)
  fsMock.createDirectory.mockResolvedValue(undefined)
  fsMock.writeFile.mockResolvedValue(undefined)
  historyMock.saveGenerationHistoryEntry.mockResolvedValue({ id: "h1" })
})

afterEach(() => cleanup())

describe("封面生成成功路径（M3 snapshot-cover 接线）", () => {
  it("ok → 写 snapshot-cover 运行记录（元数据不含正文）并提示 generated", async () => {
    const generate = makePort()
    render(<CoverGenerateCard meta={META} port={{ generate }} />)

    fireEvent.click(screen.getByText("生成封面图"))

    const notice = await screen.findByText(/generated/)
    expect(notice.textContent).toContain("已生成")

    // 1) 产物真实落到 pending 区（.novel/covers/，normalize 成 / 分隔）
    expect(fsMock.createDirectory).toHaveBeenCalledWith("E:/Novel/.novel/covers")
    expect(fsMock.writeFile).toHaveBeenCalledWith("E:/Novel/.novel/covers/" + TITLE_SLUG, "PNG")

    // 2) 运行记录：kind=snapshot-cover，快照元数据只有引用 + summary（不含正文）
    expect(historyMock.saveGenerationHistoryEntry).toHaveBeenCalledTimes(1)
    const [historyPath, input] = historyMock.saveGenerationHistoryEntry.mock.calls[0]
    expect(historyPath).toBe("E:/Novel")
    expect(input).toMatchObject({
      kind: "snapshot-cover",
      title: `cover-${TITLE_SLUG}`,
      results: [],
      snapshotMeta: {
        shape: "cover",
        artifactRef: `.novel/covers/${TITLE_SLUG}`,
        summary: "已生成 E:/Novel/.novel/covers/" + TITLE_SLUG,
      },
    })
    expect(JSON.stringify(input)).not.toContain("PNG")
  })

  it("promptOverride 覆盖组装出的 prompt，port 收到竖版尺寸", async () => {
    const generate = makePort()
    render(<CoverGenerateCard meta={META} port={{ generate }} promptOverride="自定义封面提示词" />)

    fireEvent.click(screen.getByText("生成封面图"))
    await screen.findByText(/generated/)

    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0]).toMatchObject({ prompt: "自定义封面提示词", width: 1024, height: 1536 })
  })

  it("目标已存在 → skipped 幂等：不调 port.generate，产物零覆盖，仍记运行日志", async () => {
    fsMock.fileExists.mockResolvedValue(true)
    const generate = makePort()
    render(<CoverGenerateCard meta={META} port={{ generate }} />)

    fireEvent.click(screen.getByText("生成封面图"))

    const notice = await screen.findByText(/skipped/)
    expect(notice.textContent).toContain("目标已存在，跳过（幂等）")
    expect(generate).not.toHaveBeenCalled()
    expect(fsMock.writeFile).not.toHaveBeenCalled()
    expect(historyMock.saveGenerationHistoryEntry).toHaveBeenCalledTimes(1)
  })

  it("写运行日志抛错 → 落 catch，提示封面生成失败（不静默吞）", async () => {
    historyMock.saveGenerationHistoryEntry.mockRejectedValue(new Error("history disk full"))
    const generate = makePort()
    render(<CoverGenerateCard meta={META} port={{ generate }} />)

    fireEvent.click(screen.getByText("生成封面图"))

    const notice = await screen.findByText(/封面生成失败/)
    expect(notice.textContent).toContain("history disk full")
  })

  it("主体回退链：主角简介为空 → 用意象；意象也空 → 用书名", async () => {
    const withImagery = makePort()
    const first = render(
      <CoverGenerateCard
        meta={{ title: "雾都", genre: "悬疑", protagonistBrief: "", tone: "冷峻", keyImagery: ["雾", "巷"] }}
        port={{ generate: withImagery }}
      />,
    )
    fireEvent.click(screen.getByText("生成封面图"))
    await screen.findByText(/generated/)
    expect(withImagery.mock.calls[0][0].prompt).toContain("主体：雾、巷")
    first.unmount()

    const titleOnly = makePort()
    render(
      <CoverGenerateCard
        meta={{ title: "雾都", genre: "悬疑", protagonistBrief: "", tone: "冷峻", keyImagery: [] }}
        port={{ generate: titleOnly }}
      />,
    )
    fireEvent.click(screen.getByText("生成封面图"))
    await screen.findByText(/generated/)
    expect(titleOnly.mock.calls[0][0].prompt).toContain("主体：雾都")
  })

  it("缺少项目路径 → 按钮禁用（不发起生成）", async () => {
    storeMock.projectPath = ""
    const generate = makePort()
    render(<CoverGenerateCard meta={META} port={{ generate }} />)

    const button = screen.getByText("生成封面图").closest("button")
    expect(button?.disabled).toBe(true)
    expect(generate).not.toHaveBeenCalled()
  })
})
