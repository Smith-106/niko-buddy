// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BookAnalysisLibraryState } from "@/lib/novel"
import { BookAnalysisLibraryLayout } from "./book-analysis-library-layout"

afterEach(() => cleanup())

const state: BookAnalysisLibraryState = {
  enabledStyle: {
    id: "style-1",
    name: "凡人修仙传 · 文风",
    sourceBook: "凡人修仙传",
    profile: {
      schemaVersion: 1,
      generatedAt: 1,
      sampledChapterIds: ["ch-1"],
      narrativeDensity: "叙事密度中高",
      descriptionWeight: "描写克制",
      emotionRendering: "",
      sentenceStyle: "",
      rhetoricDensity: "",
      transitionStyle: "",
      narrativeVoice: "",
      dialogueStyle: "对白留白",
      thematicHabits: "",
      constitution: "1. 动作推进优先",
      samples: [],
    },
    createdAt: 1,
    updatedAt: 1,
  },
  bindings: [{ characterName: "主角", auraId: "aura-hanli", auraName: "韩立" }],
  books: [
    {
      id: "book-1",
      path: "E:/Novel/book-analysis/book-1",
      metadata: {
        title: "凡人修仙传",
        author: "忘语",
        totalChapters: 10,
        totalWords: 100000,
        sourceType: "file",
        createdAt: 1,
        updatedAt: 2,
      },
      styleStatus: "enabled",
      styleProfile: {
        schemaVersion: 1,
        generatedAt: 1,
        sampledChapterIds: ["ch-1"],
        narrativeDensity: "叙事密度中高",
        descriptionWeight: "描写克制",
        emotionRendering: "",
        sentenceStyle: "",
        rhetoricDensity: "",
        transitionStyle: "",
        narrativeVoice: "",
        dialogueStyle: "对白留白",
        thematicHabits: "",
        constitution: "1. 动作推进优先",
        samples: [],
      },
      boundAurasCount: 1,
      addedAuraCharacterIds: [],
      recognizedCharacters: [],
      characters: [{
        id: "char-hanli",
        name: "韩立",
        aliases: [],
        importance: 9,
        category: "protagonist",
        firstAppearance: 1,
        lastAppearance: 10,
        appearanceCount: 10,
        description: "谨慎",
        personality: "隐忍",
        speechStyle: "少承诺",
        relationships: [],
        keyEvents: [],
      }],
      skills: [{
        id: "skill-char-hanli",
        characterId: "char-hanli",
        characterName: "韩立",
        skillContent: "# 韩立",
        sourceBook: "凡人修仙传",
        chapterRange: ["1", "10"],
        createdAt: 1,
      }],
    },
  ],
}

describe("BookAnalysisLibraryLayout", () => {
  it("renders the three-column library state", () => {
    const html = renderToStaticMarkup(
      <BookAnalysisLibraryLayout
        state={state}
        selectedBookId="book-1"
        selectedCharacterId="char-hanli"
        extractingStyle={false}
        extractingCharacters={false}
        addingToSoul={false}
        onSelectBook={vi.fn()}
        onSelectCharacter={vi.fn()}
        onImportNovel={vi.fn()}
        onExtractStyle={vi.fn()}
        onToggleStyle={vi.fn()}
        onAddSelectedSkillsToSoul={vi.fn()}
        onReextractCharacters={vi.fn()}
        onDeleteBook={vi.fn()}
      />,
    )

    expect(html).toContain("拆文库")
    expect(html).toContain("启用文风")
    expect(html).toContain("凡人修仙传")
    expect(html).toContain("作品文风")
    expect(html).toContain("角色技能")
    expect(html).toContain("当前 AI 会话约束")
    expect(html).toContain("主角")
    expect(html).toContain("韩立")
    expect(html).toContain("重新提取角色")
    expect(html).toContain("重新提取文风")
  })

  it("selectedBookId 不匹配时回退到 books[0]", () => {
    const html = renderToStaticMarkup(
      <BookAnalysisLibraryLayout
        state={state}
        selectedBookId="missing-book"
        selectedCharacterId="char-hanli"
        extractingStyle={false}
        extractingCharacters={false}
        addingToSoul={false}
        onSelectBook={vi.fn()}
        onSelectCharacter={vi.fn()}
        onImportNovel={vi.fn()}
        onExtractStyle={vi.fn()}
        onToggleStyle={vi.fn()}
        onAddSelectedSkillsToSoul={vi.fn()}
        onReextractCharacters={vi.fn()}
        onDeleteBook={vi.fn()}
      />,
    )

    expect(html).toContain("凡人修仙传")
    expect(html).toContain("重新提取角色")
  })

  it("无书时显示空态；导入按钮不显示重新提取", () => {
    const html = renderToStaticMarkup(
      <BookAnalysisLibraryLayout
        state={{ ...state, books: [] }}
        selectedBookId={null}
        selectedCharacterId={null}
        extractingStyle={false}
        extractingCharacters={false}
        addingToSoul={false}
        onSelectBook={vi.fn()}
        onSelectCharacter={vi.fn()}
        onImportNovel={vi.fn()}
        onExtractStyle={vi.fn()}
        onToggleStyle={vi.fn()}
        onAddSelectedSkillsToSoul={vi.fn()}
        onReextractCharacters={vi.fn()}
        onDeleteBook={vi.fn()}
      />,
    )

    expect(html).toContain("还没有拆书作品")
    expect(html).toContain("导入 TXT 小说后，可以提取角色技能和作品文风。")
    expect(html).not.toContain("重新提取角色")
  })

  it("extracting 标志：角色/文风按钮显示提取中", () => {
    const html = renderToStaticMarkup(
      <BookAnalysisLibraryLayout
        state={state}
        selectedBookId="book-1"
        selectedCharacterId="char-hanli"
        extractingStyle
        extractingCharacters
        addingToSoul={false}
        onSelectBook={vi.fn()}
        onSelectCharacter={vi.fn()}
        onImportNovel={vi.fn()}
        onExtractStyle={vi.fn()}
        onToggleStyle={vi.fn()}
        onAddSelectedSkillsToSoul={vi.fn()}
        onReextractCharacters={vi.fn()}
        onDeleteBook={vi.fn()}
      />,
    )

    expect(html).toContain("提取中...")
    expect(html).not.toContain("重新提取角色")
  })

  it("TASK-008：内联书架切换按钮展开网格并选书收起，同时透传角色即时绑定操作", () => {
    const onSelectBook = vi.fn()
    const onBindCharacter = vi.fn()
    const stateWithAdded: BookAnalysisLibraryState = {
      ...state,
      books: [
        { ...state.books[0], addedAuraCharacterIds: ["char-hanli"] },
        {
          ...state.books[0],
          id: "book-2",
          metadata: { ...state.books[0].metadata, title: "诡秘之主" },
        },
      ],
    }

    render(
      <BookAnalysisLibraryLayout
        state={stateWithAdded}
        selectedBookId="book-1"
        selectedCharacterId="char-hanli"
        extractingStyle={false}
        extractingCharacters={false}
        addingToSoul={false}
        bindingCharacter={false}
        bindableCharacters={["主角甲"]}
        onSelectBook={onSelectBook}
        onSelectCharacter={vi.fn()}
        onImportNovel={vi.fn()}
        onExtractStyle={vi.fn()}
        onToggleStyle={vi.fn()}
        onAddSelectedSkillsToSoul={vi.fn()}
        onBindCharacter={onBindCharacter}
        onReextractCharacters={vi.fn()}
        onDeleteBook={vi.fn()}
      />,
    )

    // 初始收起书架面板，点击展开
    expect(screen.queryByTestId("book-analysis-bookshelf-switcher")).toBeNull()
    fireEvent.click(screen.getByTestId("book-analysis-toggle-bookshelf"))
    expect(screen.getByTestId("book-analysis-bookshelf-switcher")).toBeTruthy()

    // 选第二本书后回调 onSelectBook 并自动收起书架面板
    fireEvent.click(screen.getByTestId("book-analysis-bookshelf-select-book-2"))
    expect(onSelectBook).toHaveBeenCalledWith("book-2")
    expect(screen.queryByTestId("book-analysis-bookshelf-switcher")).toBeNull()

    // 已加入灵魂库的角色透传即时绑定按钮
    fireEvent.click(screen.getByTestId("book-analysis-bind-character-btn"))
    expect(onBindCharacter).toHaveBeenCalledWith("char-hanli", "主角甲")
  })
})
