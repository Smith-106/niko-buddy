import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * EPIC-001 / TASK-005 / ADR-29: exemplar 标记 UI 源码断言。
 *
 * chat-panel.tsx 是 2200+ 行大文件 — 用源码字符串断言（与现有
 * chat-panel.spec.tsx 同模式）验证 exemplar UI 闭环要素存在，避免重度
 * 组件渲染 mock（项目测试惯例：chat-panel 用源码断言而非渲染）。
 */
describe("chat-panel exemplar UI (TASK-005 / EPIC-001 / ADR-29)", () => {
  const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

  it("imports the exemplar Rust command wrapper (UI → commands/exemplar → Rust)", () => {
    expect(source).toContain('from "@/commands/exemplar"')
    expect(source).toContain("markStyleExemplarViaRust")
    expect(source).toContain("loadStyleExemplarsViaRust")
  })

  it("imports appendExemplarABSample + exemplarABStats for A/B ROI capture", () => {
    expect(source).toContain("appendExemplarABSample")
    expect(source).toContain("exemplarABStats")
    expect(source).toContain("loadCognitionState")
  })

  it("has a '标记为 Style Exemplar' trigger button (novelMode footer control)", () => {
    expect(source).toContain("标记为 Style Exemplar")
    expect(source).toContain("openExemplarDialogFromSelection")
  })

  it("has markType selection (style/voice/pacing enum)", () => {
    expect(source).toContain('value="style"')
    expect(source).toContain('value="voice"')
    expect(source).toContain('value="pacing"')
    expect(source).toContain("exemplarMarkType")
  })

  it("has optional note input", () => {
    expect(source).toContain("exemplarNote")
    expect(source).toContain("setExemplarNote")
  })

  it("invokes mark_style_exemplar Rust command via wrapper on submit", () => {
    expect(source).toContain("submitExemplarMark")
    expect(source).toContain("markStyleExemplarViaRust(pp,")
  })

  it("shows exemplar count from loadStyleExemplarsViaRust", () => {
    expect(source).toContain("exemplarCount")
    expect(source).toContain("setExemplarCount")
  })

  it("marks exemplar as user anchor non-auto-generated (C-001 Draft-first exception wording)", () => {
    // C-001 措辞：UI 明确标注「用户标记锚点」非自动生成。
    expect(source).toContain("用户标记锚点")
    expect(source).toContain("非自动生成")
    expect(source).toContain("Draft-first")
  })

  it("has A/B score capture (1-5 stars, enabled/disabled variant)", () => {
    expect(source).toContain("submitExemplarABScore")
    expect(source).toContain('"enabled"')
    expect(source).toContain('"disabled"')
    // 1-5 星评分按钮。
    expect(source).toContain("[1, 2, 3, 4, 5]")
  })

  it("uses window.getSelection for selection-based marking (minimal intrusion)", () => {
    expect(source).toContain("window.getSelection")
  })
})
