// @vitest-environment jsdom
// SEQ-47 repro: CharacterState.relationships dead-field vs missing render.
// Proves: store carries non-empty relationships, CognitionPanel (successor of
// character-profile.tsx, merged via a558d819) does not render them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import type { CognitionState, CharacterStateStore } from "@/lib/novel"

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts && typeof opts === "object" && "defaultValue" in opts ? String((opts as Record<string, unknown>).defaultValue) : key) }),
}))

const wiki = vi.hoisted(() => ({ state: { dataVersion: 0 } }))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
  }
})

const cognition = vi.hoisted(() => ({
  loadCognitionState: vi.fn<(path: string) => Promise<CognitionState | null>>(async () => null),
  loadCharacterStates: vi.fn<(path: string) => Promise<CharacterStateStore>>(async () => ({ characters: [], lastUpdated: "" })),
}))

vi.mock("@/lib/novel/character-cognition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/character-cognition")>()
  return { ...actual, loadCognitionState: cognition.loadCognitionState }
})

vi.mock("@/lib/novel/character-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/character-state")>()
  return { ...actual, loadCharacterStates: cognition.loadCharacterStates }
})

import { CognitionPanel } from "./cognition-panel"

const cognitionState: CognitionState = {
  characters: [{ character: "林烬", knows: ["线索A"], doesNotKnow: [] }],
  readerKnows: [],
  lastUpdatedChapter: 1,
}

const charStore: CharacterStateStore = {
  characters: [
    {
      characterName: "林烬",
      currentLocation: "皇城",
      status: "在场",
      equipment: [],
      abilities: [],
      relationships: { "沈微": "旧识同盟", "阿宁": "宿敌" },
      lastUpdatedChapter: 1,
      lastUpdatedAt: "2026-07-25T10:00:00.000Z",
    },
  ],
  lastUpdated: "2026-07-25T10:00:00.000Z",
}

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.dataVersion = 0
  cognition.loadCognitionState.mockResolvedValue(cognitionState)
  cognition.loadCharacterStates.mockResolvedValue(charStore)
})

afterEach(() => cleanup())

describe("SEQ-47 relationships render (ISS-20260712-009)", () => {
  it("renders stored relationships instead of dropping them", async () => {
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    // 林烬卡片必须出现
    expect(await screen.findByText("林烬")).toBeInTheDocument()
    // 展开状态详情折叠块
    const summaries = await screen.findAllByText("novel.character.status")
    expect(summaries.length).toBeGreaterThan(0)
    fireEvent.click(summaries[0])
    // 存储的人际关系必须渲染（死字段修复的核心断言）
    expect(await screen.findByText(/沈微/)).toBeInTheDocument()
    expect(screen.getByText(/旧识同盟/)).toBeInTheDocument()
    expect(screen.getByText(/阿宁/)).toBeInTheDocument()
    expect(screen.getByText(/宿敌/)).toBeInTheDocument()
  })
})
