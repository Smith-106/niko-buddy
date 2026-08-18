// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import type { BookAnalysisLibraryBook } from "@/lib/novel/book-analysis/library-state"
import { BookAnalysisCharacterPanel } from "./book-analysis-character-panel"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const book: BookAnalysisLibraryBook = {
  id: "book-1",
  path: "E:/Novel/book-analysis/book-1",
  metadata: {
    title: "长夜书",
    totalChapters: 3,
    totalWords: 12000,
    sourceType: "file",
    createdAt: 1,
    updatedAt: 2,
  },
  recognizedCharacters: [],
  characters: [{
    id: "char-linjing",
    name: "林烬",
    aliases: [],
    importance: 9,
    category: "protagonist",
    firstAppearance: 1,
    lastAppearance: 3,
    appearanceCount: 3,
    description: "旧城巡夜人。",
    personality: "克制。",
    speechStyle: "短句。",
    relationships: [],
    keyEvents: [],
    corpus: "",
  }],
  skills: [{
    id: "skill-char-linjing",
    characterId: "char-linjing",
    characterName: "林烬",
    skillContent: "# 林烬 Skill",
    sourceBook: "长夜书",
    chapterRange: ["1", "3"],
    createdAt: 3,
  }],
  styleStatus: "missing",
  boundAurasCount: 0,
  addedAuraCharacterIds: [],
}

function renderPanel(
  props: Partial<Parameters<typeof BookAnalysisCharacterPanel>[0]> = {},
) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <BookAnalysisCharacterPanel
        book={book}
        selectedCharacterId="char-linjing"
        addingToSoul={false}
        onSelectCharacter={vi.fn()}
        onAddSelectedSkillsToSoul={vi.fn()}
        {...props}
      />,
    )
  })
  return {
    container,
    addButton: container.querySelector("button") as HTMLButtonElement,
    cleanup: () => {
      act(() => root.unmount())
      document.body.removeChild(container)
    },
  }
}

describe("BookAnalysisCharacterPanel", () => {
  it("点击加入自定义灵魂库时只传当前选中角色的 skill", () => {
    const onAddSelectedSkillsToSoul = vi.fn()
    const { addButton, cleanup } = renderPanel({ onAddSelectedSkillsToSoul })

    act(() => addButton.click())

    expect(onAddSelectedSkillsToSoul).toHaveBeenCalledWith("skill-char-linjing")
    cleanup()
  })

  it("当前角色已加入自定义灵魂库时按钮不可点击", () => {
    const onAddSelectedSkillsToSoul = vi.fn()
    const { addButton, cleanup } = renderPanel({
      book: { ...book, addedAuraCharacterIds: ["char-linjing"] },
      onAddSelectedSkillsToSoul,
    })

    expect(addButton.disabled).toBe(true)
    expect(addButton.textContent).toContain("已加入自定义灵魂库")

    act(() => addButton.click())
    expect(onAddSelectedSkillsToSoul).not.toHaveBeenCalled()
    cleanup()
  })

  it("does not render the bind-to-novel-character action", () => {
    const { container, cleanup } = renderPanel()

    expect(container.textContent).not.toContain("绑定到小说人物")
    cleanup()
  })

  it("selectedCharacterId 不匹配时回退到 characters[0]", () => {
    const { container, addButton, cleanup } = renderPanel({ selectedCharacterId: "nonexistent" })

    expect(container.textContent).toContain("林烬")
    expect(addButton.disabled).toBe(false)
    cleanup()
  })

  it("无角色数据：空态 + 右侧占位 + 按钮禁用", () => {
    const { container, addButton, cleanup } = renderPanel({
      book: { ...book, characters: [], skills: [] },
      selectedCharacterId: null,
    })

    expect(container.textContent).toContain("暂无角色数据。")
    expect(container.textContent).toContain("请从左侧选择角色。")
    expect(addButton.disabled).toBe(true)
    expect(addButton.textContent).toContain("加入自定义灵魂库")
    cleanup()
  })

  it("点击角色按钮 → onSelectCharacter；未生成 skill 的角色显示未生成且按钮禁用", () => {
    const onSelectCharacter = vi.fn()
    const bookWithTwo: BookAnalysisLibraryBook = {
      ...book,
      characters: [
        ...book.characters,
        {
          id: "char-su",
          name: "苏晚",
          aliases: [],
          importance: 5,
          category: "supporting",
          firstAppearance: 1,
          lastAppearance: 2,
          appearanceCount: 2,
          description: "医者。",
          personality: "温和。",
          speechStyle: "轻声。",
          relationships: [],
          keyEvents: [],
          corpus: "",
        },
      ],
    }
    const { container, cleanup } = renderPanel({ book: bookWithTwo, selectedCharacterId: "char-su", onSelectCharacter })
    const buttons = [...container.querySelectorAll("button")]
    const suButton = buttons.find((b) => b.textContent?.includes("苏晚")) as HTMLButtonElement

    expect(container.textContent).toContain("未生成")
    expect(suButton.textContent).toContain("未生成")
    // 未生成 skill → 按钮禁用、点击不触发添加
    const addButton = container.querySelector("button") as HTMLButtonElement
    expect(addButton.disabled).toBe(true)
    // 点击角色按钮
    suButton.click()
    expect(onSelectCharacter).toHaveBeenCalledWith("char-su")
    cleanup()
  })

  it("unknown category 回退原始值（列表 + 详情）", () => {
    const { container, cleanup } = renderPanel({
      book: { ...book, characters: [{ ...book.characters[0], category: "guest" as never }] },
    })

    expect(container.textContent).toContain("guest · 重要度 9/10")
    expect(container.textContent).toContain("guest")
    cleanup()
  })

  it("skill 仅按 characterName 匹配；addingToSoul 显示加入中", () => {
    const bookNameMatch = {
      ...book,
      skills: [{ ...book.skills[0], id: "skill-name-only", characterId: "other-id" }],
    }
    const { addButton: btn1, cleanup: c1 } = renderPanel({ book: bookNameMatch })
    expect(btn1.disabled).toBe(false)
    c1()

    const { addButton, cleanup } = renderPanel({ addingToSoul: true })
    expect(addButton.disabled).toBe(true)
    expect(addButton.textContent).toContain("加入中...")
    cleanup()
  })

  it("personalityProfile：完整字段 + quotes 渲染 + 缺失回退", () => {
    const profileChar = {
      ...book.characters[0],
      personalityProfile: {
        personality: "冷静克制",
        motivation: "守护旧城",
        speechStyle: "短句冷语",
        behaviorPatterns: "夜间巡逻",
        quotes: ["灯火不灭。", "夜路留灯。"],
      },
    }
    const { container, cleanup } = renderPanel({ book: { ...book, characters: [profileChar] } })

    expect(container.textContent).toContain("冷静克制")
    expect(container.textContent).toContain("短句冷语")
    expect(container.textContent).toContain("守护旧城")
    expect(container.textContent).toContain("夜间巡逻")
    expect(container.textContent).toContain("「灯火不灭。」")
    expect(container.textContent).toContain("「夜路留灯。」")
    cleanup()
  })

  it("personalityProfile 字段缺失：回退 character 字段/暂无", () => {
    const partialProfile = {
      ...book.characters[0],
      personality: "角色性格",
      speechStyle: "角色口吻",
      personalityProfile: { personality: "", motivation: "", speechStyle: "", behaviorPatterns: "", quotes: [] },
    }
    const { container, cleanup } = renderPanel({ book: { ...book, characters: [partialProfile] } })

    expect(container.textContent).toContain("角色性格")
    expect(container.textContent).toContain("角色口吻")
    expect(container.textContent).toContain("暂无")
    cleanup()
  })

  it("personality/speechStyle 全缺失 → 暂无", () => {
    const bare = {
      ...book.characters[0],
      personality: "",
      speechStyle: "",
      personalityProfile: { personality: "", motivation: "", speechStyle: "", behaviorPatterns: "", quotes: [] },
    }
    const { container, cleanup } = renderPanel({ book: { ...book, characters: [bare] } })

    expect(container.textContent).toContain("暂无")
    cleanup()
  })

  it("skillContent 超过 800 字符时截断并显示省略号", () => {
    const longSkill = { ...book.skills[0], skillContent: "x".repeat(801) }
    const { container, cleanup } = renderPanel({ book: { ...book, skills: [longSkill] } })

    expect(container.textContent).toContain("...")
    expect(container.textContent?.length).toBeLessThan(900)
    cleanup()
  })
})
