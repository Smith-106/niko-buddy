// @vitest-environment jsdom
/**
 * help-view.spec.tsx — 帮助视图（纯静态）契约。
 *
 * 覆盖（本视图为静态内容，与项目无关，无磁盘装载）：
 *   1. 空 projectPath → 照常渲染帮助索引（静态内容不设项目门）；
 *   2. 指定项目 → 渲染内容一致；
 *   3. 关键词过滤 → 命中条目保留、不命中分区裁掉，无匹配时诚实文案。
 *
 * `projectPath` 保留统一签名，组件内部 void；`@/commands/fs` mock 按统一要求保留。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(), listDirectory: vi.fn() }
})

import { HelpView, filterHelpSections, HELP_SECTIONS } from "./help-view"

afterEach(cleanup)

describe("HelpView", () => {
  it("空 projectPath → 照常渲染帮助索引", () => {
    render(<HelpView projectPath="" />)
    expect(screen.getByTestId("help-view")).toBeTruthy()
    expect(screen.getByTestId("help-section-nav")).toBeTruthy()
    expect(screen.getByTestId("help-section-ops")).toBeTruthy()
    expect(screen.getByTestId("help-section-faq")).toBeTruthy()
    expect(screen.getAllByTestId("help-item").length).toBeGreaterThan(0)
  })

  it("指定项目 → 渲染内容一致（静态内容与项目无关）", () => {
    render(<HelpView projectPath="C:/proj" />)
    expect(screen.getByTestId("help-sections")).toBeTruthy()
    expect(screen.getAllByTestId("help-item")).toHaveLength(
      HELP_SECTIONS.reduce((total, section) => total + section.items.length, 0),
    )
  })

  it("关键词过滤 → 命中保留、无匹配诚实文案", () => {
    render(<HelpView projectPath="C:/proj" />)
    fireEvent.change(screen.getByTestId("help-search"), { target: { value: "MCP" } })
    // 命中「MCP 服务如何启停」所在分区，不命中分区被裁掉。
    expect(screen.getByTestId("help-section-ops")).toBeTruthy()
    expect(screen.queryByTestId("help-section-faq")).toBeNull()
    expect(screen.queryByTestId("help-no-match")).toBeNull()
    fireEvent.change(screen.getByTestId("help-search"), { target: { value: "不存在的关键词xyz" } })
    expect(screen.getByTestId("help-no-match").textContent).toContain("无匹配的帮助条目")
  })

  it("filterHelpSections：空关键词返回全量，大小写不敏感", () => {
    expect(filterHelpSections(HELP_SECTIONS, "  ")).toBe(HELP_SECTIONS)
    const hit = filterHelpSections(HELP_SECTIONS, "mcp")
    expect(hit).toHaveLength(1)
    expect(hit[0]?.id).toBe("ops")
    expect(filterHelpSections(HELP_SECTIONS, "不存在的关键词xyz")).toHaveLength(0)
  })
})
