// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/layout/soul-sidebar-panel.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import type { CharacterAura, CharacterAuraBinding, CharacterAuraStore } from "@/lib/novel/character-aura-types"
import {
  render,
  screen,
  fireEvent,
  within,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { SoulSidebarPanel } from "./soul-sidebar-panel"

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const state: {
    project: { id: string; name: string; path: string } | null
    dataVersion: number
    selectedSoulId: string | null
    selectedSoulTab: "project" | "character"
    selectedSoulSection: "builtIn" | "custom"
    bumpDataVersion: ReturnType<typeof vi.fn>
    setSelectedSoulId: (id: string | null) => void
    setSelectedSoulTab: (tab: "project" | "character") => void
    setSelectedSoulSection: (section: "builtIn" | "custom") => void
  } = {
    project: null,
    dataVersion: 0,
    selectedSoulId: null,
    selectedSoulTab: "project",
    selectedSoulSection: "builtIn",
    bumpDataVersion: vi.fn(),
    setSelectedSoulId: (id) => {
      state.selectedSoulId = id
    },
    setSelectedSoulTab: (tab) => {
      state.selectedSoulTab = tab
    },
    setSelectedSoulSection: (section) => {
      state.selectedSoulSection = section
    },
  }
  return {
    state,
    t: vi.fn((key: string) => key),
    listCharacterAuras: vi.fn<(projectPath: string) => Promise<CharacterAura[]>>(async () => []),
    getCharacterAuraBindings: vi.fn<(projectPath: string) => Promise<CharacterAuraBinding[]>>(async () => []),
    bindCharacterAura: vi.fn<
      (projectPath: string, binding: CharacterAuraBinding, hasCharacterProfile: (projectPath: string, characterName: string) => Promise<boolean>) => Promise<CharacterAuraStore | undefined>
    >(async () => ({ customAuras: [], bindings: [] })),
    unbindCharacterAura: vi.fn<
      (projectPath: string, characterName: string, auraId?: string) => Promise<CharacterAuraStore | undefined>
    >(async () => ({ customAuras: [], bindings: [] })),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

vi.mock("@/lib/novel/character-aura", () => ({
  BUILT_IN_CHARACTER_AURAS: [
    { id: "builtin-a1", builtIn: true, name: "秦始皇", category: "历史帝王" },
    { id: "builtin-a2", builtIn: true, name: "李白" },
  ],
  listCharacterAuras: mocks.listCharacterAuras,
  getCharacterAuraBindings: mocks.getCharacterAuraBindings,
  bindCharacterAura: mocks.bindCharacterAura,
  unbindCharacterAura: mocks.unbindCharacterAura,
}))

vi.mock("@/components/layout/panel-header-with-help", () => ({
  PanelHeaderWithHelp: ({ title }: { title: string }) => <span>{title}</span>,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

const PROJECT = { id: "p1", name: "MyBook", path: "/p/mybook" }

const LOADED_AURAS = [
  {
    id: "builtin-a1", builtIn: true, name: "秦始皇", category: "历史帝王",
    sourceNote: "", corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "",
  },
  {
    id: "builtin-a2", builtIn: true, name: "李白",
    sourceNote: "", corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "",
  },
  {
    id: "custom-c1", builtIn: false, name: "自定义魂",
    sourceNote: "", corpus: "", styleDescription: "", behaviorRules: "", boundaries: "", notes: "",
  },
]

const BINDINGS = [{ characterName: "林冲", auraId: "builtin-a1" }]

/** 绑定行内唯一的 select（TL getByDisplayValue 对 select 匹配不可靠，直接按 DOM 取） */
function bindingSelect(): HTMLSelectElement {
  const el = document.querySelector("select")
  if (!el) throw new Error("binding select not found")
  return el as HTMLSelectElement
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
  mocks.state.project = PROJECT
  mocks.state.dataVersion = 0
  mocks.state.selectedSoulId = null
  mocks.state.selectedSoulTab = "project"
  mocks.state.selectedSoulSection = "builtIn"
  mocks.state.bumpDataVersion.mockClear()
  mocks.listCharacterAuras.mockClear()
  mocks.listCharacterAuras.mockResolvedValue(LOADED_AURAS)
  mocks.getCharacterAuraBindings.mockClear()
  mocks.getCharacterAuraBindings.mockResolvedValue(BINDINGS)
  mocks.bindCharacterAura.mockClear()
  mocks.bindCharacterAura.mockResolvedValue(undefined)
  mocks.unbindCharacterAura.mockClear()
  mocks.unbindCharacterAura.mockResolvedValue(undefined)
})

describe("SoulSidebarPanel", () => {
  it("无项目时 useEffect 早退，不加载 aura", async () => {
    mocks.state.project = null
    render(<SoulSidebarPanel />)
    expect(mocks.listCharacterAuras).not.toHaveBeenCalled()
    expect(screen.getByText("novel.soul.projectSoul")).toBeInTheDocument()
    expect(screen.getByText("还没有人物绑定角色灵魂")).toBeInTheDocument()
    expect(screen.getByText("novel.soul.characterSoul")).toBeInTheDocument()
  })

  it("有项目时加载 auras 与 bindings 并渲染绑定列表", async () => {
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("林冲")).toBeInTheDocument()
    })
    expect(mocks.listCharacterAuras).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.getCharacterAuraBindings).toHaveBeenCalledWith("/p/mybook")
    const select = bindingSelect()
    expect(select).toBeInTheDocument()
    // select 内三个 aura 选项
    const options = within(select).getAllByRole("option")
    expect(options.map((o) => o.getAttribute("value"))).toEqual([
      "builtin-a1",
      "builtin-a2",
      "custom-c1",
    ])
  })

  it("加载失败时静默吞掉（catch 空实现）", async () => {
    mocks.listCharacterAuras.mockRejectedValueOnce(new Error("load-fail"))
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(mocks.listCharacterAuras).toHaveBeenCalled()
    })
    expect(screen.getByText("还没有人物绑定角色灵魂")).toBeInTheDocument()
  })

  it("改绑成功：bindCharacterAura + 刷新 + bumpDataVersion + 成功消息", async () => {
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("林冲")).toBeInTheDocument()
    })
    const select = bindingSelect()
    fireEvent.change(select, { target: { value: "custom-c1" } })
    await waitFor(() => {
      expect(screen.getByText("已将「林冲」改绑到「自定义魂」")).toBeInTheDocument()
    })
    expect(mocks.bindCharacterAura).toHaveBeenCalledWith("/p/mybook", {
      characterName: "林冲",
      auraId: "custom-c1",
    })
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
  })

  it("改绑到相同 auraId → 直接返回不调用 bind", async () => {
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("林冲")).toBeInTheDocument()
    })
    const select = bindingSelect()
    fireEvent.change(select, { target: { value: "builtin-a1" } })
    expect(mocks.bindCharacterAura).not.toHaveBeenCalled()
    expect(screen.queryByText(/已将「林冲」/)).not.toBeInTheDocument()
  })

  it("改绑空 auraId → 直接返回", async () => {
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("林冲")).toBeInTheDocument()
    })
    const select = bindingSelect()
    fireEvent.change(select, { target: { value: "" } })
    expect(mocks.bindCharacterAura).not.toHaveBeenCalled()
  })

  it("项目变为 null 后改绑 → !project 早退", async () => {
    const { rerender } = render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("林冲")).toBeInTheDocument()
    })
    mocks.state.project = null
    rerender(<SoulSidebarPanel />)
    fireEvent.change(bindingSelect(), { target: { value: "custom-c1" } })
    expect(mocks.bindCharacterAura).not.toHaveBeenCalled()
    // 取消绑定同样被 !project 拦住
    fireEvent.click(screen.getByText("取消绑定"))
    expect(mocks.unbindCharacterAura).not.toHaveBeenCalled()
  })

  it("改绑失败（Error）→ 错误消息", async () => {
    mocks.bindCharacterAura.mockRejectedValueOnce(new Error("bind-fail"))
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("林冲")).toBeInTheDocument()
    })
    fireEvent.change(bindingSelect(), { target: { value: "custom-c1" } })
    await waitFor(() => {
      expect(screen.getByText("bind-fail")).toBeInTheDocument()
    })
  })

  it("改绑失败（非 Error）→ 兜底错误消息", async () => {
    mocks.bindCharacterAura.mockRejectedValueOnce("raw-string")
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("林冲")).toBeInTheDocument()
    })
    fireEvent.change(bindingSelect(), { target: { value: "custom-c1" } })
    await waitFor(() => {
      expect(screen.getByText("修改角色灵魂绑定失败，请稍后重试")).toBeInTheDocument()
    })
  })

  it("取消绑定成功", async () => {
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("林冲")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("取消绑定"))
    await waitFor(() => {
      expect(screen.getByText("已取消「林冲」的人物绑定")).toBeInTheDocument()
    })
    expect(mocks.unbindCharacterAura).toHaveBeenCalledWith("/p/mybook", "林冲", "builtin-a1")
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
  })

  it("取消绑定失败（Error）→ 错误消息", async () => {
    mocks.unbindCharacterAura.mockRejectedValueOnce(new Error("unbind-fail"))
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("林冲")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("取消绑定"))
    await waitFor(() => {
      expect(screen.getByText("unbind-fail")).toBeInTheDocument()
    })
  })

  it("取消绑定失败（非 Error）→ 兜底错误消息", async () => {
    mocks.unbindCharacterAura.mockRejectedValueOnce("raw-unbind")
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("林冲")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("取消绑定"))
    await waitFor(() => {
      expect(screen.getByText("取消绑定失败，请稍后重试")).toBeInTheDocument()
    })
  })

  it("项目 tab：project-soul / de-ai-skill 选中态与点击", async () => {
    mocks.state.selectedSoulId = "project-soul"
    const { rerender } = render(<SoulSidebarPanel />)
    const projectBtn = screen.getByText("novel.soul.projectSoulItem").closest("button") as HTMLElement
    expect(String(projectBtn.className)).toContain("qm-selected")
    fireEvent.click(screen.getByText("去AI味Skill"))
    expect(mocks.state.selectedSoulId).toBe("de-ai-skill")
    rerender(<SoulSidebarPanel />)
    const deAiBtn = screen.getByText("去AI味Skill").closest("button") as HTMLElement
    expect(String(deAiBtn.className)).toContain("qm-selected")

    // 回到 project tab 并点击 project-soul 条目（覆盖 onClick 与未选中态样式）
    fireEvent.click(screen.getByText("novel.soul.projectSoul"))
    expect(mocks.state.selectedSoulTab).toBe("project")
    rerender(<SoulSidebarPanel />)
    fireEvent.click(projectBtn)
    expect(mocks.state.selectedSoulId).toBe("project-soul")
    rerender(<SoulSidebarPanel />)
    expect(String(projectBtn.className)).toContain("qm-selected")
  })

  it("切换 tab：人物灵魂 → 角色面板；builtIn/custom 分节", async () => {
    const { rerender } = render(<SoulSidebarPanel />)
    fireEvent.click(screen.getByText("novel.soul.characterSoul"))
    expect(mocks.state.selectedSoulTab).toBe("character")
    rerender(<SoulSidebarPanel />)
    // 分节按钮存在（builtIn 为当前分节）
    const builtInBtn = screen
      .getAllByText("novel.soul.builtInSoul")
      .find((el) => el.tagName === "BUTTON") as HTMLElement
    expect(builtInBtn).toBeDefined()
    const customBtn = screen
      .getAllByText("novel.soul.customSoul")
      .find((el) => el.tagName === "BUTTON") as HTMLElement
    fireEvent.click(customBtn)
    expect(mocks.state.selectedSoulSection).toBe("custom")
    rerender(<SoulSidebarPanel />)
    // 等待异步 aura 加载完成（custom-c1 仅在加载后可见）
    await waitFor(() => {
      expect(screen.getByText("自定义魂")).toBeInTheDocument()
    })
    // 无 category 的自定义 aura → fallback t("novel.soul.customSoul")
    expect(screen.getAllByText("novel.soul.customSoul").length).toBe(2)
    expect(screen.getByText("novel.soul.newCustomSoul")).toBeInTheDocument()

    fireEvent.click(screen.getByText("novel.soul.newCustomSoul"))
    expect(mocks.state.selectedSoulId).toBe("new-custom-soul")

    // 切回 builtIn：有 category 显示真实分类，无 category 回退 t
    fireEvent.click(builtInBtn)
    rerender(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("历史帝王")).toBeInTheDocument()
    })
    expect(screen.getAllByText("novel.soul.builtInSoul").length).toBe(2)
  })

  it("custom 分节无自定义 aura → 空状态提示", async () => {
    mocks.state.selectedSoulTab = "character"
    mocks.state.selectedSoulSection = "custom"
    mocks.listCharacterAuras.mockResolvedValue(LOADED_AURAS.filter((a) => a.builtIn))
    render(<SoulSidebarPanel />)
    await waitFor(() => {
      expect(screen.getByText("novel.soul.noCustomSoul")).toBeInTheDocument()
    })
  })

  it("角色 aura 按钮点击 → setSelectedSoulId(aura.id) 并高亮", async () => {
    mocks.state.selectedSoulTab = "character"
    mocks.state.selectedSoulId = "builtin-a2"
    const { rerender } = render(<SoulSidebarPanel />)
    fireEvent.click(screen.getByText("秦始皇"))
    expect(mocks.state.selectedSoulId).toBe("builtin-a1")
    rerender(<SoulSidebarPanel />)
    const auraBtn = screen.getByText("秦始皇").closest("button") as HTMLElement
    expect(String(auraBtn.className)).toContain("qm-selected")
  })
})
