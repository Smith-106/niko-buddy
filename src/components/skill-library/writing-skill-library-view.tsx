import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { save } from "@tauri-apps/plugin-dialog"
import { writeFileAtomic } from "@/commands/fs"
import { deleteWritingSkill, exportSkillToJson, loadLinkedSkillContent, normalizeUserSkillConfig, resolveEnabledWritingSkills, saveUserSkillConfig, setWritingSkillEnabled, updateWritingSkill, WRITING_SKILL_KIND_OPTIONS, WRITING_SKILL_MODE_OPTIONS, WRITING_SKILL_STAGE_OPTIONS, SKILL_KIND_LABELS, SKILL_MODE_LABELS, SKILL_STAGE_LABELS } from "@/lib/novel"
import type { UserSkillConfig, SkillKind, SkillMode, SkillStage, UserSkill, ImportResult } from "@/lib/novel"
import { hasDraftChanged, toggleValue } from "./writing-skill-helpers"
import { OptionCheckbox } from "./writing-skill-widgets"
import { SkillPackPanel } from "@/components/skills/SkillPackPanel"
import { SkillBundleImportDialog } from "@/components/skills/SkillBundleImportDialog"
import { confirmDiscardSkillLibraryDraft, useWikiStore } from "@/stores/wiki-store"
import { useWritingSkillConfig } from "./writing-skill-sidebar-panel"

// M12-2 切片过渡公开导出：实现已迁至 ./writing-skill-sidebar-panel，本路径保持兼容。
export { WritingSkillLibrarySidebarPanel } from "./writing-skill-sidebar-panel"


export function WritingSkillLibraryView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const selectedSkillId = useWikiStore((s) => s.selectedWritingSkillLibrarySkillId)
  const setSelectedSkillId = useWikiStore((s) => s.setSelectedWritingSkillLibrarySkillId)
  const draftDirty = useWikiStore((s) => s.writingSkillLibraryDraftDirty)
  const setDraftDirty = useWikiStore((s) => s.setWritingSkillLibraryDraftDirty)
  const { config, setConfig, loadError } = useWritingSkillConfig()
  const [draftName, setDraftName] = useState("")
  const [draftDescription, setDraftDescription] = useState("")
  const [draftContent, setDraftContent] = useState("")
  const [draftKind, setDraftKind] = useState<SkillKind[]>([])
  const [draftStages, setDraftStages] = useState<SkillStage[]>([])
  const [draftModes, setDraftModes] = useState<SkillMode[]>([])
  // A-F-002 / B-F-006 技能包（.zip）离线导入：选文件走 Tauri 原生对话框（动态 import，
  // 与 sidebar-panel 的章节导入一致）；弹窗只拿路径与落点根，落点根由宿主给出。
  const [bundlePath, setBundlePath] = useState<string | null>(null)
  const [bundleDialogOpen, setBundleDialogOpen] = useState(false)

  const handleOpenBundleImport = async () => {
    if (!project) return
    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      multiple: false,
      title: "选择技能包（.zip）",
      filters: [{ name: "技能包", extensions: ["zip"] }],
    })
    if (!selected || typeof selected !== "string") return
    setBundlePath(selected)
    setBundleDialogOpen(true)
  }

  const [draftPriority, setDraftPriority] = useState(50)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [draftCategoryId, setDraftCategoryId] = useState("")
  const [tagInput, setTagInput] = useState("")
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)

  const selectedSkill = useMemo(
    () => config?.skills.find((skill) => skill.id === selectedSkillId) ?? config?.skills[0] ?? null,
    [config, selectedSkillId],
  )
  const enabledSkillIds = new Set(resolveEnabledWritingSkills(config ?? {
    version: 1,
    selectedSkillId: null,
    disabledSkillIds: [],
    skills: [],
    categories: [],
  }).map((skill) => skill.id))
  const selectedEnabled = selectedSkill ? enabledSkillIds.has(selectedSkill.id) : false
  const isLinkedSkill = selectedSkill?.source === "linked"
  const draftChanged = Boolean(
    selectedSkill && (isLinkedSkill
      ? (draftName.trim() !== selectedSkill.name
        || draftDescription.trim() !== selectedSkill.description
        || draftKind.join("|") !== selectedSkill.kind.join("|")
        || draftStages.join("|") !== selectedSkill.stages.join("|")
        || draftModes.join("|") !== selectedSkill.modes.join("|")
        || draftPriority !== selectedSkill.priority
        || draftTags.join("|") !== selectedSkill.tags.join("|")
        || draftCategoryId !== selectedSkill.categoryId)
      : hasDraftChanged(
        selectedSkill,
        draftName,
        draftDescription,
        draftContent,
        draftKind,
        draftStages,
        draftModes,
        draftPriority,
        draftTags,
        draftCategoryId,
      )),
  )
  const canSaveDraft = Boolean(project && config && selectedSkill && draftChanged && !saving)

  useEffect(() => {
    if (!selectedSkill) {
      setDraftName("")
      setDraftDescription("")
      setDraftContent("")
      setDraftKind([])
      setDraftStages([])
      setDraftModes([])
      setDraftPriority(50)
      setDraftTags([])
      setDraftCategoryId("")
      setDraftDirty(false)
      return
    }
    setDraftName(selectedSkill.name)
    setDraftDescription(selectedSkill.description)
    setDraftContent(selectedSkill.content)
    setDraftKind(selectedSkill.kind)
    setDraftStages(selectedSkill.stages)
    setDraftModes(selectedSkill.modes)
    setDraftPriority(selectedSkill.priority)
    setDraftTags(selectedSkill.tags)
    setDraftCategoryId(selectedSkill.categoryId)
    setDraftDirty(false)
    setMessage("")
  }, [selectedSkill?.id, selectedSkill?.name, selectedSkill?.description, selectedSkill?.content])

  function updateDraftDirty(
    name = draftName,
    description = draftDescription,
    content = draftContent,
    kind = draftKind,
    stages = draftStages,
    modes = draftModes,
    priority = draftPriority,
    tags = draftTags,
    categoryId = draftCategoryId,
  ) {
    setDraftDirty(selectedSkill
      ? hasDraftChanged(selectedSkill, name, description, content, kind, stages, modes, priority, tags, categoryId)
      : false)
  }

  async function persist(nextConfig: UserSkillConfig, nextSelectedSkillId = selectedSkillId) {
    if (!project) {
      setMessage("请先打开项目")
      return
    }
    setSaving(true)
    try {
      await saveUserSkillConfig(project.path, nextConfig)
      setConfig(nextConfig)
      setSelectedSkillId(nextSelectedSkillId)
      setDraftDirty(false)
      setMessage("已保存")
      bumpDataVersion()
    } catch {
      setMessage("写作技能保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function handlePackImported(result: ImportResult) {
    if (!result.ok || !config) return
    // 落盘职责在宿主：面板只产出 `UserSkill[]`＋信任级别，归一化与写盘走本视图既有的
    // `persist`（内部即 `saveUserSkillConfig` + `bumpDataVersion`）；无项目时 `persist`
    // 自行拒绝，不在此处伪造成功。
    const merged = normalizeUserSkillConfig({
      ...config,
      skills: [...config.skills, ...result.skills],
    })
    const importedId = result.skills[result.skills.length - 1]?.id ?? selectedSkillId
    await persist(merged, importedId)
  }

  async function handleSaveSkill() {
    if (!config || !selectedSkill || !canSaveDraft) return
    const name = draftName.trim()
    if (!name) {
      setMessage("Skill 名称不能为空")
      return
    }
    if (!isLinkedSkill) {
      const content = draftContent.trim()
      if (!content) {
        setMessage("规则正文不能为空")
        return
      }
    }
    const patch: Partial<Pick<UserSkill, "name" | "description" | "kind" | "stages" | "modes" | "content" | "priority" | "tags" | "categoryId">> = {
      name,
      description: draftDescription.trim(),
      kind: draftKind,
      stages: draftStages,
      modes: draftModes,
      priority: draftPriority,
      tags: draftTags,
      categoryId: draftCategoryId,
    }
    if (!isLinkedSkill) {
      patch.content = draftContent.trim()
    }
    await persist(updateWritingSkill(config, selectedSkill.id, patch))
  }

  async function handleToggleEnabled(enabled: boolean) {
    if (!config || !selectedSkill || !project || saving) return
    if (draftDirty && !confirmDiscardSkillLibraryDraft()) return
    if (draftDirty) setDraftDirty(false)
    await persist(setWritingSkillEnabled(config, selectedSkill.id, enabled), selectedSkill.id)
  }

  async function handleDeleteSkill() {
    if (!config || !selectedSkill || !project || saving) return
    if (draftDirty && !confirmDiscardSkillLibraryDraft()) return
    if (draftDirty) setDraftDirty(false)
    const confirmed = window.confirm(`确定删除「${selectedSkill.name}」吗？删除后无法恢复。`)
    if (!confirmed) return
    const next = deleteWritingSkill(config, selectedSkill.id)
    await persist(next, next.selectedSkillId)
  }

  async function handleExportSkill() {
    if (!selectedSkill) return
    try {
      const jsonStr = exportSkillToJson(selectedSkill)
      const filePath = await save({
        defaultPath: `${selectedSkill.name}.json`,
        filters: [
          {
            name: "JSON 文件",
            extensions: ["json"],
          },
        ],
      })
      if (!filePath) return
      await writeFileAtomic(filePath, jsonStr)
      setMessage("导出成功")
    } catch {
      setMessage("导出 Skill 失败")
    }
  }

  async function handleReloadLinkedContent() {
    if (!selectedSkill || selectedSkill.source !== "linked" || !config) return
    try {
      const content = await loadLinkedSkillContent(selectedSkill)
      const updatedSkill = { ...selectedSkill, content }
      const updatedSkills = config.skills.map((s) =>
        s.id === selectedSkill.id ? updatedSkill : s
      )
      setConfig({ ...config, skills: updatedSkills })
      setDraftContent(content)
      setMessage("已重新读取内容")
    } catch {
      setMessage("读取内容失败")
    }
  }

  function handleAddTag() {
    const trimmed = tagInput.trim()
    if (!trimmed) return
    if (draftTags.includes(trimmed)) {
      setTagInput("")
      return
    }
    const next = [...draftTags, trimmed]
    setDraftTags(next)
    setTagInput("")
    updateDraftDirty(draftName, draftDescription, draftContent, draftKind, draftStages, draftModes, draftPriority, next)
  }

  function handleRemoveTag(tag: string) {
    const next = draftTags.filter((t) => t !== tag)
    setDraftTags(next)
    updateDraftDirty(draftName, draftDescription, draftContent, draftKind, draftStages, draftModes, draftPriority, next)
  }

  function handleTagKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      handleAddTag()
    }
  }

  return (
    <div data-testid="writing-skill-library-view" className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b px-5 py-4">
        <h1 className="text-lg font-semibold">{t("skillLibrary.writingSkill")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("skillLibrary.writingEditHint")}</p>
        {!project ? <p className="mt-1 text-sm text-destructive">请先打开项目</p> : null}
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto p-5">
        {loadError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        ) : !selectedSkill ? (
          <div className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">
            还没有写作技能。请在左侧新建技能。
          </div>
        ) : (
          <div className="flex w-full min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div>
                  <div className="text-sm text-muted-foreground">{t("skillLibrary.projectWritingSkill")}</div>
                  <h2 className="text-xl font-semibold">{selectedSkill.name}</h2>
                </div>
                {isLinkedSkill ? (
                  <span className="rounded bg-info/15 px-2 py-0.5 text-xs text-info">引用</span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    data-testid="writing-skill-enabled-checkbox"
                    type="checkbox"
                    checked={selectedEnabled}
                    onChange={(event) => void handleToggleEnabled(event.target.checked)}
                    className="h-4 w-4 accent-primary"
                    disabled={saving}
                  />
                  参与 AI 会话
                </label>
                <button
                  type="button"
                  onClick={() => void handleExportSkill()}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
                >
                  导出
                </button>
                <button
                  data-testid="writing-skill-delete-button"
                  type="button"
                  onClick={() => void handleDeleteSkill()}
                  disabled={!project || saving}
                  className="rounded-md border px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-60"
                >
                  删除
                </button>
              </div>
            </div>

            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">{t("skillLibrary.skillNameLabel")}</span>
              <input
                data-testid="writing-skill-name-input"
                value={draftName}
                onChange={(event) => {
                  const next = event.target.value
                  setDraftName(next)
                  updateDraftDirty(next)
                }}
                className="rounded-md border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">{t("skillLibrary.description")}</span>
              <input
                data-testid="writing-skill-description-input"
                value={draftDescription}
                onChange={(event) => {
                  const next = event.target.value
                  setDraftDescription(next)
                  updateDraftDirty(draftName, next)
                }}
                className="rounded-md border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">分类</span>
              <select
                value={draftCategoryId}
                onChange={(event) => {
                  const next = event.target.value
                  setDraftCategoryId(next)
                  updateDraftDirty(draftName, draftDescription, draftContent, draftKind, draftStages, draftModes, draftPriority, draftTags, next)
                }}
                className="rounded-md border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">{t("skillLibrary.uncategorized")}</option>
                {config?.categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </label>

            <div className="grid gap-2 text-sm">
              <span className="font-medium">类型</span>
              <div className="flex flex-wrap gap-2">
                {WRITING_SKILL_KIND_OPTIONS.map((kind) => (
                  <OptionCheckbox
                    key={kind}
                    label={SKILL_KIND_LABELS[kind]}
                    checked={draftKind.includes(kind)}
                    testId={`writing-skill-kind-${kind}`}
                    onToggle={() => {
                      const next = toggleValue(draftKind, kind)
                      setDraftKind(next)
                      updateDraftDirty(draftName, draftDescription, draftContent, next)
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="grid gap-2 text-sm">
              <span className="font-medium">{t("skillLibrary.stage")}</span>
              <div className="flex flex-wrap gap-2">
                {WRITING_SKILL_STAGE_OPTIONS.map((stage) => (
                  <OptionCheckbox
                    key={stage}
                    label={SKILL_STAGE_LABELS[stage]}
                    checked={draftStages.includes(stage)}
                    testId={`writing-skill-stage-${stage}`}
                    onToggle={() => {
                      const next = toggleValue(draftStages, stage)
                      setDraftStages(next)
                      updateDraftDirty(draftName, draftDescription, draftContent, draftKind, next)
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="grid gap-2 text-sm">
              <span className="font-medium">{t("skillLibrary.mode")}</span>
              <div className="flex flex-wrap gap-2">
                {WRITING_SKILL_MODE_OPTIONS.map((mode) => (
                  <OptionCheckbox
                    key={mode}
                    label={SKILL_MODE_LABELS[mode]}
                    checked={draftModes.includes(mode)}
                    testId={`writing-skill-mode-${mode}`}
                    onToggle={() => {
                      const next = toggleValue(draftModes, mode)
                      setDraftModes(next)
                      updateDraftDirty(draftName, draftDescription, draftContent, draftKind, draftStages, next)
                    }}
                  />
                ))}
              </div>
            </div>

            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">{t("skillLibrary.priority")}</span>
              <input
                type="number"
                min={1}
                max={100}
                value={draftPriority}
                onChange={(event) => {
                  const value = parseInt(event.target.value, 10)
                  const next = isNaN(value) ? 50 : Math.max(1, Math.min(100, value))
                  setDraftPriority(next)
                  updateDraftDirty(draftName, draftDescription, draftContent, draftKind, draftStages, draftModes, next)
                }}
                className="w-32 rounded-md border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <div className="grid gap-2 text-sm">
              <span className="font-medium">标签</span>
              <div className="flex flex-wrap items-center gap-2">
                {draftTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`${t("common.delete")} ${tag}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={handleTagKeyDown}
                  onBlur={handleAddTag}
                  placeholder={t("skillLibrary.tagPlaceholder")}
                  className="flex-1 min-w-[150px] rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            {isLinkedSkill ? (
              <div className="grid gap-1.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{t("skillLibrary.ruleBody")}</span>
                  <button
                    type="button"
                    onClick={() => void handleReloadLinkedContent()}
                    className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  >
                    重新读取
                  </button>
                </div>
                <div className="rounded-md border bg-info px-3 py-2 text-xs text-info">
                  此 Skill 为外部引用，内容实时读取
                </div>
                <textarea
                  readOnly
                  value={draftContent}
                  className="min-h-[420px] resize-y rounded-md border bg-muted px-3 py-2 font-mono text-xs leading-5 outline-none"
                />
                {selectedSkill.linkedPath ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                    <span className="shrink-0">{t("skillLibrary.refPath")}</span>
                    <code className="truncate min-w-0 rounded bg-muted px-1.5 py-0.5">{selectedSkill.linkedPath}</code>
                  </div>
                ) : null}
              </div>
            ) : (
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">{t("skillLibrary.ruleBody")}</span>
                <textarea
                  data-testid="writing-skill-content-input"
                  value={draftContent}
                  onChange={(event) => {
                    const next = event.target.value
                    setDraftContent(next)
                    updateDraftDirty(draftName, draftDescription, next)
                  }}
                  className="min-h-[420px] rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
            )}

            <div className="flex items-center gap-3">
              <button
                data-testid="writing-skill-save-button"
                type="button"
                onClick={() => void handleSaveSkill()}
                disabled={!canSaveDraft}
                className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "保存中..." : "保存"}
              </button>
              {message ? (
                <span className="text-sm text-muted-foreground">{message}</span>
              ) : draftDirty ? (
                <span className="text-sm text-warning">{t("skillLibrary.unsaved")}</span>
              ) : null}
            </div>
          </div>
        )}
      </main>

      {/* F-006 技能包交换（导入/导出均走本地文件）：此前无壳层入口。
          仅在宿主配置已加载时挂载——导入必须落到一个已知分类与已知库，
          否则会静默丢弃导入结果（面板只产出 `UserSkill[]`，落盘是本视图的责任）。
          高度上限是**必须的**：SkillPackPanel 声明 `h-full` + 内部 `flex-1 overflow-auto`，
          父链无确定高度时 `h-full` 解析为 auto，技能列表把本区块撑到 2000px 以上，
          再以 shrink-0 身份把上面 flex-1 的 <main> 挤到几十像素（实测 2023 vs 40）。 */}
      {config && project ? (
        <div
          className="max-h-[38vh] shrink-0 overflow-y-auto border-t px-5 py-3"
          data-testid="skill-pack-section"
        >
          <div className="w-full min-w-0 space-y-3">
            {/* A-F-002 / B-F-006 技能包（.zip）离线导入：此前同样无壳层入口。
                选文件用 Tauri 原生对话框（动态 import，与 sidebar-panel 一致）；
                落点根由宿主给出（用户不可在弹窗内改写）。 */}
            <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("skillLibrary.importPack")}</div>
                <div className="truncate text-xs text-muted-foreground">
                  导入落点：当前项目资产域（不可在弹窗内改写）
                </div>
              </div>
              <button
                type="button"
                data-testid="skill-bundle-import-open"
                className="shrink-0 rounded border px-3 py-1.5 text-sm"
                onClick={() => void handleOpenBundleImport()}
              >
                选择技能包…
              </button>
            </div>
            <div className="rounded-md border">
              <SkillPackPanel
                skills={config.skills}
                categoryId={draftCategoryId || config.categories[0]?.id || ""}
                onImported={(result) => void handlePackImported(result)}
              />
            </div>
          </div>
        </div>
      ) : null}

      <SkillBundleImportDialog
        open={bundleDialogOpen}
        bundlePath={bundlePath}
        destRoot={project?.path ?? null}
        onClose={() => setBundleDialogOpen(false)}
      />
    </div>
  )
}
