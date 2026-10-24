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
})
