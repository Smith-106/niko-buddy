"use client"

/**
 * character-workstation-view — 角色分离工作台（roadmap C7）。
 *
 * ── 设计来源（借模式，不抄码） ─────────────────────────────
 * 参考 open-write-studio 的「工位（workstation）」理念：每位作者/写作角色拥有
 * 独立工作位，互不干扰、可随时切换往返而不丢失上下文。本组件把该理念落到「角色」
 * 维度：每个角色是一个独立 station（工位），各自拥有隔离的草稿态与编辑焦点。
 *
 * 说明：仓库中不存在 reference/open-write-studio/ 目录（已核对当前文件树与 git
 * 全部分支），故「工位」模式理念取自任务描述 + 仓库既有角色组件的交互惯例，
 * 未复制任何参考代码：
 *   - character-selection-panel.tsx（角色列表选中态/多态/空态）
 *   - character-aura-view.tsx（分栏 + 左侧选中态 + 主区渲染）
 *   - book-analysis-character-panel.tsx（左列角色选择、右列详情、空态）
 *
 * ── 角色分离的最小有价值形态（三种状态互不串扰） ─────────
 * 1. 分位切换隔离：每个角色一个 station，本组件持有 `drafts: Record<id, string>`
 *    草稿缓冲与 `activeId`；切换角色只换「当前工位」，各角色草稿按 id 独立保留，
 *    互不覆盖。
 * 2. 编辑焦点隔离：每个 station 用 `key={id}` 挂载，切走时整棵 station DOM 卸载、
 *    切回时全新挂载——编辑光标/未提交状态天然不跨角色泄漏（等价于独立工作台）。
 * 3. 空角色安全：characters 为空时渲染提示性空态，不挂载任何可聚焦编辑控件。
 *
 * ── 推荐宿主视图 ──────────────────────────────────────────
 * 推荐在 Write 模式的写作面板内作「角色工作台」宿主，例如：
 *
 *    <CharacterWorkstationView
 *      characters={characters}
 *      onBasicDraftChange={(id, text) => { void persistCharacterDraft(id, text) }}
 *    />
 *
 * 本组件是纯展示/交互壳（受控 + 非受控双模），不直接读写项目文件，业务持久化交由
 * 宿主通过 onBasicDraftChange 处理。未修改任何共享布局文件。
 */

import { useId, useMemo, useRef, useState } from "react"
import { User } from "lucide-react"

/** 一个角色工位的输入数据。字段取自既有角色类型（RecognizedCharacter /
 *  ExtractedCharacter / book.characters）的无耦合公共子集，宿主可用 map 收敛传入。 */
export interface CharacterWorkstationItem {
  id: string
  name: string
  /** 角色定位标签（主角/配角/反派…）。 */
  category?: string
  /** 重要度 0-100（可省略）。 */
  importanceScore?: number
  /** 短描述（可省略）。 */
  description?: string
  /** 出场次数（可省略）。 */
  appearances?: number
}

export interface CharacterWorkstationViewProps {
  characters: CharacterWorkstationItem[]
  /** 受控：当前激活角色 id。缺省走内部 state（非受控）。 */
  activeCharacterId?: string | null
  /** 激活角色变更回调；受控/非受控都会调用，供宿主同步选中态。 */
  onActiveCharacterChange?: (id: string) => void
  /** 角色草稿变更回调（用于业务落库）。 */
  onBasicDraftChange?: (id: string, draft: string) => void
  /** 非受控场景的种子草稿（纯初始值，无副作用）。 */
  initialDrafts?: Record<string, string>
}

const EMPTY_CHARACTERS_HINT =
  "暂无可编辑角色工位。请先完成角色识别或在角色列表选择角色后再开始分角色写作。"
const EMPTY_STATION_HINT =
  "此角色工位为空。此处保存该角色专属草稿：切换角色不会互相覆盖，数据按角色隔离。"
const EMPTY_DRAFT_PLACEHOLDER = "为该角色填写专属草稿（内容按工位隔离，不影响其他角色）…"
const DRAFT_SAVED_HINT = "草稿已保存在本角色工位，切换角色不会丢失或覆盖。"
const DRAFT_EMPTY_HINT = "当前工位草稿为空。此角色工位已就绪，输入内容按角色隔离保存。"

function categoryLabel(c: CharacterWorkstationItem): string {
  return c.category ?? "角色"
}

export function CharacterWorkstationView(props: CharacterWorkstationViewProps) {
  const {
    characters,
    activeCharacterId,
    onActiveCharacterChange,
    onBasicDraftChange,
    initialDrafts = {},
  } = props

  const isControlled = activeCharacterId !== undefined
  const firstId = characters[0]?.id ?? ""
  // 非受控：内部维护 activeId；受控：直接用传入值。
  const [internalActiveId, setInternalActiveId] = useState<string>(firstId)
  const activeId = isControlled ? (activeCharacterId ?? null) : internalActiveId

  // 全站角色草稿缓冲 —— 角色隔离的关键：按 id 分桶，切角色只换当前桶。
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({ ...initialDrafts }))

  const effectiveActiveId =
    activeId && characters.some((c) => c.id === activeId) ? activeId : firstId
  const activeCharacter = characters.find((c) => c.id === effectiveActiveId) ?? null

  function handleSelect(nextId: string) {
    if (effectiveActiveId === nextId) return
    if (!isControlled) setInternalActiveId(nextId)
    onActiveCharacterChange?.(nextId)
  }

  function handleDraft(nextDraft: string) {
    if (!activeCharacter) return
    if (!isControlled) {
      // 仅写入当前角色分区，其它角色草稿保持原样（隔离）。
      setDrafts((prev) => ({ ...prev, [activeCharacter.id]: nextDraft }))
    }
    onBasicDraftChange?.(activeCharacter.id, nextDraft)
  }

  return (
    <section
      aria-label="角色分离工作台"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-background"
    >
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">角色工作台</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            每位角色独立工位：草稿与编辑焦点互不干扰，可随时切换往返。
          </p>
        </div>
        {characters.length > 0 && (
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {characters.length} 个角色工位
          </span>
        )}
      </div>

      <CharacterStationSwitcher
        characters={characters}
        activeId={effectiveActiveId}
        onSelect={handleSelect}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeCharacter ? (
          // key={id} 隔离编辑焦点：切走即卸载整棵工位 DOM，切回全新挂载。
          <CharacterStation
            key={activeCharacter.id}
            character={activeCharacter}
            draft={isControlled ? undefined : drafts[activeCharacter.id]}
            onDraftChange={handleDraft}
          />
        ) : (
          <div
            role="status"
            className="flex h-full min-h-40 items-center justify-center p-6 text-center text-sm text-muted-foreground"
          >
            {characters.length === 0 ? EMPTY_CHARACTERS_HINT : EMPTY_STATION_HINT}
          </div>
        )}
      </div>
    </section>
  )
}

/** 顶部角色切换条：roving tabindex 键盘可达（←/→/Home/End），选中态互斥。 */
export function CharacterStationSwitcher({
  characters,
  activeId,
  onSelect,
}: {
  characters: CharacterWorkstationItem[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const baseId = useId()
  const tablistId = `${baseId}-tabs`
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const tabs = useMemo(
    () => characters.map((c) => ({ id: c.id, label: `${categoryLabel(c)} · ${c.name}` })),
    [characters],
  )

  if (tabs.length === 0) {
    return (
      <div role="tablist" aria-label="角色工位切换" className="flex shrink-0 border-b px-4 py-2">
        <span className="px-2 py-1 text-xs text-muted-foreground">无角色工位可切换</span>
      </div>
    )
  }

  /** roving tabindex：←/→ 循环移动，Home/End 跳首尾。焦点随选中移动（UAT C7-2b）。 */
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  function moveFocus(delta: number, edge: "start" | "end" | null) {
    const currentIdx = tabs.findIndex((t) => t.id === (focusedId ?? activeId))
    let nextIdx: number
    if (edge === "start") nextIdx = 0
    else if (edge === "end") nextIdx = tabs.length - 1
    else if (currentIdx < 0) nextIdx = delta > 0 ? 0 : tabs.length - 1
    else nextIdx = (currentIdx + delta + tabs.length) % tabs.length
    const target = tabs[nextIdx]
    setFocusedId(target.id)
    onSelect(target.id)
    // APG tab 模式：真实 DOM 焦点须随选中移动，而非仅更新状态
    queueMicrotask(() => {
      tabRefs.current.get(target.id)?.focus()
    })
  }

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      aria-label="角色工位切换"
      onBlur={() => setFocusedId(null)}
      className="flex shrink-0 flex-wrap gap-1 border-b bg-popover p-2"
    >
      {tabs.map((tab) => {
        const selected = activeId === tab.id
        const focused = focusedId === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${tablistId}-${tab.id}`}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el)
              else tabRefs.current.delete(tab.id)
            }}
            aria-selected={selected}
            aria-controls="character-station-panel"
            tabIndex={focused || selected ? 0 : -1}
            data-testid={`workstation-tab-${tab.id}`}
            onClick={() => onSelect(tab.id)}
            onFocus={() => setFocusedId(tab.id)}
            onKeyDown={(event) => {
              let consumed = true
              switch (event.key) {
                case "ArrowRight":
                case "ArrowDown":
                  moveFocus(1, null)
                  break
                case "ArrowLeft":
                case "ArrowUp":
                  moveFocus(-1, null)
                  break
                case "Home":
                  moveFocus(0, "start")
                  break
                case "End":
                  moveFocus(0, "end")
                  break
                default:
                  consumed = false
              }
              if (consumed) event.preventDefault()
            }}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground qm-hover"
            }`}
          >
            <span className="truncate">{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** 单个角色工位：专属草稿区 + 角色信息。由外层 key={id} 保证焦点隔离。 */
function CharacterStation({
  character,
  draft,
  onDraftChange,
}: {
  character: CharacterWorkstationItem
  draft?: string
  onDraftChange: (draft: string) => void
}) {
  const draftText = draft ?? ""
  return (
    <div
      id="character-station-panel"
      role="tabpanel"
      className="flex h-full flex-col gap-4 p-4"
    >
      <header className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-primary" />
          <h3 className="text-lg font-semibold">{character.name}</h3>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {categoryLabel(character)}
          </span>
        </div>
        {character.importanceScore !== undefined && (
          <span className="text-xs text-muted-foreground">重要度 {character.importanceScore}</span>
        )}
        {character.appearances !== undefined && (
          <span className="text-xs text-muted-foreground">出场 {character.appearances}</span>
        )}
        <span className="text-xs text-muted-foreground">{categoryLabel(character)}工位待写</span>
      </header>

      {character.description && (
        <p className="text-sm leading-6 text-muted-foreground">{character.description}</p>
      )}

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">草稿（按角色隔离）</span>
        <textarea
          data-testid={`station-draft-${character.id}`}
          value={draftText}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={EMPTY_DRAFT_PLACEHOLDER}
          rows={8}
          className="min-h-40 w-full resize-y rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      <p role="status" className="text-xs text-muted-foreground">
        {draftText.trim() ? DRAFT_SAVED_HINT : DRAFT_EMPTY_HINT}
      </p>
    </div>
  )
}
