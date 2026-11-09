// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { AcceptDraftAndIngestResult, ChapterDraft } from "@/lib/novel"
import {
  ChapterDraftDock,
  type ChapterDraftDockAdoptAndIngest,
  type ChapterDraftDockAdoptAndIngestInput,
} from "./chapter-draft-dock"

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

describe("G2 采纳即回填四态", () => {
  const resolvedPath = "C:/book/正文/第01章.md"

  function renderDock(overrides: {
    adoptAndIngest?: ChapterDraftDockAdoptAndIngest
    acceptDraft?: () => Promise<unknown>
    onAdopted?: (path: string) => void
    onOpenMemory?: () => void
    listDrafts?: () => Promise<ChapterDraft[]>
  }) {
    return render(
      <ChapterDraftDock
        projectPath="C:/book"
        selectedFile={resolvedPath}
        listDrafts={overrides.listDrafts ?? (async () => [draft])}
        acceptDraft={overrides.acceptDraft as never}
        adoptAndIngest={overrides.adoptAndIngest}
        onAdopted={overrides.onAdopted}
        onOpenMemory={overrides.onOpenMemory}
        pathExists={async () => false}
      />,
    )
  }

  it("C3-0 两步确认：第一步只展开确认面板，不写盘、不 ingest", async () => {
    const adoptAndIngest = vi.fn<ChapterDraftDockAdoptAndIngest>()
    const acceptDraft = vi.fn()
    renderDock({ adoptAndIngest, acceptDraft })
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    expect(await screen.findByTestId("chapter-draft-confirm")).toBeTruthy()
    expect(screen.getByTestId("chapter-draft-confirm-accept")).toBeTruthy()
    expect(adoptAndIngest).not.toHaveBeenCalled()
    expect(acceptDraft).not.toHaveBeenCalled()
  })

  it("C3-1 ok：采纳 + 记忆回填完成，庆祝态与「查看记忆更新」入口可点", async () => {
    const onAdopted = vi.fn()
    const onOpenMemory = vi.fn()
    const listDrafts = vi.fn(async () => [draft])
    const adoptAndIngest = vi.fn(async (input: ChapterDraftDockAdoptAndIngestInput) => {
      input.onAcceptSettled?.()
      return { formalChapterPath: resolvedPath, ingest: "ok" as const }
    })
    renderDock({ adoptAndIngest, onAdopted, onOpenMemory, listDrafts })
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    fireEvent.click(await screen.findByTestId("chapter-draft-confirm-accept"))
    const note = await screen.findByTestId("chapter-draft-note")
    await waitFor(() => expect(note.textContent).toContain("记忆回填完成"))
    expect(adoptAndIngest).toHaveBeenCalledTimes(1)
    expect(adoptAndIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "C:/book",
        draftId: "d1",
        formalChapterPath: resolvedPath,
        onAcceptSettled: expect.any(Function),
      }),
    )
    expect(note.textContent).toContain("已写入正式章：C:/book/正文/第01章.md")
    expect(note.getAttribute("role")).toBe("status")
    // 语气分层：只有 ok 才是绿色成功庆祝块。
    expect(note.getAttribute("data-tone")).toBe("success")
    expect(note.className).toContain("bg-success/10")
    expect(note.className).toContain("border-success/40")
    expect(note.className).toContain("draft-celebrate")
    expect(note.className).not.toContain("bg-warning")
    expect(note.className).not.toContain("bg-destructive")
    expect(onAdopted).toHaveBeenCalledWith(resolvedPath)
    expect(listDrafts.mock.calls.length).toBeGreaterThan(1)
    fireEvent.click(screen.getByTestId("chapter-draft-open-memory"))
    expect(onOpenMemory).toHaveBeenCalledTimes(1)
  })

  it("C3-2 skipped-config：按设置跳过回填", async () => {
    const adoptAndIngest = vi.fn(async (input: ChapterDraftDockAdoptAndIngestInput) => {
      input.onAcceptSettled?.()
      return { formalChapterPath: resolvedPath, ingest: "skipped-config" as const }
    })
    renderDock({ adoptAndIngest })
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    fireEvent.click(await screen.findByTestId("chapter-draft-confirm-accept"))
    const note = await screen.findByTestId("chapter-draft-note")
    await waitFor(() => expect(note.textContent).toContain("已按设置跳过记忆回填"))
    expect(note.textContent).toContain("已写入正式章：")
    expect(note.textContent).toContain("autoIngestOnSave 关闭")
    expect(note.textContent).not.toContain("记忆回填完成")
    expect(note.textContent).not.toContain("记忆回填失败")
    // 跳过不是成功：警示语气，无绿色/庆祝语义。
    expect(note.getAttribute("data-tone")).toBe("warning")
    expect(note.className).toContain("border-warning/40")
    expect(note.className).toContain("bg-warning/10")
    expect(note.className).not.toContain("bg-success")
    expect(note.className).not.toContain("draft-celebrate")
  })

  it("C3-3 skipped-no-model：无可用模型跳过", async () => {
    const adoptAndIngest = vi.fn(async (input: ChapterDraftDockAdoptAndIngestInput) => {
      input.onAcceptSettled?.()
      return { formalChapterPath: resolvedPath, ingest: "skipped-no-model" as const }
    })
    renderDock({ adoptAndIngest })
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    fireEvent.click(await screen.findByTestId("chapter-draft-confirm-accept"))
    const note = await screen.findByTestId("chapter-draft-note")
    await waitFor(() => expect(note.textContent).toContain("未配置可用提取模型，记忆回填已跳过"))
    expect(note.textContent).not.toContain("记忆回填完成")
    expect(note.textContent).not.toContain("记忆回填失败")
    expect(note.textContent).not.toContain("autoIngestOnSave")
    // 与 skipped-config 同属警示语气，但文案仍各自可区分（见 C3-7）。
    expect(note.getAttribute("data-tone")).toBe("warning")
    expect(note.className).toContain("bg-warning/10")
    expect(note.className).not.toContain("bg-success")
    expect(note.className).not.toContain("draft-celebrate")
  })

  it("C3-4 failed：回填失败如实呈现（不掩盖已写正文）", async () => {
    const onAdopted = vi.fn()
    const adoptAndIngest = vi.fn(
      async (input: ChapterDraftDockAdoptAndIngestInput): Promise<AcceptDraftAndIngestResult> => {
        input.onAcceptSettled?.()
        return { formalChapterPath: resolvedPath, ingest: "failed", failReason: "extract_failed" }
      },
    )
    renderDock({ adoptAndIngest, onAdopted })
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    fireEvent.click(await screen.findByTestId("chapter-draft-confirm-accept"))
    const note = await screen.findByTestId("chapter-draft-note")
    await waitFor(() => expect(note.textContent).toContain("记忆回填失败：extract_failed"))
    expect(note.textContent).toContain("已写入正式章：")
    expect(onAdopted).toHaveBeenCalledWith(resolvedPath)
    // 回填失败用错误语气，仍保留「已写入正式章」事实。
    expect(note.getAttribute("data-tone")).toBe("error")
    expect(note.className).toContain("border-destructive/40")
    expect(note.className).toContain("bg-destructive/10")
    expect(note.className).not.toContain("bg-success")
    expect(note.className).not.toContain("draft-celebrate")
  })

  it("C3-7 四态语气可区分：ok=成功块，skipped-*=警示块，failed=错误块，文案四态各异", async () => {
    const cases = [
      { ingest: "ok" as const, expectText: "记忆回填完成", tone: "success", has: "bg-success/10", hasNot: "bg-warning/10" },
      {
        ingest: "skipped-config" as const,
        expectText: "已按设置跳过记忆回填",
        tone: "warning",
        has: "bg-warning/10",
        hasNot: "bg-success",
      },
      {
        ingest: "skipped-no-model" as const,
        expectText: "记忆回填已跳过",
        tone: "warning",
        has: "border-warning/40",
        hasNot: "bg-success",
      },
      {
        ingest: "failed" as const,
        expectText: "记忆回填失败：extract_failed",
        tone: "error",
        has: "bg-destructive/10",
        hasNot: "bg-success",
      },
    ]
    const seen: { tone: string | null; text: string }[] = []
    for (const item of cases) {
      const adoptAndIngest = vi.fn(
        async (input: ChapterDraftDockAdoptAndIngestInput): Promise<AcceptDraftAndIngestResult> => {
          input.onAcceptSettled?.()
          return {
            formalChapterPath: resolvedPath,
            ingest: item.ingest,
            failReason: item.ingest === "failed" ? "extract_failed" : undefined,
          }
        },
      )
      const { unmount } = renderDock({ adoptAndIngest })
      fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
      fireEvent.click(await screen.findByTestId("chapter-draft-confirm-accept"))
      const note = await screen.findByTestId("chapter-draft-note")
      await waitFor(() => expect(note.textContent).toContain(item.expectText))
      expect(note.getAttribute("data-tone")).toBe(item.tone)
      expect(note.className).toContain(item.has)
      expect(note.className).not.toContain(item.hasNot)
      // 「已落盘」事实在任何语气下都不丢。
      expect(note.textContent).toContain("已写入正式章：")
      seen.push({ tone: note.getAttribute("data-tone"), text: note.textContent ?? "" })
      unmount()
    }
    // 三种语气覆盖四态（两种 skipped 共享警示语气），四态文案两两不同。
    expect(seen.map((entry) => entry.tone)).toEqual(["success", "warning", "warning", "error"])
    expect(new Set(seen.map((entry) => entry.text)).size).toBe(4)
  })

  it("C3-5 accept 抛错不 ingest（settled 回调未触发）", async () => {
    const onAdopted = vi.fn()
    const acceptDraft = vi.fn()
    const adoptAndIngest = vi.fn(
      async (_input: ChapterDraftDockAdoptAndIngestInput): Promise<AcceptDraftAndIngestResult> => {
        throw new Error("采纳草稿必须先确认")
      },
    )
    renderDock({ adoptAndIngest, acceptDraft, onAdopted })
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    fireEvent.click(await screen.findByTestId("chapter-draft-confirm-accept"))
    const note = await screen.findByTestId("chapter-draft-note")
    await waitFor(() => expect(note.textContent).toBe("采纳草稿必须先确认"))
    expect(note.textContent).not.toContain("已写入正式章：")
    expect(note.textContent).not.toContain("记忆回填")
    expect(note.getAttribute("role")).toBeNull()
    expect(acceptDraft).not.toHaveBeenCalled()
    expect(onAdopted).not.toHaveBeenCalled()
  })

  it("C3-6 accept 已落盘后 ingest 抛错：不掩盖已写正文、不回滚、确认面板已关", async () => {
    const onAdopted = vi.fn()
    const listDrafts = vi.fn(async () => [draft])
    const adoptAndIngest = vi.fn(
      async (input: ChapterDraftDockAdoptAndIngestInput): Promise<AcceptDraftAndIngestResult> => {
        input.onAcceptSettled?.()
        throw new Error("snapshot 写盘失败")
      },
    )
    renderDock({ adoptAndIngest, onAdopted, listDrafts })
    fireEvent.click(await screen.findByTestId("chapter-draft-adopt-d1"))
    fireEvent.click(await screen.findByTestId("chapter-draft-confirm-accept"))
    const note = await screen.findByTestId("chapter-draft-note")
    await waitFor(() => expect(note.textContent).toContain("记忆回填失败：snapshot 写盘失败"))
    expect(note.textContent).toContain("已写入正式章：C:/book/正文/第01章.md")
    expect(note.textContent).not.toContain("采纳失败")
    expect(note.getAttribute("role")).toBe("status")
    // 已落盘但回填抛错 → 错误语气（不得用绿色成功块）。
    expect(note.getAttribute("data-tone")).toBe("error")
    expect(note.className).toContain("bg-destructive/10")
    expect(note.className).not.toContain("bg-success")
    expect(note.className).not.toContain("draft-celebrate")
    expect(onAdopted).toHaveBeenCalledWith(resolvedPath)
    expect(listDrafts.mock.calls.length).toBeGreaterThan(1)
    // 面板已关：无法二次确认造成重复 accept/ingest
    expect(screen.queryByTestId("chapter-draft-confirm")).toBeNull()
    expect(adoptAndIngest).toHaveBeenCalledTimes(1)
  })
})
