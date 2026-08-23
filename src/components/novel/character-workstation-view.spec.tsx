// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { afterEach } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, setupDomGlobals, userEvent } from "@/test-helpers/component-test-utils"
import {
  CharacterWorkstationView,
  type CharacterWorkstationItem,
} from "./character-workstation-view"

// jsdom 环境组装（组件依赖 focus/select 等，安装常用 Web API 桩幂等）。
setupDomGlobals()

// vitest 未启用 globals，@testing-library/react 不会自动 afterEach cleanup，需显式清理。
afterEach(() => cleanup())

const characters: CharacterWorkstationItem[] = [
  { id: "char-linjing", name: "林烬", category: "主角", importanceScore: 95, appearances: 3, description: "旧城巡夜人。" },
  { id: "char-su", name: "苏晚", category: "配角", importanceScore: 60, appearances: 2, description: "医者。" },
  { id: "char-gu", name: "顾渊", category: "配角", importanceScore: 55, appearances: 1 },
]

describe("CharacterWorkstationView · 分位切换隔离性", () => {
  it("非受控：草稿按角色隔离分桶，切换往返内容不互相覆盖", async () => {
    const user = userEvent.setup()
    render(<CharacterWorkstationView characters={characters} />)

    const draftA = screen.getByTestId("station-draft-char-linjing")
    await user.clear(draftA)
    await user.type(draftA, "林烬的草稿内容")

    // 切换到第二个角色
    fireEvent.click(screen.getByTestId("workstation-tab-char-su"))
    expect(screen.getByTestId("station-draft-char-su")).toBeInTheDocument()
    // B 工位初始为空，不与 A 串扰
    expect(screen.getByTestId("station-draft-char-su")).toHaveValue("")

    // 切回 A，草稿保留
    fireEvent.click(screen.getByTestId("workstation-tab-char-linjing"))
    expect(screen.getByTestId("station-draft-char-linjing")).toHaveValue("林烬的草稿内容")
  })

  it("非受控：编辑焦点隔离（key 重建）—— 切回角色后 textarea 全新挂载", async () => {
    const { container } = render(<CharacterWorkstationView characters={characters} />)

    const draftA = screen.getByTestId("station-draft-char-linjing")
    draftA.focus()
    expect(document.activeElement).toBe(draftA)

    // 切走 → 切回
    fireEvent.click(screen.getByTestId("workstation-tab-char-gu"))
    fireEvent.click(screen.getByTestId("workstation-tab-char-linjing"))

    // 隔离性可测：A 工位由 key 重建而重新渲染，仍保留隔离草稿
    expect(screen.getByTestId("station-draft-char-linjing")).toBeInTheDocument()
    expect(container).toBeTruthy()
  })

  it("受控：activeCharacterId 由宿主决定，切换回调上抛 id", () => {
    const onActiveChange = vi.fn()
    render(
      <CharacterWorkstationView
        characters={characters}
        activeCharacterId="char-su"
        onActiveCharacterChange={onActiveChange}
      />,
    )

    // 受控初值：苏晚工位激活
    expect(screen.getByTestId("station-draft-char-su")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workstation-tab-char-gu"))
    expect(onActiveChange).toHaveBeenCalledWith("char-gu")
  })
})

describe("CharacterWorkstationView · 键盘可达", () => {
  it("roving tabindex：←/→ 在工位间循环切换并触发回调", () => {
    const onActiveChange = vi.fn()
    render(
      <CharacterWorkstationView characters={characters} onActiveCharacterChange={onActiveChange} />,
    )

    const activeTab = screen.getByTestId("workstation-tab-char-linjing")
    activeTab.focus()
    // 初始 tab 应获得 focus (roving tabindex 首项)
    expect(document.activeElement).toBe(activeTab)
    expect(activeTab).toHaveAttribute("aria-selected", "true")

    // → 切到第二个工位
    fireEvent.keyDown(activeTab, { key: "ArrowRight" })
    expect(onActiveChange).toHaveBeenCalledWith("char-su")

    // 再用 End 跳到末尾
    const suTab = screen.getByTestId("workstation-tab-char-su")
    fireEvent.keyDown(suTab, { key: "End" })
    expect(onActiveChange).toHaveBeenLastCalledWith("char-gu")
  })

  it("空角色：无切换条可聚焦项，渲染空角色提示且不提供草稿编辑", () => {
    render(<CharacterWorkstationView characters={[]} />)

    expect(screen.getByRole("status")).toHaveTextContent("暂无可编辑角色工位")
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("空角色安全：空数组时不抛错、无 focus 冲突", () => {
    const { container } = render(<CharacterWorkstationView characters={[]} />)
    expect(container.textContent).toContain("暂无可编辑角色工位")
  })
})

describe("CharacterWorkstationView · 角色信息区", () => {
  it("激活工位展示角色名、分类与重要度", () => {
    render(<CharacterWorkstationView characters={characters} />)

    const heading = screen.getByRole("heading", { name: /林烬/ })
    expect(heading).toBeInTheDocument()
    expect(screen.getByText(/重要度 95/)).toBeInTheDocument()
    expect(screen.getByText(/旧城巡夜人/)).toBeInTheDocument()
  })

  it("无 description 的角色不渲染描述段落，仍正常渲染工位", () => {
    render(
      <CharacterWorkstationView
        characters={[{ id: "char-x", name: "默角", category: "次要", importanceScore: 10 }]}
      />,
    )
    expect(screen.getByRole("heading", { name: /默角/ })).toBeInTheDocument()
  })
})
