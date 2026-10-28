// @vitest-environment jsdom
/**
 * UX 真审计 G3 回归用例（run-45691693d82a）。
 *
 * 覆盖本步 6 处产品修复；静态守卫防止护栏被静默删除，
 * 行为用例钉住焦点管理 / 键盘可达 / 错误恢复 / 空态入口。
 */
import { readFileSync } from "node:fs"
import { cleanup as rtlCleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { act, fireEvent, render, screen, setupDomGlobals, waitFor } from "@/test-helpers/component-test-utils"

const novelMocks = vi.hoisted(() => ({
  confirmGate: vi.fn(),
  rejectGate: vi.fn(),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    confirmGate: novelMocks.confirmGate,
    rejectGate: novelMocks.rejectGate,
  }
})

// 与生产同口径的 i18n 测试替身：扁平键优先、嵌套回退、缺 key 时用 defaultValue
// （生产 i18next 同行为），避免把“缺 key 回退”误判为用例失败。
vi.mock("react-i18next", async () => {
  const zh = (await import("@/i18n/zh.json")).default as Record<string, unknown>
  function lookup(key: string): string | undefined {
    if (typeof zh[key] === "string") return zh[key] as string
    let o: unknown = zh
    for (const p of key.split(".")) {
      if (o == null || typeof o !== "object") return undefined
      o = (o as Record<string, unknown>)[p]
    }
    return typeof o === "string" ? o : undefined
  }
  const t = (key: string, opts?: Record<string, unknown>) => {
    let s: string = lookup(key) ?? (typeof opts?.defaultValue === "string" ? (opts.defaultValue as string) : key)
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (k === "defaultValue") continue
        s = s.split(`{{${k}}}`).join(String(v))
      }
    }
    return s
  }
  const shared = { t, i18n: { language: "zh", changeLanguage: () => Promise.resolve("zh") } }
  return {
    initReactI18next: { type: "3rdParty", init: () => {} },
    useTranslation: () => shared,
    Trans: ({ children }: { children?: unknown }) => children,
    I18nextProvider: ({ children }: { children?: unknown }) => children,
  }
})

import type { PendingGate } from "@/lib/novel"
import { ConfirmGateDialog } from "@/components/gate/ConfirmGateDialog"
import { CharacterSelectionPanel } from "@/components/novel/character-selection-panel"
import { ChapterDirectory } from "@/components/novel/chapter-directory"
import { BookshelfView } from "@/components/novel/bookshelf-view"
import { useWikiStore } from "@/stores/wiki-store"

function readSrc(path: string): string {
  return readFileSync(path, "utf-8")
}

function pendingGate(overrides: Partial<PendingGate> = {}): PendingGate {
  const createdAt = Date.now()
  return {
    request_id: "req-g3",
    op: "batchReplace",
    target: "QM/memory/facts.md",
    class: "irreversible",
    hit_criteria: ["protected_prefix"],
    actor: "external",
    created_at_ms: createdAt,
    deadline_ms: createdAt + 120_000,
    diff_summary: "-旧 +新",
    ...overrides,
  }
}

beforeEach(() => {
  setupDomGlobals()
  novelMocks.confirmGate.mockReset().mockResolvedValue({
    decision: "allowed", class: "irreversible", hit_criteria: [], request_id: "req-g3", reason: "",
  })
  novelMocks.rejectGate.mockReset().mockResolvedValue({
    decision: "denied", class: "irreversible", hit_criteria: [], request_id: "req-g3", reason: "",
  })
})

afterEach(() => {
  rtlCleanup()
  vi.restoreAllMocks()
})

describe("G3-F1 审稿 delete: 分支删除确认", () => {
  it("delete: 分支先 window.confirm 才调 deleteFile", () => {
    const src = readSrc("src/components/review/review-view.tsx")
    const branch = src.indexOf('action.startsWith("delete:")')
    expect(branch).toBeGreaterThan(-1)
    const window_ = src.slice(branch, branch + 1200)
    expect(window_).toContain("window.confirm")
    expect(window_.indexOf("window.confirm")).toBeLessThan(window_.indexOf("deleteFile"))
  })
})

describe("G3-F2 回收站永久删除确认", () => {
  it("单删与清空均先 window.confirm，且危险按钮走 i18n", () => {
    const src = readSrc("src/components/layout/trash-panel.tsx")
    expect(src).toContain("trash.permanentDeleteConfirm")
    expect(src).toContain("trash.emptyTrashConfirm")
    expect(src).toContain("trash.emptyTrash")
    // 确认在删除调用之前
    const single = src.indexOf("handlePermanentDelete")
    expect(src.slice(single, single + 1500)).toContain("window.confirm")
    const all = src.indexOf("handleDeleteAll")
    expect(src.slice(all, all + 1500)).toContain("window.confirm")
  })
})

describe("G3-F3 确认门焦点管理", () => {
  it("打开时聚焦确认按钮、按钮有可见焦点环、容器可编程聚焦", async () => {
    render(<ConfirmGateDialog pending={pendingGate()} />)
    const accept = screen.getByTestId("confirm-gate-accept")
    // 去抖：全量并行负载下 jsdom 聚焦回调可能远慢于单跑，放宽内部等待窗口。
    await waitFor(() => expect(document.activeElement).toBe(accept), { timeout: 25_000 })
    expect(accept.className).toContain("focus-visible:ring-2")
    expect(screen.getByTestId("confirm-gate-reject").className).toContain("focus-visible:ring-2")
    const dialog = screen.getByTestId("confirm-gate-dialog")
    expect(dialog.getAttribute("tabindex")).toBe("-1")
  }, 60_000)

  it("Esc 仍按拒绝裁决（焦点改造不破坏关闭路径）", async () => {
    render(<ConfirmGateDialog pending={pendingGate()} />)
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" })
    })
    await waitFor(() => expect(novelMocks.rejectGate).toHaveBeenCalledWith("req-g3", expect.any(String)), { timeout: 10_000 })
  }, 30_000)
})

describe("G3-F4 角色选择行键盘可达", () => {
  const characters = [
    { id: "c1", name: "阿宁", aliases: [], appearances: 12, chapterIndices: [1], importanceScore: 90, category: "主角", sourceBook: "b1" },
  ] as unknown as Parameters<typeof CharacterSelectionPanel>[0]["characters"]

  function renderPanel(onToggle: (id: string) => void) {
    return render(
      <CharacterSelectionPanel
        characters={characters}
        selectedIds={[]}
        onToggle={onToggle}
        onSelectAllMain={() => {}}
        onClear={() => {}}
        onDeepExtract={() => {}}
        onSimpleExtract={() => {}}
        onCancel={() => {}}
      />,
    )
  }

  it("行可聚焦、有 checkbox 语义、Enter/Space 触发切换", () => {
    const onToggle = vi.fn()
    renderPanel(onToggle)
    const row = screen.getByTestId("character-row-c1")
    expect(row.getAttribute("tabindex")).toBe("0")
    expect(row.getAttribute("role")).toBe("checkbox")
    expect(row.getAttribute("aria-checked")).toBe("false")
    fireEvent.keyDown(row, { key: "Enter" })
    expect(onToggle).toHaveBeenCalledWith("c1")
    onToggle.mockClear()
    fireEvent.keyDown(row, { key: " " })
    expect(onToggle).toHaveBeenCalledWith("c1")
  })
})

describe("G3-F5 章节目录错误态重试", () => {
  it("加载失败显示重试按钮，点击后重新装载", async () => {
    useWikiStore.getState().setProject({ id: "g3", name: "g3", path: "/tmp/uxg3-nonavail" })
    try {
      const loader = vi.fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ outlines: [], volumes: [] })
      render(<ChapterDirectory loader={loader} />)
      const retry = await screen.findByTestId("chapter-directory-retry")
      expect(retry).toBeInTheDocument()
      fireEvent.click(retry)
      await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
    } finally {
      useWikiStore.getState().setProject(null)
    }
  })
})

describe("G3-F6 书架空态直达入口", () => {
  it("空书架出现去拆书分析按钮，点击跳转 bookAnalysis", async () => {
    const before = useWikiStore.getState().activeView
    render(<BookshelfView projectPath="/tmp/uxg3-no-such-project" />)
    try {
      const cta = await screen.findByTestId("bookshelf-empty-cta")
      expect(cta).toBeInTheDocument()
      fireEvent.click(cta)
      expect(useWikiStore.getState().activeView).toBe("bookAnalysis")
    } finally {
      useWikiStore.getState().setActiveView(before)
    }
  })
})

describe("G3-D4 打开项目失败提示可操作", () => {
  it("App 失败 toast 含行动句而非裸原始串", () => {
    const src = readSrc("src/App.tsx")
    expect(src).not.toContain("toast.error(`打开项目失败：${err}`)")
    expect(src).toContain("请检查目录是否存在且可读")
  })
})
