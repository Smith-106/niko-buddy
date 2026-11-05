// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChapterDraft } from "@/lib/novel"
import { ChapterDraftDock } from "./chapter-draft-dock"

const draft: ChapterDraft = {
  id: "d1",
  chapterName: "第01章",
  content: "正文",
  createdAt: 1,
  status: "draft",
}

afterEach(() => cleanup())

describe("ChapterDraftDock", () => {
  it("采纳先确认，取消不写入", async () => {
    const acceptDraft = vi.fn()
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => [draft]}
        acceptDraft={acceptDraft}
        pathExists={async () => false}
      />,
    )
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    expect(acceptDraft).not.toHaveBeenCalled()
    expect((await screen.findByTestId("chapter-draft-confirm")).textContent).toContain("确认前不会写入")
    fireEvent.click(screen.getByTestId("chapter-draft-confirm-cancel"))
    expect(screen.queryByTestId("chapter-draft-confirm")).toBeNull()
    expect(acceptDraft).not.toHaveBeenCalled()
  })

  it("确认后才回填当前章", async () => {
    const acceptDraft = vi.fn(async () => ({ formalChapterPath: "C:/book/正文/第01章.md" }))
    const onAdopted = vi.fn()
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => [draft]}
        acceptDraft={acceptDraft}
        pathExists={async () => true}
        onAdopted={onAdopted}
      />,
    )
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    expect((await screen.findByTestId("chapter-draft-confirm")).textContent).toContain("会覆盖")
    fireEvent.click(screen.getByTestId("chapter-draft-confirm-accept"))
    await waitFor(() => expect(acceptDraft).toHaveBeenCalledTimes(1))
    expect(acceptDraft).toHaveBeenCalledWith({
      projectPath: "C:/book",
      draftId: "d1",
      formalChapterPath: "C:/book/正文/第01章.md",
      confirmed: true,
    })
    expect(onAdopted).toHaveBeenCalledWith("C:/book/正文/第01章.md")
  })

  it("Q14-B 有告警时渲染连续性告警条（critical 用 destructive 色）", async () => {
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => [draft]}
        pathExists={async () => true}
        alerts={{ critical: 2, warning: 3 }}
      />,
    )
    const bar = await screen.findByTestId("chapter-draft-continuity-alert")
    expect(bar.textContent).toContain("严重2")
    expect(bar.textContent).toContain("提示3")
    expect(bar.className).toContain("border-destructive/40")
  })

  it("Q14-B 仅 warning 时用琥珀色；无告警或全 0 时不渲染告警条", async () => {
    const { unmount } = render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => [draft]}
        pathExists={async () => true}
        alerts={{ critical: 0, warning: 4 }}
      />,
    )
    const bar = await screen.findByTestId("chapter-draft-continuity-alert")
    expect(bar.className).toContain("border-warning/40")
    unmount()

    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => [draft]}
        pathExists={async () => true}
        alerts={{ critical: 0, warning: 0 }}
      />,
    )
    await screen.findByTestId("chapter-draft-dock")
    expect(screen.queryByTestId("chapter-draft-continuity-alert")).toBeNull()
  })
it("批次二·7：空态说明草稿从哪来，并提供「去主控生成」", async () => {
    const onGenerateDraft = vi.fn()
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile={null}
        listDrafts={async () => []}
        onGenerateDraft={onGenerateDraft}
      />,
    )
    const empty = await screen.findByTestId("chapter-draft-empty")
    expect(empty.textContent).toContain("点「采纳」后才写入正文")
    fireEvent.click(screen.getByTestId("chapter-draft-empty-generate"))
    expect(onGenerateDraft).toHaveBeenCalledTimes(1)
  })

  it("批次二·7：采纳成功提示带「查看记忆更新」入口", async () => {
    const onOpenMemory = vi.fn()
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => [draft]}
        acceptDraft={async () => ({ formalChapterPath: "C:/book/正文/第01章.md" }) as never}
        pathExists={async () => false}
        onOpenMemory={onOpenMemory}
      />,
    )
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    fireEvent.click(await screen.findByTestId("chapter-draft-confirm-accept"))
    fireEvent.click(await screen.findByTestId("chapter-draft-open-memory"))
    expect(onOpenMemory).toHaveBeenCalledTimes(1)
  })
})

describe("ChapterDraftDock statements 补齐（s6-execute-statements）", () => {
  it("listDrafts 拒绝 → 草稿读不出来", async () => {
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => {
          throw new Error("io")
        }}
      />,
    )
    expect((await screen.findByTestId("chapter-draft-note")).textContent).toContain("草稿读不出来。")
  })

  it("章节名非法 formalChapterPathForDraft 抛错 → 提示且不弹窗确认", async () => {
    const bad: ChapterDraft = { id: "bad", chapterName: "///", content: "x", createdAt: 1, status: "draft" }
    const acceptDraft = vi.fn()
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => [bad]}
        acceptDraft={acceptDraft}
        pathExists={async () => false}
      />,
    )
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-bad"))
    expect((await screen.findByTestId("chapter-draft-note")).textContent).toContain("草稿没有章节名")
    expect(screen.queryByTestId("chapter-draft-confirm")).toBeNull()
    expect(acceptDraft).not.toHaveBeenCalled()
  })

  it("pathExists 拒绝 → 回退已占用（会覆盖）", async () => {
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => [draft]}
        pathExists={async () => {
          throw new Error("fs")
        }}
      />,
    )
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    expect((await screen.findByTestId("chapter-draft-confirm")).textContent).toContain("会覆盖")
  })

  it("acceptDraft 拒绝（Error）→ 透出错误 message", async () => {
    const acceptDraft = vi.fn(async () => {
      throw new Error("写入失败")
    })
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => [draft]}
        acceptDraft={acceptDraft}
        pathExists={async () => false}
      />,
    )
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    fireEvent.click(await screen.findByTestId("chapter-draft-confirm-accept"))
    expect((await screen.findByTestId("chapter-draft-note")).textContent).toContain("写入失败")
  })

  it("acceptDraft 非 Error 拒绝 → 兜底文案", async () => {
    const acceptDraft = vi.fn(async (): Promise<never> => {
      // eslint-disable-next-line no-throw-literal
      throw "plain"
    })
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile="C:/book/正文/第01章.md"
        listDrafts={async () => [draft]}
        acceptDraft={acceptDraft}
        pathExists={async () => false}
      />,
    )
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    fireEvent.click(await screen.findByTestId("chapter-draft-confirm-accept"))
    expect((await screen.findByTestId("chapter-draft-note")).textContent).toContain("没有写入正式章")
  })

  it("projectPath 为空 → 先开书提示（早期返回）", () => {
    render(<ChapterDraftDock projectPath="" selectedFile={null} listDrafts={async () => []} />)
    expect(screen.getByText("先打开一本书，才能采纳草稿。")).toBeTruthy()
  })

  it("saved 状态草稿显示已写入且无采纳按钮", async () => {
    const saved: ChapterDraft = { ...draft, status: "saved" }
    render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile={null}
        listDrafts={async () => [saved]}
      />,
    )
    expect(await screen.findByText("已写入正式章")).toBeTruthy()
    expect(screen.queryByTestId("chapter-draft-adopt-d1")).toBeNull()
  })
})
