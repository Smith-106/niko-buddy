import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { open } from "@tauri-apps/plugin-dialog"
import { readFile } from "@/commands/fs"
import { createBlankWritingSkill, createSkillCategory, deleteSkillCategory, importSkillFromJson, importWritingSkill, loadAllLinkedSkillsContent, loadUserSkillConfig, moveSkillToCategory, normalizeUserSkillConfig, renameSkillCategory, reorderSkillCategories, saveUserSkillConfig, setWritingSkillEnabled, touchSkillUsage } from "@/lib/novel"
import type { UserSkillConfig, SkillCategory, UserSkill } from "@/lib/novel"
import { resolveInitialSkillId } from "./writing-skill-helpers"
import { SortableCategoryItem } from "./writing-skill-widgets"
import { confirmDiscardSkillLibraryDraft, useWikiStore } from "@/stores/wiki-store"
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"


export function useWritingSkillConfig() {
  const projectPath = useWikiStore((s) => s.project?.path)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const selectedSkillId = useWikiStore((s) => s.selectedWritingSkillLibrarySkillId)
  const setSelectedSkillId = useWikiStore((s) => s.setSelectedWritingSkillLibrarySkillId)
  const [config, setConfig] = useState<UserSkillConfig | null>(null)
  const [loadError, setLoadError] = useState("")

  useEffect(() => {
    let cancelled = false
    setConfig(null)
    setLoadError("")
    loadUserSkillConfig(projectPath)
      .then(async (loaded) => {
        if (cancelled) return
        try {
          const withLinkedContent = await loadAllLinkedSkillsContent(loaded)
          if (!cancelled) {
            setConfig(withLinkedContent)
          }
        } catch {
          if (!cancelled) {
            setConfig(loaded)
          }
        }
        setSelectedSkillId(resolveInitialSkillId(loaded, selectedSkillId))
      })
      .catch(() => {
        if (cancelled) return
        setConfig(null)
        setLoadError("写作技能加载失败")
      })
    return () => {
      cancelled = true
    }
  }, [dataVersion, projectPath])

  return { config, setConfig, loadError }
}


export function WritingSkillLibrarySidebarPanel() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const selectedSkillId = useWikiStore((s) => s.selectedWritingSkillLibrarySkillId)
  const setSelectedSkillId = useWikiStore((s) => s.setSelectedWritingSkillLibrarySkillId)
  const draftDirty = useWikiStore((s) => s.writingSkillLibraryDraftDirty)
  const setDraftDirty = useWikiStore((s) => s.setWritingSkillLibraryDraftDirty)
  const { config, setConfig, loadError } = useWritingSkillConfig()
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>("all")
  const [showNewCategoryInput, setShowNewCategoryInput] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState("")
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null)
  const [editingCategoryName, setEditingCategoryName] = useState("")
  const [hoveredCategoryId, setHoveredCategoryId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  const categoryIds = useMemo(
    () => (config?.categories ?? []).map((cat) => cat.id),
    [config?.categories],
  )

  const disabledSkillIds = new Set(config?.disabledSkillIds ?? [])

  const recentSkills = useMemo(() => {
    if (!config) return []
    return config.skills
      .filter((s) => s.source !== "built-in")
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 5)
  }, [config])

  const filteredSkills = useMemo(() => {
    if (!config) return []
    if (selectedCategoryId === "all") return config.skills
    if (selectedCategoryId === "uncategorized") return config.skills.filter((s) => !s.categoryId)
    if (selectedCategoryId === "recent") return recentSkills
    return config.skills.filter((s) => s.categoryId === selectedCategoryId)
  }, [config, selectedCategoryId, recentSkills])

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !config || !project || saving) return
    const oldIndex = config.categories.findIndex((cat) => cat.id === active.id)
    const newIndex = config.categories.findIndex((cat) => cat.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const next = reorderSkillCategories(config, oldIndex, newIndex)
    await persist(next, selectedSkillId)
  }

  async function persist(nextConfig: UserSkillConfig, nextSelectedSkillId: string | null) {
    if (!project) {
      setMessage("请先打开项目")
      return
    }
    setSaving(true)
    try {
      await saveUserSkillConfig(project.path, nextConfig)
      setConfig(nextConfig)
      setSelectedSkillId(nextSelectedSkillId)
      setMessage("已保存")
      bumpDataVersion()
    } catch {
      setMessage("写作技能保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function handleSelectSkill(skillId: string) {
    if (!config || !project || saving) return
    if (draftDirty && !confirmDiscardSkillLibraryDraft()) return
    if (draftDirty) setDraftDirty(false)
    const next = touchSkillUsage(config, skillId)
    await persist(next, skillId)
  }

  async function handleCreateSkill() {
    if (!config || !project || saving) return
    if (draftDirty && !confirmDiscardSkillLibraryDraft()) return
    if (draftDirty) setDraftDirty(false)
    const next = createBlankWritingSkill(config)
    if (selectedCategoryId !== "all" && selectedCategoryId !== "uncategorized") {
      const withCategory = moveSkillToCategory(next, next.selectedSkillId!, selectedCategoryId)
      await persist(withCategory, withCategory.selectedSkillId)
    } else {
      await persist(next, next.selectedSkillId)
    }
  }

  async function handleImportSkill() {
    if (!config || !project || saving) return
    if (draftDirty && !confirmDiscardSkillLibraryDraft()) return
    if (draftDirty) setDraftDirty(false)
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "技能文件",
            extensions: ["json", "md", "txt"],
          },
        ],
      })
      if (!selected || typeof selected !== "string") return
      const content = await readFile(selected)
      const fileName = selected.split(/[\\/]/).pop() || "未命名技能"
      const isJson = /\.json$/i.test(fileName)
      let next: UserSkillConfig
      if (isJson) {
        const imported = importSkillFromJson(content)
        if (!imported) {
          setMessage("JSON 文件格式不正确，导入失败")
          return
        }
        next = normalizeUserSkillConfig({
          ...config,
          selectedSkillId: imported.id,
          skills: [imported, ...config.skills],
        })
      } else {
        const nameWithoutExt = fileName.replace(/\.(md|txt)$/i, "")
        next = importWritingSkill(config, { name: nameWithoutExt, content })
      }
      if (selectedCategoryId !== "all" && selectedCategoryId !== "uncategorized") {
        next = moveSkillToCategory(next, next.selectedSkillId!, selectedCategoryId)
      }
      await persist(next, next.selectedSkillId)
    } catch {
      setMessage("导入失败")
    }
  }

  async function handleToggleSkill(skill: UserSkill, enabled: boolean) {
    if (!config || !project || saving) return
    if (draftDirty && !confirmDiscardSkillLibraryDraft()) return
    if (draftDirty) setDraftDirty(false)
    const next = setWritingSkillEnabled(config, skill.id, enabled)
    await persist(next, selectedSkillId ?? next.selectedSkillId)
  }

  async function handleCreateCategory() {
    if (!config || !project || saving) return
    const trimmed = newCategoryName.trim()
    if (!trimmed) {
      setShowNewCategoryInput(false)
      return
    }
    const next = createSkillCategory(config, trimmed)
    setShowNewCategoryInput(false)
    setNewCategoryName("")
    await persist(next, selectedSkillId)
  }

  async function handleRenameCategory(categoryId: string) {
    if (!config || !project || saving) return
    const trimmed = editingCategoryName.trim()
    if (!trimmed) {
      setEditingCategoryId(null)
      return
    }
    const next = renameSkillCategory(config, categoryId, trimmed)
    setEditingCategoryId(null)
    setEditingCategoryName("")
    await persist(next, selectedSkillId)
  }

  async function handleDeleteCategory(categoryId: string, categoryName: string) {
    if (!config || !project || saving) return
    const confirmed = window.confirm(`确定删除分类「${categoryName}」吗？删除分类后，分类下的技能将变为未分类。`)
    if (!confirmed) return
    const next = deleteSkillCategory(config, categoryId)
    if (selectedCategoryId === categoryId) {
      setSelectedCategoryId("all")
    }
    await persist(next, selectedSkillId)
  }

  function startEditCategory(category: SkillCategory) {
    setEditingCategoryId(category.id)
    setEditingCategoryName(category.name)
  }

  return (
    <div data-testid="writing-skill-library-sidebar" className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b px-3 py-2">
        <h1 className="text-sm font-semibold">{t("skillLibrary.writingSkill")}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("skillLibrary.writingManageHint")}</p>
      </div>
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="text-sm font-medium">分类</div>
      </div>
      <div className="shrink-0 border-b px-2 py-1">
        <button type="button"
          onClick={() => setSelectedCategoryId("all")}
          className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
            selectedCategoryId === "all" ? "bg-accent/60" : ""
          }`}
        >
          <span className="flex-1 min-w-0 truncate">全部</span>
          <span className="shrink-0 text-xs text-muted-foreground">{config?.skills.length ?? 0}</span>
        </button>
        {recentSkills.length > 0 ? (
          <button type="button"
            onClick={() => setSelectedCategoryId("recent")}
            className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
              selectedCategoryId === "recent" ? "bg-accent/60" : ""
            }`}
          >
            <span className="flex-1 min-w-0 truncate">{t("skillLibrary.recentlyUsed")}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{recentSkills.length}</span>
          </button>
        ) : null}
        <button type="button"
          onClick={() => setSelectedCategoryId("uncategorized")}
          className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
            selectedCategoryId === "uncategorized" ? "bg-accent/60" : ""
          }`}
        >
          <span className="flex-1 min-w-0 truncate">{t("skillLibrary.uncategorized")}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {config?.skills.filter((s) => !s.categoryId).length ?? 0}
          </span>
        </button>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={categoryIds} strategy={verticalListSortingStrategy}>
            {(config?.categories ?? []).map((category) => {
              const count = (config?.skills ?? []).filter((s) => s.categoryId === category.id).length
              const isEditing = editingCategoryId === category.id
              const isHovered = hoveredCategoryId === category.id
              return (
                <SortableCategoryItem
                  key={category.id}
                  category={category}
                  count={count}
                  isSelected={selectedCategoryId === category.id}
                  isEditing={isEditing}
                  isHovered={isHovered}
                  editingCategoryName={editingCategoryName}
                  onSelect={() => setSelectedCategoryId(category.id)}
                  onStartEdit={() => startEditCategory(category)}
                  onRename={() => void handleRenameCategory(category.id)}
                  onCancelEdit={() => setEditingCategoryId(null)}
                  onEditingNameChange={(name) => setEditingCategoryName(name)}
                  onDelete={() => void handleDeleteCategory(category.id, category.name)}
                  onMouseEnter={() => setHoveredCategoryId(category.id)}
                  onMouseLeave={() => setHoveredCategoryId(null)}
                />
              )
            })}
          </SortableContext>
        </DndContext>
        {showNewCategoryInput ? (
          <div className="mt-1 flex items-center gap-1 rounded-md px-2 py-1">
            <input
              autoFocus
              type="text"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void handleCreateCategory()
                } else if (e.key === "Escape") {
                  setShowNewCategoryInput(false)
                  setNewCategoryName("")
                }
              }}
              onBlur={() => void handleCreateCategory()}
              placeholder={t("skillLibrary.categoryPlaceholder")}
              className="flex-1 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setShowNewCategoryInput(true)
              setNewCategoryName("")
            }}
            className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            + 新建分类
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="text-sm font-medium">{t("skillLibrary.writingSkill")}</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleImportSkill()}
            disabled={!config || !project || saving}
            className="rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
          >
            导入
          </button>
          <button
            type="button"
            onClick={() => void handleCreateSkill()}
            disabled={!config || !project || saving}
            className="rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
          >
            新建技能
          </button>
        </div>
      </div>
      {loadError || message ? (
        <div className="border-b px-3 py-2 text-xs text-muted-foreground">{loadError || message}</div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {config && filteredSkills.length === 0 ? (
          <div className="rounded-md border border-dashed p-3 text-xs leading-5 text-muted-foreground">
            还没有写作技能。可以新建“三翻四抖”“章节计划”“伏笔检查”等规则。
          </div>
        ) : null}
        {filteredSkills.map((skill) => {
          const active = skill.id === selectedSkillId
          const enabled = !disabledSkillIds.has(skill.id)
          const isLinked = skill.source === "linked"
          return (
            <div
              key={skill.id}
              className={`mb-2 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent ${
                active ? "border-primary bg-accent/60" : "border-border"
              }`}
            >
              <button type="button"
                onClick={() => void handleSelectSkill(skill.id)}
                className="w-full min-w-0 cursor-pointer text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{skill.name}</span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t("skillLibrary.writing")}</span>
                  {isLinked ? (
                    <span className="shrink-0 rounded bg-info/15 px-1.5 py-0.5 text-xs text-info">引用</span>
                  ) : null}
                </div>
                <div className="mt-1 min-w-0 truncate text-xs text-muted-foreground">{skill.description || "未填写说明"}</div>
              </button>
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => void handleToggleSkill(skill, event.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                  disabled={saving}
                />
                参与 AI 会话
              </label>
            </div>
          )
        })}
      </div>
    </div>
  )
}
