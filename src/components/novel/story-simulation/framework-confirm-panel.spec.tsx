// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/framework-confirm-panel.tsx（自动生成，核心行为由专项 spec 加深） */
import { afterEach, describe, expect, it, vi } from "vitest"
import { FrameworkConfirmPanel } from "./framework-confirm-panel"
import { render, screen } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import type { ComponentType } from "react"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import type { StoryFramework } from "@/lib/novel"

afterEach(() => {
  cleanup()
  useStorySimulationStore.setState({ currentFramework: null } as never)
})

describe("framework-confirm-panel.tsx smoke", () => {
  it("renders FrameworkConfirmPanel without crashing", () => {
    const C = FrameworkConfirmPanel as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })

  it("批次二·9：生成失败回退的空框架不能确认，提示先重新生成", () => {
    const empty = {
      id: "f1",
      title: "故事框架（生成失败，已回退为空框架）",
      shortTitle: "生成失败",
      premise: "llm-down",
      targetWords: 1000,
      simulationMode: "quick",
      sourceChapters: 0,
      nodes: [],
      createdAt: "2026-10-30T00:00:00.000Z",
    } as unknown as StoryFramework
    useStorySimulationStore.setState({ currentFramework: empty } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    expect(screen.getByTestId("framework-empty-hint")).toBeTruthy()
    const confirm = screen.getByRole("button", { name: /confirmFramework|确认框架/ }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })
})
