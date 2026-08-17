// @vitest-environment jsdom
/**
 * SoulView — 灵魂库视图路由（wiki-store selectedSoulId/selectedSoulTab 驱动）。
 * 三个分支：de-ai-skill → DeAiSkillEditor；project / project-soul → SoulDocEditor；
 * 其余 → CharacterAuraView(hideSidebar)。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"

const wiki = vi.hoisted(() => ({
  state: { selectedSoulId: null as string | null, selectedSoulTab: "character" as string },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
}))

vi.mock("./de-ai-skill-editor", () => ({
  DeAiSkillEditor: () => <div data-testid="de-ai-skill-editor" />,
}))

vi.mock("./soul-doc-editor", () => ({
  SoulDocEditor: () => <div data-testid="soul-doc-editor" />,
}))

vi.mock("./character-aura-view", () => ({
  CharacterAuraView: (props: { hideSidebar?: boolean }) => <div data-testid="character-aura-view">{`hideSidebar:${String(props.hideSidebar)}`}</div>,
}))

import { SoulView } from "./soul-view"

afterEach(() => cleanup())

describe("SoulView", () => {
  it("renders DeAiSkillEditor when selectedSoulId is de-ai-skill", () => {
    wiki.state.selectedSoulId = "de-ai-skill"
    wiki.state.selectedSoulTab = "character"
    render(<SoulView />)
    expect(screen.getByTestId("de-ai-skill-editor")).toBeInTheDocument()
  })

  it("renders SoulDocEditor when selectedSoulTab is project", () => {
    wiki.state.selectedSoulId = "some-aura"
    wiki.state.selectedSoulTab = "project"
    render(<SoulView />)
    expect(screen.getByTestId("soul-doc-editor")).toBeInTheDocument()
  })

  it("renders SoulDocEditor when selectedSoulId is project-soul", () => {
    wiki.state.selectedSoulId = "project-soul"
    wiki.state.selectedSoulTab = "character"
    render(<SoulView />)
    expect(screen.getByTestId("soul-doc-editor")).toBeInTheDocument()
  })

  it("falls back to CharacterAuraView with hideSidebar", () => {
    wiki.state.selectedSoulId = "aura-1"
    wiki.state.selectedSoulTab = "character"
    render(<SoulView />)
    expect(screen.getByTestId("character-aura-view")).toHaveTextContent("hideSidebar:true")
  })
})
