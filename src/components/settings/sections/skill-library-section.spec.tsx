// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import { SkillLibrarySection } from "./skill-library-section"

describe("SkillLibrarySection", () => {
  beforeEach(() => {
    render(<SkillLibrarySection />)
  })

  afterEach(() => {
    cleanup()
  })

  it("渲染技能库标题与说明", () => {
    expect(screen.getByText("技能库")).toBeInTheDocument()
    expect(screen.getByText(/内置写作技能/)).toBeInTheDocument()
  })

  it("列出全部内置技能（名称 + 用途）", () => {
    expect(screen.getByText("去 AI 化写作")).toBeInTheDocument()
    expect(screen.getByText("好文笔")).toBeInTheDocument()
    expect(screen.getByText("作品灵魂")).toBeInTheDocument()
    expect(screen.getByText(/de-ai 批处理/)).toBeInTheDocument()
    expect(screen.getByText(/角色灵魂装配/)).toBeInTheDocument()
  })
})
