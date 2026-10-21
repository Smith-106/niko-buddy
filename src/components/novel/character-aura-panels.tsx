import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { PencilLine, Plus, Save, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { CharacterAura, CharacterAuraGenerationProgress, CharacterAuraResearchFileName } from "@/lib/novel"
import { CHARACTER_AURA_RESEARCH_FILES, loadCharacterAuraResearchDocument, loadCharacterAuraSkillDocument } from "@/lib/novel"
import { formatOperationError } from "@/lib/format-operation-error"
import { WikiReader } from "@/components/editor/wiki-reader"
import { useWikiStore } from "@/stores/wiki-store"

export type AuraFormState = {
  name: string
  category: string
  sourceNote: string
  corpus: string
  styleDescription: string
  expressionDna: string
  mentalModel: string
  decisionHeuristics: string
  valueAntiPatterns: string
  honestyBoundaries: string
  behaviorRules: string
  boundaries: string
  notes: string
  sourceUrls: string
  localDocumentPaths: string
  generationPrompt: string
  enableWebSearch: boolean
}

export const EMPTY_FORM: AuraFormState = {
  name: "",
  category: "",
  sourceNote: "",
  corpus: "",
  styleDescription: "",
  expressionDna: "",
  mentalModel: "",
  decisionHeuristics: "",
  valueAntiPatterns: "",
  honestyBoundaries: "",
  behaviorRules: "",
  boundaries: "",
  notes: "",
  sourceUrls: "",
  localDocumentPaths: "",
  generationPrompt: "",
  enableWebSearch: false,
}

export const EMPTY_AURA_PREVIEW_MESSAGE = "未匹配到已绑定人物灵魂。只有任务中出现已绑定人物名时，灵魂才会注入。"

export function formFromAura(aura: CharacterAura) {
  return {
    name: aura.name,
    category: aura.category ?? "",
    sourceNote: aura.sourceNote,
    corpus: aura.corpus,
    styleDescription: aura.styleDescription,
    expressionDna: aura.expressionDna ?? aura.styleDescription,
    mentalModel: aura.mentalModel ?? aura.corpus,
    decisionHeuristics: aura.decisionHeuristics ?? aura.behaviorRules,
    valueAntiPatterns: aura.valueAntiPatterns ?? aura.notes,
    honestyBoundaries: aura.honestyBoundaries ?? aura.boundaries,
    behaviorRules: aura.behaviorRules,
    boundaries: aura.boundaries,
    notes: aura.notes,
    sourceUrls: aura.sourceUrls ?? "",
    localDocumentPaths: aura.localDocumentPaths ?? "",
    generationPrompt: aura.generationPrompt ?? "",
    enableWebSearch: aura.webSearchEnabled ?? false,
  }
}

export function buildUpdatePayload(form: AuraFormState) {
  const decisionHeuristics = form.decisionHeuristics.trim()
  const valueAntiPatterns = form.valueAntiPatterns.trim()
  const honestyBoundaries = form.honestyBoundaries.trim()

  return {
    name: form.name.trim(),
    category: form.category.trim(),
    sourceNote: form.sourceNote.trim(),
    corpus: form.corpus.trim(),
    styleDescription: form.styleDescription.trim(),
    behaviorRules: decisionHeuristics || form.behaviorRules.trim(),
    boundaries: honestyBoundaries || form.boundaries.trim(),
    notes: valueAntiPatterns || form.notes.trim(),
    expressionDna: form.expressionDna.trim(),
    mentalModel: form.mentalModel.trim(),
    decisionHeuristics,
    valueAntiPatterns,
    honestyBoundaries,
    sourceUrls: form.sourceUrls.trim(),
    localDocumentPaths: form.localDocumentPaths.trim(),
    generationPrompt: form.generationPrompt.trim(),
    webSearchEnabled: form.enableWebSearch,
  }
}

export function AuraDetails({
  aura,
  badgeLabel,
  onEdit,
  onDelete,
  actionsDisabled = false,
}: {
  aura: CharacterAura
  badgeLabel: string
  onEdit?: () => void
  onDelete?: () => void
  actionsDisabled?: boolean
}) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [skillDocument, setSkillDocument] = useState("")
  const [skillLoading, setSkillLoading] = useState(false)
  const [skillError, setSkillError] = useState("")
  const [researchFile, setResearchFile] = useState<CharacterAuraResearchFileName>("01-writings.md")
  const [researchDocument, setResearchDocument] = useState("")
  const [researchLoading, setResearchLoading] = useState(false)
  const [researchError, setResearchError] = useState("")

  useEffect(() => {
    let cancelled = false
    setSkillDocument("")
    setSkillError("")
    if (!aura.skillFolder) return
    setSkillLoading(true)
    loadCharacterAuraSkillDocument(aura, project?.path)
      .then((document) => {
        if (!cancelled) setSkillDocument(document)
      })
      .catch(() => {
        if (!cancelled) setSkillError(`灵魂文档读取失败：${aura.skillFolder}/SKILL.md`)
      })
      .finally(() => {
        if (!cancelled) setSkillLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [aura.id, aura.skillFolder, project?.path])

  useEffect(() => {
    let cancelled = false
    setResearchDocument("")
    setResearchError("")
    if (!aura.skillFolder) return
    setResearchLoading(true)
    loadCharacterAuraResearchDocument(aura, researchFile, project?.path)
      .then((document) => {
        if (!cancelled) setResearchDocument(document)
      })
      .catch((err) => {
        if (!cancelled) setResearchError(formatOperationError(t, err))
      })
      .finally(() => {
        if (!cancelled) setResearchLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [aura.id, aura.skillFolder, researchFile, project?.path])

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold min-w-0 break-words">{aura.name}</h2>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {onEdit && (
            <Button variant="outline" size="sm" onClick={onEdit} disabled={actionsDisabled}>
              <PencilLine className="mr-2 h-4 w-4 shrink-0" />
              编辑灵魂
            </Button>
          )}
          {onDelete && (
            <Button
              variant="outline"
              size="sm"
              onClick={onDelete}
              disabled={actionsDisabled}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4 shrink-0" />
              删除灵魂
            </Button>
          )}
          <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">{badgeLabel}</span>
        </div>
      </div>

      <Detail label={t("novel.soul.personCategory")} value={aura.category ?? "自定义灵魂"} />
      <Detail label={t("novel.soul.folder")} value={aura.skillFolder ?? "未关联灵魂文件夹"} />
      {!aura.builtIn && (
        <>
          <Detail label={t("novel.soul.generatePrompt")} value={aura.generationPrompt ?? ""} />
          <Detail label={t("novel.soul.aiSearch")} value={aura.webSearchEnabled ? "已开启" : "未开启"} />
        </>
      )}
      <Detail label={t("novel.soul.auraNote")} value={aura.sourceNote} />
      <Detail label={t("novel.soul.soulSummary")} value={aura.styleDescription} />
      <Detail label={t("novel.soul.howSpeak")} value={aura.expressionDna ?? aura.styleDescription} />
      <Detail label={t("novel.soul.howThink")} value={aura.mentalModel ?? aura.corpus} />
      <Detail label={t("novel.soul.howDecide")} value={aura.decisionHeuristics ?? aura.behaviorRules} />
      <Detail label={t("novel.soul.howRefuse")} value={aura.valueAntiPatterns ?? aura.notes} />
      <Detail label={t("novel.soul.howLimit")} value={aura.honestyBoundaries ?? aura.boundaries} />

      <div className="mt-5 rounded-md border bg-muted/20 p-4">
        <div className="mb-2 text-sm font-medium">{t("novel.soul.docPreview")}</div>
        {skillLoading && <div className="text-sm text-muted-foreground">{t("novel.soul.readingDoc")}</div>}
        {skillError && <div className="text-sm text-destructive">{skillError}</div>}
        {!skillLoading && !skillError && skillDocument && (
          <div className="max-h-96 overflow-auto rounded-md border bg-background p-3">
            <WikiReader body={skillDocument} />
          </div>
        )}
        {!skillLoading && !skillError && !skillDocument && <div className="text-sm text-muted-foreground">{t("novel.soul.noDoc")}</div>}
      </div>

      <div className="mt-5 rounded-md border bg-muted/20 p-4">
        <div className="mb-3 text-sm font-medium">{t("novel.soul.researchFiles")}</div>
        <div className="mb-3 flex flex-wrap gap-2">
          {CHARACTER_AURA_RESEARCH_FILES.map((file) => (
            <button
              key={file.fileName}
              type="button"
              onClick={() => setResearchFile(file.fileName)}
              className={`rounded-md border px-2 py-1 text-xs ${researchFile === file.fileName ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent"}`}
            >
              {file.label}
            </button>
          ))}
        </div>
        <div className="mb-2 text-xs text-muted-foreground" title={researchFile}>
          {CHARACTER_AURA_RESEARCH_FILES.find((file) => file.fileName === researchFile)?.label ?? researchFile}
        </div>
        {researchLoading && <div className="text-sm text-muted-foreground">{t("novel.soul.readingResearch")}</div>}
        {researchError && <div className="text-sm text-destructive">{researchError}</div>}
        {!researchLoading && !researchError && researchDocument && (
          <div className="max-h-80 overflow-auto rounded-md border bg-background p-3">
            <WikiReader body={researchDocument} />
          </div>
        )}
        {!researchLoading && !researchError && !researchDocument && <div className="text-sm text-muted-foreground">{t("novel.soul.noResearch")}</div>}
      </div>
    </div>
  )
}

export function CustomAuraForm({
  form,
  setForm,
  onCreate,
  onUpdate,
  onDelete,
  onCancel,
  mode,
  editing,
  isGenerating,
  generationProgress,
}: {
  form: AuraFormState
  setForm: (form: AuraFormState) => void
  onCreate: () => void
  onUpdate: () => void
  onDelete: () => void
  onCancel: () => void
  mode: "create" | "edit"
  editing: boolean
  isGenerating: boolean
  generationProgress: CharacterAuraGenerationProgress | null
}) {
  const { t } = useTranslation()
  const setField = (key: Exclude<keyof AuraFormState, "enableWebSearch">, value: string) => setForm({ ...form, [key]: value })
  const setBooleanField = (key: "enableWebSearch", value: boolean) => setForm({ ...form, [key]: value })

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{mode === "edit" ? "编辑角色灵魂" : "新建角色灵魂"}</h2>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isGenerating}>{t("novel.soul.backToPreview")}</Button>
      </div>

      <div className="space-y-5">
        <section className="rounded-md border bg-muted/10 p-4">
          <h3 className="mb-3 text-sm font-medium">{t("novel.soul.basicSettings")}</h3>
          <div className="grid gap-4">
            <Field label="名称" value={form.name} onChange={(value) => setField("name", value)} />
            <Field label={t("novel.soul.personCategory")} value={form.category} onChange={(value) => setField("category", value)} />
          </div>
        </section>

        <section className="rounded-md border bg-muted/10 p-4">
          <h3 className="mb-2 text-sm font-medium">{t("novel.soul.generateSettings")}</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            提示词会参与 6 步研究工作流；开启 AI 搜索后，会基于名称、分类和提示词联网补充资料。未配置 Web Search 时会自动降级为只使用你提供的资料。
          </p>
          <div className="grid gap-4">
            <TextField
              label={t("novel.soul.generatePrompt")}
              helper="例如：强调她的权力感、失而复得的克制、对亲密关系的防御性"
              value={form.generationPrompt}
              onChange={(value) => setField("generationPrompt", value)}
            />
            <label className="flex items-start gap-3 rounded-md border bg-background/70 px-3 py-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border"
                checked={form.enableWebSearch}
                onChange={(event) => setBooleanField("enableWebSearch", event.target.checked)}
              />
              <span className="space-y-1">
                <span className="block font-medium">{t("novel.soul.enableAiSearch")}</span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  开启后会先联网搜索公开资料，再把搜索结果连同你的资料一起导入 6 份研究文件；关闭时只依据你手动提供的资料生成。
                </span>
              </span>
            </label>
          </div>
        </section>

        {mode === "create" && (
          <section className="rounded-md border bg-muted/10 p-4">
            <h3 className="mb-2 text-sm font-medium">{t("novel.soul.flowPreview")}</h3>
            <p className="mb-3 text-xs leading-5 text-muted-foreground">
              点击“从资料生成角色灵魂”后，会先整理资料，再依次生成 6 份研究文件，最后汇总成角色灵魂。生成中会锁定切换，避免导出半成品。
            </p>
            {generationProgress ? (
              <div className="rounded-md border bg-background/80 p-3">
                <div className="text-sm font-medium">
                  {generationProgress.stage}（{generationProgress.step}/{generationProgress.total}）
                </div>
                <div className="mt-2 text-sm text-muted-foreground">{generationProgress.detail}</div>
                {generationProgress.researchFileName && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    当前研究文件：{generationProgress.researchFileName}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-dashed bg-background/50 px-3 py-3 text-sm text-muted-foreground">
                角色灵魂会按“公开资料 → 对话方式 → 表达特征 → 外部评价 → 决策记录 → 时间线”的顺序生成，再汇总成最终灵魂信息。
              </div>
            )}
          </section>
        )}

        {mode === "edit" ? (
          <>
            <section className="rounded-md border bg-muted/10 p-4">
              <h3 className="mb-2 text-sm font-medium">{t("novel.soul.currentInfo")}</h3>
              <p className="mb-3 text-xs text-muted-foreground">{t("novel.soul.editHint")}</p>
              <div className="grid gap-4">
                <TextField label={t("novel.soul.auraNote")} value={form.sourceNote} onChange={(value) => setField("sourceNote", value)} />
                <TextField label={t("novel.soul.soulSummary")} value={form.styleDescription} onChange={(value) => setField("styleDescription", value)} />
                <TextField label={t("novel.soul.howSpeak")} value={form.expressionDna} onChange={(value) => setField("expressionDna", value)} />
                <TextField label={t("novel.soul.howThink")} value={form.mentalModel} onChange={(value) => setField("mentalModel", value)} />
                <TextField label={t("novel.soul.howDecide")} value={form.decisionHeuristics} onChange={(value) => setField("decisionHeuristics", value)} />
                <TextField label={t("novel.soul.howRefuse")} value={form.valueAntiPatterns} onChange={(value) => setField("valueAntiPatterns", value)} />
                <TextField label={t("novel.soul.howLimit")} value={form.honestyBoundaries} onChange={(value) => setField("honestyBoundaries", value)} />
                <TextField label={t("novel.soul.sourceSummary")} value={form.corpus} onChange={(value) => setField("corpus", value)} />
              </div>
            </section>

            <section className="rounded-md border bg-muted/10 p-4">
              <h3 className="mb-2 text-sm font-medium">{t("novel.soul.sourceIndex")}</h3>
              <p className="mb-3 text-xs text-muted-foreground">{t("novel.soul.sourceMaintainHint")}</p>
              <div className="grid gap-4">
                <TextField label={t("novel.soul.webSourceUrl")} helper="一行一个网页地址" value={form.sourceUrls} onChange={(value) => setField("sourceUrls", value)} />
                <TextField label={t("novel.soul.localDocPath")} helper="一行一个本地文档路径" value={form.localDocumentPaths} onChange={(value) => setField("localDocumentPaths", value)} />
              </div>
            </section>
          </>
        ) : (
          <section className="rounded-md border bg-muted/10 p-4">
            <h3 className="mb-2 text-sm font-medium">{t("novel.soul.importSettings")}</h3>
            <p className="mb-3 text-xs text-muted-foreground">{t("novel.soul.importHint")}</p>
            <div className="grid gap-4">
              <TextField label={t("novel.soul.sourceText")} value={form.corpus} onChange={(value) => setField("corpus", value)} />
              <TextField label={t("novel.soul.webSourceUrl")} helper="一行一个网页地址" value={form.sourceUrls} onChange={(value) => setField("sourceUrls", value)} />
              <TextField label={t("novel.soul.localDocPath")} helper="一行一个本地文档路径" value={form.localDocumentPaths} onChange={(value) => setField("localDocumentPaths", value)} />
            </div>
          </section>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <Button
          onClick={mode === "edit" ? onUpdate : onCreate}
          disabled={!form.name.trim() || (mode === "edit" && !editing) || isGenerating}
        >
          {mode === "edit" ? <Save className="mr-2 h-4 w-4 shrink-0" /> : <Plus className="mr-2 h-4 w-4 shrink-0" />}
          {mode === "edit"
            ? "保存修改"
            : isGenerating
              ? `正在生成角色灵魂${generationProgress ? `（${generationProgress.step}/${generationProgress.total}）` : ""}`
              : "从资料生成角色灵魂"}
        </Button>
        {mode === "edit" && editing && (
          <Button variant="outline" onClick={onDelete} disabled={isGenerating}>
            <Trash2 className="mr-2 h-4 w-4 shrink-0" />
            删除
          </Button>
        )}
      </div>
    </div>
  )
}

export function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-3">
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{value || "未填写"}</div>
    </div>
  )
}

export function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input className="mt-1" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

export function TextField({
  label,
  helper,
  value,
  onChange,
}: {
  label: string
  helper?: string
  value: string
  onChange: (value: string) => void
}) {
  const fieldId = useId()
  return (
    <div>
      <Label htmlFor={fieldId}>{label}</Label>
      {helper && <div className="mt-1 text-xs text-muted-foreground">{helper}</div>}
      <textarea
        id={fieldId}
        className="mt-1 min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
