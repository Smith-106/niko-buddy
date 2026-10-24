import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, Link2, Plus, Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Pagination, PAGINATION_PAGE_SIZE } from "@/components/ui/pagination"
import { streamChat, type ChatMessage } from "@/lib/llm-client"
import { buildContextPack, contextPackToPrompt, resolveNovelModel, bindCharacterAura, buildCharacterAuraContext, BUILT_IN_CHARACTER_AURAS, createCustomCharacterAuraSkill, deleteCustomCharacterAura, getCharacterAuraBindings, listBindableNovelCharacters, listCharacterAuras, unbindCharacterAura, updateCustomCharacterAura } from "@/lib/novel"
import type { CharacterAura, CharacterAuraBinding, CharacterAuraGenerationProgress } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { SoulDocEditor } from "./soul-doc-editor"
import { WikiReader } from "@/components/editor/wiki-reader"
import { refreshProjectState } from "@/lib/project-refresh"

import {
  AuraDetails, CustomAuraForm, EMPTY_FORM, EMPTY_AURA_PREVIEW_MESSAGE, formFromAura, buildUpdatePayload,
  type AuraFormState,
} from "./character-aura-panels"


export function CharacterAuraView({ hideSidebar = false }: { hideSidebar?: boolean }) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const storedSelectedSoulId = useWikiStore((s) => s.selectedSoulId)
  const setStoredSelectedSoulId = useWikiStore((s) => s.setSelectedSoulId)
  const storedSelectedSoulSection = useWikiStore((s) => s.selectedSoulSection)
  const setStoredSelectedSoulSection = useWikiStore((s) => s.setSelectedSoulSection)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
  const [section, setSection] = useState<"builtIn" | "custom">("builtIn")
  const [mode, setMode] = useState<"create" | "edit">("create")
  const [showCustomEditor, setShowCustomEditor] = useState(false)
  const [auras, setAuras] = useState<CharacterAura[]>(BUILT_IN_CHARACTER_AURAS)
  const [selectedId, setSelectedId] = useState(BUILT_IN_CHARACTER_AURAS[0]?.id ?? "")
  const [form, setForm] = useState<AuraFormState>(EMPTY_FORM)
  const [characterName, setCharacterName] = useState("")
  const [characterAliases, setCharacterAliases] = useState("")
  const [characterOptions, setCharacterOptions] = useState<string[]>([])
  const [bindings, setBindings] = useState<CharacterAuraBinding[]>([])
  const [auraPreviewTask, setAuraPreviewTask] = useState("")
  const [auraPreview, setAuraPreview] = useState("")
  const [auraPreviewLoading, setAuraPreviewLoading] = useState(false)
  const [isGeneratingCustomAura, setIsGeneratingCustomAura] = useState(false)
  const [generationProgress, setGenerationProgress] = useState<CharacterAuraGenerationProgress | null>(null)
  const [message, setMessage] = useState("")
  const [soulTab, setSoulTab] = useState<"project" | "character">("project")
  const [auraPage, setAuraPage] = useState(0)
  const AURA_PAGE_SIZE = PAGINATION_PAGE_SIZE
  const effectiveSection = hideSidebar ? storedSelectedSoulSection : section
  const effectiveSelectedId = hideSidebar ? (storedSelectedSoulId ?? "") : selectedId

  const builtInAuras = useMemo(() => auras.filter((aura) => aura.builtIn), [auras])
  const customAuras = useMemo(() => auras.filter((aura) => !aura.builtIn), [auras])
  const visibleAuras = effectiveSection === "builtIn" ? builtInAuras : customAuras
  const auraPageCount = Math.max(1, Math.ceil(visibleAuras.length / AURA_PAGE_SIZE))
  const visibleAuraPageItems = visibleAuras.slice(auraPage * AURA_PAGE_SIZE, (auraPage + 1) * AURA_PAGE_SIZE)
  // 分节（内置/自定义）切换 → 回到第 1 页（覆盖本地 section 与 hideSidebar 时的 stored section）
  useEffect(() => {
    setAuraPage(0)
  }, [effectiveSection])
  // 列表缩容兜底（数据重载后变短）
  useEffect(() => {
    if (auraPage > auraPageCount - 1) setAuraPage(0)
  }, [auraPage, auraPageCount])
  const selected = useMemo(
    () => {
      if (effectiveSelectedId === "new-custom-soul") return null
      return visibleAuras.find((aura) => aura.id === effectiveSelectedId) ?? visibleAuras[0] ?? null
    },
    [visibleAuras, effectiveSelectedId],
  )
  const selectedBindings = useMemo(
    () => bindings.filter((binding) => binding.auraId === selected?.id),
    [bindings, selected?.id],
  )

  function updateSelectedId(nextId: string) {
    if (hideSidebar) {
      setStoredSelectedSoulId(nextId)
      return
    }
    setSelectedId(nextId)
  }

  function updateSection(nextSection: "builtIn" | "custom") {
    if (hideSidebar) {
      setStoredSelectedSoulSection(nextSection)
      return
    }
    setSection(nextSection)
  }

  const projectPathRef = useRef(project?.path)
  projectPathRef.current = project?.path

  useEffect(() => {
    if (!project) return
    void runAction(refresh, "角色灵魂加载失败，请稍后重试")
  }, [project?.path])

  useEffect(() => {
    if (!selected || selected.builtIn || mode !== "edit" || !showCustomEditor) return
    setForm(formFromAura(selected))
  }, [selected?.id, mode, showCustomEditor])

  useEffect(() => {
    if (!hideSidebar) return
    if (storedSelectedSoulSection === "custom" && storedSelectedSoulId === "new-custom-soul") {
      setMode("create")
      setForm(EMPTY_FORM)
      setShowCustomEditor(true)
      return
    }
    setShowCustomEditor(false)
  }, [hideSidebar, storedSelectedSoulId, storedSelectedSoulSection])

  async function refresh() {
    /* v8 ignore next */
    if (!project) return
    const requestPath = project.path
    const [loaded, loadedCharacters, loadedBindings] = await Promise.all([
      listCharacterAuras(project.path),
      listBindableNovelCharacters(project.path),
      getCharacterAuraBindings(project.path),
    ])
    // 项目已切换：丢弃过期响应，避免旧项目数据覆盖新项目状态。
    /* v8 ignore next */
    if (projectPathRef.current !== requestPath) return
    setAuras(loaded)
    setCharacterOptions(loadedCharacters)
    setBindings(loadedBindings)
    setCharacterName((current) => {
      if (current && loadedCharacters.includes(current)) return current
      return loadedCharacters[0] ?? ""
    })
    setSelectedId((current) => {
      const currentSelectedId = hideSidebar ? (storedSelectedSoulId ?? "") : current
      if (currentSelectedId !== "new-custom-soul" && loaded.some((aura) => aura.id === currentSelectedId)) {
        return currentSelectedId
      }
      const fallback = effectiveSection === "custom"
        ? loaded.find((aura) => !aura.builtIn)?.id
        : loaded.find((aura) => aura.builtIn)?.id
      const nextId = fallback ?? loaded[0]?.id ?? ""
      if (hideSidebar) {
        setStoredSelectedSoulId(nextId)
      }
      return nextId
    })
  }

  async function runAction(action: () => Promise<void>, fallbackMessage: string) {
    try {
      await action()
    } catch (error) {
      setMessage(error instanceof Error && error.message ? error.message : fallbackMessage)
    }
  }

  function blockWhileGenerating(nextMessage?: string): boolean {
    if (!isGeneratingCustomAura) return false
    const progressLabel = generationProgress
      ? `当前正在执行「${generationProgress.stage}」(${generationProgress.step}/${generationProgress.total})`
      : "当前正在生成角色灵魂"
    setMessage(nextMessage ?? `${progressLabel}，请等待完成后再切换或操作其他灵魂。`)
    return true
  }

  async function handleCreate() {
    if (!project || !form.name.trim() || blockWhileGenerating()) return
    setIsGeneratingCustomAura(true)
    setGenerationProgress(null)
    setMessage("正在启动角色灵魂工作流，请稍候。")
    try {
      const created = await createCustomCharacterAuraSkill(project.path, {
        name: form.name.trim(),
        category: form.category.trim(),
        corpus: form.corpus.trim(),
        sourceUrls: form.sourceUrls.trim(),
        localDocumentPaths: form.localDocumentPaths.trim(),
        generationPrompt: form.generationPrompt.trim(),
        enableWebSearch: form.enableWebSearch,
      }, {
        onProgress: (progress) => {
          setGenerationProgress(progress)
          setMessage(`${progress.stage}（${progress.step}/${progress.total}）：${progress.detail}`)
        },
      })
      await refresh()
      updateSection("custom")
      setMode("edit")
      setShowCustomEditor(false)
      updateSelectedId(created.id)
      await refreshProjectState(project.path)
      setMessage("自定义灵魂已按 6 步工作流生成并保存到当前小说项目")
    } catch (error) {
      setMessage(error instanceof Error && error.message ? error.message : "自定义灵魂生成失败，请检查项目文件权限后重试")
    } finally {
      setIsGeneratingCustomAura(false)
      setGenerationProgress(null)
    }
  }

  async function handleUpdate() {
    /* v8 ignore next */
    if (!project || !selected || selected.builtIn || !form.name.trim() || blockWhileGenerating()) return
    await runAction(async () => {
      const updated = await updateCustomCharacterAura(project.path, selected.id, buildUpdatePayload(form))
      await refresh()
      updateSelectedId(updated.id)
      setShowCustomEditor(false)
      await refreshProjectState(project.path)
      setMessage("自定义灵魂已更新")
    }, "自定义灵魂更新失败，请检查项目文件权限后重试")
  }

  async function handleDelete(targetAura?: CharacterAura) {
    /* v8 ignore next */
    const aura = targetAura ?? selected
    /* v8 ignore next */
    if (!project || !aura || aura.builtIn || blockWhileGenerating()) return
    if (!window.confirm(`删除「${aura.name}」这个自定义灵魂？删除后会同时移除相关绑定关系。`)) return
    await runAction(async () => {
      await deleteCustomCharacterAura(project.path, aura.id)
      setForm(EMPTY_FORM)
      setMode("create")
      setShowCustomEditor(false)
      await refresh()
      await refreshProjectState(project.path)
      setMessage("自定义灵魂已删除")
    }, "自定义灵魂删除失败，请检查项目文件权限后重试")
  }

  async function handleBind() {
    /* v8 ignore next */
    if (!project || !selected || !characterName.trim() || blockWhileGenerating("角色灵魂生成完成后再绑定人物，避免把半成品绑定进剧情。")) return
    await runAction(async () => {
      const aliases = characterAliases
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      await bindCharacterAura(project.path, {
        characterName: characterName.trim(),
        auraId: selected.id,
        aliases: aliases.length > 0 ? aliases : undefined,
      })
      await refresh()
      bumpDataVersion()
      setMessage(`已将「${selected.name}」绑定到人物「${characterName.trim()}」`)
      setCharacterAliases("")
    }, "绑定失败，请稍后重试")
  }

  async function handleUnbind(targetCharacterName: string) {
    if (!project || !selected || blockWhileGenerating()) return
    await runAction(async () => {
      await unbindCharacterAura(project.path, targetCharacterName, selected.id)
      await refresh()
      bumpDataVersion()
      setMessage(`已取消“${targetCharacterName}”与“${selected.name}”的绑定`)
    }, "取消绑定失败，请稍后重试")
  }

  async function handlePreviewAuraContext() {
    /* v8 ignore next */
    if (!project || !auraPreviewTask.trim()) return
    const requestPath = project.path
    setAuraPreviewLoading(true)
    setAuraPreview("")
    await runAction(async () => {
      const characterAuraPreview = await buildCharacterAuraContext(
        project.path,
        auraPreviewTask,
        selected ? { fallbackAuraId: selected.id } : undefined,
      )
      if (!characterAuraPreview.trim()) {
        setAuraPreview(EMPTY_AURA_PREVIEW_MESSAGE)
        return
      }
      const contextPack = await buildContextPack(project.path, auraPreviewTask)
      const previewPack = { ...contextPack, characterAuras: characterAuraPreview }
      const contextPrompt = contextPackToPrompt(previewPack, novelConfig.contextTokenBudget > 0 ? novelConfig.contextTokenBudget : undefined, { hardInjectEnabled: novelConfig.hardInjectEnabled })
      const effectiveConfig = resolveNovelModel(llmConfig, novelConfig, "writing")
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: "你是小说写作预览助手。请严格根据给定的小说上下文和角色灵魂，只输出一小段用于测试效果的中文小说正文，不要解释，不要分点，不要加标题，不要输出分析说明。",
        },
        {
          role: "user",
          content: [
            contextPrompt,
            "",
            "## 本次预览任务",
            auraPreviewTask,
            "",
            "请直接生成一小段正文预览，重点体现当前角色灵魂已经如何影响这段写作。",
          ].join("\n"),
        },
      ]
      let preview = ""
      let streamError: Error | null = null
      await streamChat(
        effectiveConfig,
        messages,
        {
          onToken: (token) => {
            preview += token
          },
          onDone: () => undefined,
          onError: (error) => {
            streamError = error
          },
        },
        AbortSignal.timeout(120000),
        { temperature: 0.7 },
      )
      if (streamError) throw streamError
      // 项目已切换：丢弃过期预览，避免旧项目灵魂预览写进新项目状态。
      /* v8 ignore next */
      if (projectPathRef.current !== requestPath) return
      setAuraPreview(preview.trim() ? preview.trim() : EMPTY_AURA_PREVIEW_MESSAGE)
    }, "灵魂注入预览失败，请稍后重试")
    setAuraPreviewLoading(false)
  }

  function handleSelectBuiltInSection() {
    /* v8 ignore next */
    if (blockWhileGenerating()) return
    updateSection("builtIn")
    setShowCustomEditor(false)
    if (!selected?.builtIn && builtInAuras[0]) {
      updateSelectedId(builtInAuras[0].id)
    }
  }

  function handleSelectCustomSection() {
    /* v8 ignore next */
    if (blockWhileGenerating()) return
    updateSection("custom")
    setShowCustomEditor(false)
    if ((selected?.builtIn ?? true) && customAuras[0]) {
      updateSelectedId(customAuras[0].id)
    }
  }

  function handleStartCreatingCustomAura() {
    /* v8 ignore next */
    if (blockWhileGenerating()) return
    updateSection("custom")
    setMode("create")
    setForm(EMPTY_FORM)
    setShowCustomEditor(true)
  }

  function handleStartEditingCustomAura() {
    /* v8 ignore next */
    if (!selected || selected.builtIn || blockWhileGenerating()) return
    setForm(formFromAura(selected))
    setMode("edit")
    setShowCustomEditor(true)
  }

  return (
    <div className="flex flex-col h-full">
      {!hideSidebar && (
      <div className="flex border-b shrink-0">
        <button
          role="tab"
          aria-selected={soulTab === "project"}
          className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors ${
            soulTab === "project"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setSoulTab("project")}
        >
          {t("novel.soul.projectSoul")}
        </button>
        <button
          role="tab"
          aria-selected={soulTab === "character"}
          className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors ${
            soulTab === "character"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setSoulTab("character")}
        >
          {t("novel.soul.characterSoul")}
        </button>
      </div>
      )}

      {soulTab === "project" && !hideSidebar ? (
        <SoulDocEditor />
      ) : (
        <div className="flex-1 flex overflow-hidden">
      {!hideSidebar && (
      <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/30">
        <div className="border-b p-4">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="h-5 w-5 shrink-0 text-primary" />
            角色灵魂
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            角色灵魂必须绑定到已有小说人物；建议先在大纲中写清人物小传、性格、动机和关系，再绑定灵魂。
          </p>
        </div>

        <div className="flex border-b text-sm">
          <button
            type="button"
            onClick={handleSelectBuiltInSection}
            disabled={isGeneratingCustomAura}
            className={`flex-1 px-3 py-2 ${section === "builtIn" ? "border-b-2 border-primary font-medium" : "text-muted-foreground"} ${isGeneratingCustomAura ? "cursor-not-allowed opacity-60" : ""}`}
          >
            内置灵魂
          </button>
          <button
            type="button"
            onClick={handleSelectCustomSection}
            disabled={isGeneratingCustomAura}
            className={`flex-1 px-3 py-2 ${section === "custom" ? "border-b-2 border-primary font-medium" : "text-muted-foreground"} ${isGeneratingCustomAura ? "cursor-not-allowed opacity-60" : ""}`}
          >
            自定义灵魂
          </button>
        </div>

          {effectiveSection === "custom" && (
          <div className="border-b p-2">
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start"
              onClick={handleStartCreatingCustomAura}
              disabled={isGeneratingCustomAura}
            >
              <Plus className="mr-2 h-4 w-4 shrink-0" />
              新建角色灵魂
            </Button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">
          {visibleAuraPageItems.map((aura) => (
            <button
              key={aura.id}
              type="button"
              disabled={isGeneratingCustomAura}
              onClick={() => {
                /* v8 ignore next */
                if (blockWhileGenerating()) return
                updateSelectedId(aura.id)
                if (!aura.builtIn) setShowCustomEditor(false)
              }}
              className={`mb-1 w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${selected?.id === aura.id ? "qm-selected" : "text-muted-foreground qm-hover"} ${isGeneratingCustomAura ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <div className="font-medium">{aura.name}</div>
              <div className="mt-1 text-xs opacity-80">{aura.category ?? "自定义灵魂"}</div>
              <div className="mt-1 line-clamp-2 text-xs opacity-80">{aura.styleDescription}</div>
            </button>
          ))}

          <Pagination
            page={auraPage + 1}
            pageCount={auraPageCount}
            total={visibleAuras.length}
            onPrev={() => setAuraPage((p) => Math.max(0, p - 1))}
            onNext={() => setAuraPage((p) => Math.min(auraPageCount - 1, p + 1))}
          />

          {effectiveSection === "custom" && visibleAuras.length === 0 && (
            <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
              <div>暂无自定义灵魂</div>
              <div className="mt-2 text-xs">{t("novel.soul.createFirstHint")}</div>
            </div>
          )}
        </div>
      </aside>
      )}

      <main className="flex-1 overflow-y-auto p-6">
        <div className="w-full min-w-0 space-y-6">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-2 font-semibold">绑定小说人物</h3>
            <p className="mb-3 text-sm text-muted-foreground">{t("novel.soul.bindHint")}</p>
            <div className="flex gap-2">
              <select
                aria-label={t("novel.soul.bindCharacterLabel", "绑定小说人物")}
                value={characterName}
                onChange={(event) => setCharacterName(event.target.value)}
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                disabled={characterOptions.length === 0 || isGeneratingCustomAura}
              >
                {characterOptions.length === 0 ? (
                  <option value="">{t("novel.soul.addCharacterFirst")}</option>
                ) : (
                  characterOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))
                )}
              </select>
              <Button onClick={handleBind} disabled={!selected || !characterName.trim() || isGeneratingCustomAura || characterOptions.length === 0}>
                <Link2 className="mr-2 h-4 w-4 shrink-0" />
                绑定
              </Button>
            </div>
            <div className="mt-3">
              <Label>{t("novel.soul.aliasLabel")}</Label>
              <input
                type="text"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={characterAliases}
                onChange={(event) => setCharacterAliases(event.target.value)}
                placeholder={t("novel.soul.aliasPlaceholder")}
                disabled={characterOptions.length === 0 || isGeneratingCustomAura}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t("novel.soul.aliasHint")}</p>
            </div>
            <div className="mt-3 rounded-md border bg-muted/20 p-3">
              <div className="text-xs font-medium text-muted-foreground">{t("novel.soul.currentBound")}</div>
              {selectedBindings.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedBindings.map((binding) => (
                    <button
                      key={`${binding.auraId}:${binding.characterName}`}
                      type="button"
                      onClick={() => void handleUnbind(binding.characterName)}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1 text-xs qm-hover"
                    >
                      <span className="min-w-0 truncate">
                        {binding.characterName}
                        {binding.aliases && binding.aliases.length > 0 ? `（别名：${binding.aliases.join("、")}）` : ""}
                      </span>
                      <Trash2 className="h-3 w-3 shrink-0 text-destructive" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-xs text-muted-foreground">{t("novel.soul.currentUnbound")}</div>
              )}
            </div>
            {message && <div role="status" className="mt-3 text-sm text-muted-foreground">{message}</div>}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="text-sm leading-6 text-muted-foreground">
                创建自定义灵魂时，仅使用公开或已授权资料，避免输入隐私、敏感信息或未授权聊天记录。角色灵魂不是复活真人，也不能用于冒充、欺骗或替代真实人物。
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-2 font-semibold">{t("novel.soul.injectPreview")}</h3>
            <p className="mb-3 text-sm text-muted-foreground">{t("novel.soul.previewHint")}</p>
            <Label>{t("novel.soul.taskLabel")}</Label>
            <textarea
              className="mt-1 min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={auraPreviewTask}
              onChange={(event) => setAuraPreviewTask(event.target.value)}
              placeholder={t("novel.soul.taskPlaceholder")}
            />
            <div className="mt-3 flex items-center gap-2">
              <Button onClick={handlePreviewAuraContext} disabled={!project || !auraPreviewTask.trim() || auraPreviewLoading}>
                预览本次注入
              </Button>
              {auraPreviewLoading && <span className="text-sm text-muted-foreground">{t("novel.soul.building")}</span>}
            </div>
            <div className="mt-3 rounded-md border bg-muted/20 p-3 text-sm leading-6 text-muted-foreground">
              {auraPreview ? <WikiReader body={auraPreview} /> : EMPTY_AURA_PREVIEW_MESSAGE}
            </div>
          </div>

          {effectiveSection === "custom" ? (
            showCustomEditor ? (
              <CustomAuraForm
                form={form}
                setForm={setForm}
                onCreate={handleCreate}
                onUpdate={handleUpdate}
                onDelete={() => void handleDelete(selected ?? undefined)}
                onCancel={() => setShowCustomEditor(false)}
                mode={mode}
                editing={Boolean(selected && !selected.builtIn)}
                isGenerating={isGeneratingCustomAura}
                generationProgress={generationProgress}
              />
            ) : selected ? (
              <AuraDetails
                aura={selected}
                badgeLabel="自定义灵魂"
                onEdit={handleStartEditingCustomAura}
                onDelete={() => void handleDelete(selected)}
                actionsDisabled={isGeneratingCustomAura}
              />
            ) : (
              <div className="rounded-lg border border-dashed bg-card p-6 text-sm text-muted-foreground">
                还没有自定义灵魂。点击左侧上方“新建角色灵魂”后，就可以生成并保存到当前小说项目。
              </div>
            )
          ) : selected && selected.builtIn ? (
            <AuraDetails aura={selected} badgeLabel="内置灵魂" actionsDisabled={isGeneratingCustomAura} />
          ) : null}
        </div>
      </main>
        </div>
      )}
    </div>
  )
}

