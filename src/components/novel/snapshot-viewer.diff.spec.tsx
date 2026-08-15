import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

// 隔离 Monaco worker / loader（复用 monaco-diff-editor.spec 的 mock 模式）：
// node 测试环境下不初始化真实 monaco，仅验证 props 透传契约。
vi.mock("@/lib/novel/monaco-loader", () => ({
  configureMonaco: vi.fn(),
}))
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: () => null,
  loader: { config: vi.fn() },
}))

// mock SnapshotViewer 依赖的 MonacoDiffEditor，捕获透传 props。
const mockDiff = vi.fn((_props: Record<string, unknown>) => null)
vi.mock("./monaco-diff-editor", () => ({
  MonacoDiffEditor: (props: Record<string, unknown>) => mockDiff(props),
}))

// i18n：t 返回 key 即可（快照查看器以中文字面量为主）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// fs：@/commands/fs 基于 Tauri invoke，node 环境下必须 mock；readFile 用于按 entry.path 读历史 JSON。
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async () => JSON.stringify({ summary: "历史摘要", chapterNumber: 1 }, null, 2)),
}))

// chapter-ingest：SSR（renderToStaticMarkup）不执行 useEffect，异步加载不触发；mock 保持可导入。
vi.mock("@/lib/novel/chapter-ingest", () => ({
  listSnapshotHistory: vi.fn(),
  loadSnapshot: vi.fn(),
  restoreSnapshotHistory: vi.fn(),
  syncSnapshotToMemory: vi.fn(),
}))

import { HistoryEntryRow, SnapshotDiffModal, SnapshotViewer } from "./snapshot-viewer"
import type { SnapshotHistoryEntry } from "@/lib/novel/chapter-ingest"

const entry: SnapshotHistoryEntry = {
  fileName: "2026-01-01T00-00-00.000Z.snapshot.json",
  path: "/project/.novel/snapshots/history/001/2026-01-01T00-00-00.000Z.snapshot.json",
  createdAt: "2026-01-01 00:00",
}

describe("snapshot-viewer 章节版本对比 (TASK-303)", () => {
  beforeEach(() => {
    mockDiff.mockClear()
  })

  it("历史版本行渲染「对比当前版本」按钮，与恢复操作并列", () => {
    const html = renderToStaticMarkup(
      <HistoryEntryRow
        entry={entry}
        disabled={false}
        restoring={false}
        onCompare={() => {}}
        onRestore={() => {}}
      />,
    )
    expect(html).toContain("对比当前版本")
    expect(html).toContain(entry.createdAt)
    expect(html).toContain("恢复")
  })

  it("对比模态打开时渲染标题，并透传 original/modified/language=json/readOnly 给 MonacoDiffEditor", () => {
    const html = renderToStaticMarkup(
      <SnapshotDiffModal
        open
        original='{"summary":"历史摘要","chapterNumber":1}'
        modified='{"summary":"当前摘要","chapterNumber":1}'
        onClose={() => {}}
      />,
    )
    expect(html).toContain("对比当前版本")
    expect(mockDiff).toHaveBeenCalledTimes(1)
    const callProps = mockDiff.mock.calls[0][0] as Record<string, unknown>
    expect(callProps.original).toBe('{"summary":"历史摘要","chapterNumber":1}')
    expect(callProps.modified).toBe('{"summary":"当前摘要","chapterNumber":1}')
    expect(callProps.language).toBe("json")
    expect(callProps.readOnly).toBe(true)
  })

  it("open=false 时不渲染对比模态，也不挂载 MonacoDiffEditor", () => {
    const html = renderToStaticMarkup(
      <SnapshotDiffModal open={false} original="" modified="" onClose={() => {}} />,
    )
    expect(html).toBe("")
    expect(mockDiff).not.toHaveBeenCalled()
  })

  it("SnapshotViewer 整体 SSR 冒烟：不抛错（历史列表由 effect 异步填充，SSR 不执行 effect）", () => {
    expect(() =>
      renderToStaticMarkup(
        <SnapshotViewer projectPath="/project" chapterNumber={1} onClose={() => {}} />,
      ),
    ).not.toThrow()
  })
})
