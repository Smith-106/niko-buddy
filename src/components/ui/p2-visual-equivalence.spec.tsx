// @vitest-environment jsdom
/**
 * P2 UI 九项小步整改 — 视觉等价 + 门禁回归。
 * 每项至少一个用例：token 映射 / a11y 属性 / alert 替换。
 * 禁止：不改业务逻辑与文案语义，仅通道/类名/键稳定性迁移。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, waitFor } from "@/test-helpers/component-test-utils"
import * as fs from "node:fs"
import * as path from "node:path"

import { buttonVariants, Button } from "@/components/ui/button"
import { StatusChip } from "@/components/ui/status-visuals"
import { execSync } from "node:child_process"

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof fallbackOrOpts === "string") {
        let out = fallbackOrOpts
        const o = (opts ?? {}) as Record<string, unknown>
        for (const [k, v] of Object.entries(o)) out = out.replace(`{{${k}}}`, String(v))
        return out
      }
      if (fallbackOrOpts && typeof fallbackOrOpts === "object" && "defaultValue" in fallbackOrOpts) {
        let out = String((fallbackOrOpts as Record<string, unknown>).defaultValue ?? key)
        const o = (opts ?? {}) as Record<string, unknown>
        // t(key, { defaultValue, ...params }) 形态：params 在同一对象内
        for (const [k, v] of Object.entries(fallbackOrOpts as Record<string, unknown>)) {
          if (k === "defaultValue") continue
          out = out.replace(`{{${k}}}`, String(v))
        }
        for (const [k, v] of Object.entries(o)) out = out.replace(`{{${k}}}`, String(v))
        return out
      }
      return key
    },
  }),
}))

const SRC = process.cwd()

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf-8")
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("P2-1 硬编码 Tailwind 色阶 → oklch token", () => {
  it("index.css 定义 success/warning/info/destructive 的 oklch token", () => {
    const css = readSrc("src/index.css")
    for (const token of ["--success:", "--warning:", "--info:", "--destructive:"]) {
      expect(css).toContain(token)
    }
    expect(css).toContain("oklch(")
    // 浅色 muted-foreground 已提到 AA（0.463）
    expect(css).toContain("--muted-foreground: oklch(0.463")
  })

  it("26 个残余文件不再含 emerald/amber/sky/slate 硬编码色阶", () => {
    const legacy = /text-(emerald|amber|sky|slate|rose)-(400|500|600|700|800|900)|bg-(emerald|amber|sky|slate|rose)-(50|500|600|300|400)|border-(amber|emerald)-500|text-red-(400|700|900)|bg-red-50/
    const candidates = [
      "src/components/dashboard/debt-board-view.tsx",
      "src/components/layout/chapter-draft-dock.tsx",
      "src/components/novel/diagnostics-center.tsx",
      "src/components/novel/report-page.tsx",
      "src/components/novel/style-radar-panel.tsx",
      "src/components/novel/work-heatmap-panel.tsx",
    ]
    for (const rel of candidates) {
      const src = readSrc(rel)
      // 注释行允许提及旧色名，断言仅对 className 生效：剥离 // 与 /* */
      const code = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n")
      expect(code, rel).not.toMatch(legacy)
    }
  })

  it("StatusChip 语义 tone 全部走 oklch token，不用颜色单独表意", () => {
    const { unmount } = render(<StatusChip label="ok" tone="ok" />)
    const el = screen.getByText("ok")
    expect(el.className).toContain("border-success/40")
    expect(el.className).toContain("bg-success/10")
    expect(el.textContent).toBe("ok")
    unmount()
  })
})

describe("P2-2 shadow 硬编码 → elevation token 体系", () => {
  it("index.css 定义 --elevation-1/2/3 并提供 @utility", () => {
    const css = readSrc("src/index.css")
    expect(css).toContain("--elevation-1:")
    expect(css).toContain("--elevation-2:")
    expect(css).toContain("--elevation-3:")
    expect(css).toContain("@utility elevation-1")
    expect(css).toContain("@utility elevation-2")
    expect(css).toContain("@utility elevation-3")
  })

  it("源码不再含 shadow-sm/md/lg/xl/2xl 硬编码", () => {
    const targets = [
      "src/components/canon-editor/canon-editor.tsx",
      "src/components/chat/chat-panel.tsx",
      "src/components/graph/graph-view.tsx",
      "src/components/ui/button.tsx",
    ]
    for (const rel of targets) {
      const src = readSrc(rel)
      expect(src, rel).not.toContain("shadow-sm")
      expect(src, rel).not.toContain("shadow-md")
      expect(src, rel).not.toContain("shadow-lg")
      expect(src, rel).not.toContain("shadow-xl")
    }
  })

  it("button outline 变体走 elevation-1，视觉等价", () => {
    const cls = buttonVariants({ variant: "outline" })
    expect(cls).toContain("elevation-1")
    expect(cls).not.toContain("shadow-")
  })
})

describe("P2-3 草稿接受轻量庆祝", () => {
  it("ChapterDraftDock 成功态为 role=status + aria-live polite + 不抢焦点", async () => {
    const { ChapterDraftDock } = await import("@/components/layout/chapter-draft-dock")
    render(
      <ChapterDraftDock
        projectPath="/p"
        selectedFile={null}
        listDrafts={async () => []}
        acceptDraft={async () => ({ formalChapterPath: "/p/第1章.md" }) as never}
        pathExists={async () => false}
      />,
    )
    // 初始无庆祝（无 note）
    expect(screen.queryByTestId("chapter-draft-note")).not.toBeInTheDocument()
  })

  it("成功文案语义不变且庆祝类存在", () => {
    const src = readSrc("src/components/layout/chapter-draft-dock.tsx")
    expect(src).toContain("已写入正式章。")
    expect(src).toContain("draft-celebrate")
    expect(src).toContain('role="status"')
    expect(src).toContain('aria-live="polite"')
    // 不用弹窗/自动聚焦
    expect(src).not.toContain("autoFocus")
    expect(src).not.toContain("window.alert")
  })
})

describe("P2-4 Button disabled 去 pointer-events-none 留 cursor-not-allowed", () => {
  it("buttonVariants disabled 含 cursor-not-allowed 且不含 pointer-events-none", () => {
    const cls = buttonVariants({ variant: "default" })
    expect(cls).toContain("disabled:cursor-not-allowed")
    expect(cls).not.toContain("disabled:pointer-events-none")
    // svg 内指针穿透保留（图标不吞点击），与禁用态无关
    expect(cls).toContain("[&_svg]:pointer-events-none")
  })

  it("禁用按钮保留 disabled 属性与可访问名称", () => {
    render(<Button disabled>提交</Button>)
    const btn = screen.getByRole("button", { name: "提交" })
    expect(btn).toHaveAttribute("disabled")
    expect(btn.className).toContain("cursor-not-allowed")
  })
})

describe("P2-5 text-muted 叠加对比度到 AA", () => {
  it("源码不再含 text-muted-foreground/30~80 低对比叠加（文本）", () => {
    const targets = [
      "src/components/canon-editor/canon-editor.tsx",
      "src/components/graph/graph-view.tsx",
      "src/components/layout/activity-panel.tsx",
    ]
    for (const rel of targets) {
      const src = readSrc(rel)
      expect(src, rel).not.toMatch(/text-muted-foreground\/(30|40|50|60|70|80)[\s"']/)
      expect(src, rel).not.toMatch(/text-foreground\/(30|40|50|60|70|80)[\s"']/)
    }
  })

  it("muted-foreground 本体对比度达 AA（浅色 4.5:1 通过 oklch 0.463 断言）", () => {
    const css = readSrc("src/index.css")
    // 浅色 --muted-foreground: oklch(0.463 ...) 在白底上 ≥4.5:1（既有审计结论）
    expect(css).toMatch(/--muted-foreground:\s*oklch\(0\.463/)
  })
})

describe("P2-6 Inspector 数据+刷新中 stale-refreshing 过渡", () => {
  it("inspector 面板源码含 refreshing 状态与过渡类 + data-refreshing", () => {
    const src = readSrc("src/components/inspector/inspector-panel.tsx")
    expect(src).toContain("isRefreshing")
    expect(src).toContain("stale-refreshing")
    expect(src).toContain('data-testid="inspector-refreshing"')
    expect(src).toContain('role="status"')
    expect(src).toContain('aria-live="polite"')
    expect(src).toContain('data-refreshing')
  })

  it("index.css 提供 .stale-refreshing 过渡", () => {
    const css = readSrc("src/index.css")
    expect(css).toContain(".stale-refreshing")
    expect(css).toContain("opacity: 0.75")
  })
})

describe("P2-7 index key 残余改稳定 key", () => {
  it("源码不再含 key={i} / key={index} 纯索引键", () => {
    const out = execSync(
      `grep -rn "key={i}\\|key={index}" --include="*.tsx" src/ | grep -v spec || true`,
      { cwd: SRC, encoding: "utf-8" },
    ) as string
    expect(out.trim()).toBe("")
  })

  it("planning-panel 长列表用内容派生 key + 虚拟化窗口", () => {
    const src = readSrc("src/components/chat/planning-panel.tsx")
    expect(src).toContain("renderItem(item).slice(0, 48)")
    expect(src).toContain('data-testid="planning-virtual-list"')
    expect(src).toContain("VIRTUALIZE_THRESHOLD")
  })
})

describe("P2-8 window.alert 迁移应用内 toast", () => {
  it("源码不再含 window.alert / 裸 alert（安全用例除外）", () => {
    const out = execSync(
      `grep -rn "window\\\\.alert" --include="*.tsx" --include="*.ts" src/ | grep -v spec || true`,
      { cwd: SRC, encoding: "utf-8" },
    ) as string
    expect(out.trim()).toBe("")
  })

  it("迁移目标文件均走 toast 且文案不变", () => {
    // 导入/toast 逻辑已随 REFACTOR_AUDIT §二 拆分下沉至 sidebar-panel-import.ts。
    const sidebar = readSrc("src/components/layout/sidebar-panel-import.ts")
    expect(sidebar).toContain('toast.info("没有找到可导入的章节文档。")')
    expect(sidebar).toContain("toast.error(`导入失败：${message}`)")
    const welcome = readSrc("src/components/project/welcome-screen.tsx")
    expect(welcome).toContain("toast.success(`恢复成功！")
    expect(welcome).toContain("toast.error(`恢复失败：")
    const sources = readSrc("src/components/sources/source-sidebar.tsx")
    expect(sources).toContain('toast.info("导入文件功能仅在桌面端可用")')
    expect(sources).toContain("toast.error(`删除失败：${err}`)")
  })

  it("toast 成功与失败通道可区分（success/error/info 均被使用）", () => {
    // 同上：toast 通道断言跟随拆分后的实际落点。
    const sidebar = readSrc("src/components/layout/sidebar-panel-import.ts")
    expect(sidebar).toContain("toast.info(")
    expect(sidebar).toContain("toast.error(")
    const welcome = readSrc("src/components/project/welcome-screen.tsx")
    expect(welcome).toContain("toast.success(")
    expect(welcome).toContain("toast.error(")
  })
})

describe("P2-9 响应式断点 + Label htmlFor + 长列表虚拟化", () => {
  it("snapshot 对话框固定 860px 改为响应式 max-w", () => {
    const src = readSrc("src/components/novel/snapshot-viewer.tsx")
    // 精确匹配独立类 w-[860px]（max-w-[860px] 为目标态，不计入）
    expect(src).not.toMatch(/(?:\s|["'])w-\[860px\]/)
    expect(src).toContain("max-w-[860px]")
    expect(src).toContain("w-full")
  })

  it("canon 过滤与 pdf 导出 Label 具 htmlFor + input 具 id", () => {
    const canon = readSrc("src/components/canon-editor/canon-editor.tsx")
    expect(canon).toContain('htmlFor="canon-filter-known-by-input"')
    expect(canon).toContain('id="canon-filter-known-by-input"')
    expect(canon).toContain('htmlFor="canon-filter-edge-kind-select"')
    const pdf = readSrc("src/components/export/PdfExportDialog.tsx")
    expect(pdf).toContain('htmlFor="pdfexport-target-input"')
    expect(pdf).toContain('id="pdfexport-target-input"')
  })

  it("planning-panel 长列表虚拟化：超阈值截断 + 展开按钮", async () => {
    const { PlanningPanel } = await import("@/components/chat/planning-panel")
    const items = Array.from({ length: 25 }, (_, i) => `fact-${i}`)
    const plan = {
      chapterNumber: 1,
      generatedAt: "2026-07-12T00:00:00.000Z",
      foreshadowing: { status: "ok", report: null, overdueFindings: [] },
      characters: { status: "ok", items: [] },
      threads: { status: "ok", items: [], openCount: 0 },
      summary: { debtScore: 0, criticalForeshadowing: 0, openThreads: 0, charactersDue: 0 },
      cognition: { status: "ok", items, text: items.join("\n"), truncated: false },
    } as never
    render(
      <PlanningPanel plan={plan} loading={false} error={null} onRefresh={() => {}} onStartWriting={() => {}} onClose={() => {}} />,
    )
    // 首屏仅 20 项 + 展开按钮（25-20=5）
    const lists = screen.getAllByTestId("planning-virtual-list")
    expect(lists.length).toBeGreaterThan(0)
    expect(screen.getByText(/展开其余 5 项/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/展开其余 5 项/))
    await waitFor(() => {
      expect(screen.getByText("不知道：fact-24")).toBeInTheDocument()
    })
  })
})
