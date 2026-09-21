import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FolderOpen } from "lucide-react"
import { createProject, writeFile, createDirectory, getExecutableDir, listDirectory } from "@/commands/fs"
import { getTemplate } from "@/lib/templates"
import { TemplatePicker } from "./template-picker"
import type { WikiProject } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore, type OutputLanguage } from "@/stores/wiki-store"
import { saveOutputLanguage } from "@/lib/project-store"
import { pickDirectory } from "@/lib/platform"
import { formatOperationError } from "@/lib/format-operation-error"
import { buildDefaultNovelDir } from "@/lib/default-paths"
import { assessLlmHealth } from "@/lib/llm-health"

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: WikiProject) => void
}

/** J01-T03 (F-003)：空名项目的无冲突暂名生成。
 * 首个空名用「未命名项目」；父目录已存在同名则追加序号「未命名项目 2/3/…」。
 * 列目录失败（如目录刚创建为空/权限）按无冲突处理，直接返回基础名。 */
async function resolveUntitledName(parentDir: string): Promise<string> {
  const base = "未命名项目"
  let existingNames: Set<string>
  try {
    const nodes = await listDirectory(parentDir)
    existingNames = new Set(nodes.map((n) => n.name))
  } catch {
    existingNames = new Set()
  }
  if (!existingNames.has(base)) return base
  let i = 2
  while (existingNames.has(`${base} ${i}`)) i += 1
  return `${base} ${i}`
}

export function CreateProjectDialog({ open: isOpen, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [path, setPath] = useState("")
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  // ②-3：模板选择（TemplatePicker 接入）；默认空白 general 模板，提交时 getTemplate(selectedTemplateId)
  const [selectedTemplateId, setSelectedTemplateId] = useState("general")
  const setOutputLanguage = useWikiStore((s) => s.setOutputLanguage)
  // J01-T01 (F-007)：模型服务健康检查——建项时可见 LLM 状态，可展开配置或明示跳过。
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [llmExpanded, setLlmExpanded] = useState(false)
  const llmHealth = assessLlmHealth(llmConfig)
  const llmTone = llmHealth.canWrite
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-amber-600 dark:text-amber-400"

  // J01-T06 (F-006)：建项步骤指示——让用户知道自己在哪一步、还剩几步。
  // 步骤为逻辑分区（名称→目录→模型服务→创建），非分页；返回/关闭不丢输入（state 保留）。
  const currentStep = name.trim().length > 0 ? 1 : 0
  const STEPS = [
    t("project.stepName", { defaultValue: "名称" }),
    t("project.stepPath", { defaultValue: "目录" }),
    t("project.stepLlm", { defaultValue: "模型服务" }),
    t("project.stepCreate", { defaultValue: "创建" }),
  ]

  async function resolveDefaultParentDir(): Promise<string> {
    let defaultPath = buildDefaultNovelDir("")
    try {
      const executableDir = await getExecutableDir()
      defaultPath = buildDefaultNovelDir(executableDir)
    } catch {
      // Keep fallback path.
    }
    return defaultPath
  }

  useEffect(() => {
    if (!isOpen) {
      setPath("")
      return
    }
    if (path.trim()) {
      return
    }

    let cancelled = false

    const initializePath = async () => {
      const defaultPath = await resolveDefaultParentDir()

      /* v8 ignore next */
      if (!cancelled) {
        setPath((currentPath) => (currentPath.trim() ? currentPath : defaultPath))
      }
    }

    void initializePath()

    return () => {
      cancelled = true
    }
  }, [isOpen, path])

  async function handleBrowse() {
    try {
      const dir = await pickDirectory()
      if (dir) setPath(dir)
    } catch (err) {
      // 本地化引导 + 原始诊断：目录选择失败不能静默无反馈。
      setError(formatOperationError(t, err))
    }
  }

  async function handleCreate() {
    const rawName = name.trim()
    setCreating(true)
    setError("")
    try {
      const parentDir = normalizePath(path.trim() || await resolveDefaultParentDir())
      if (!parentDir.trim()) {
        setError(t("project.errorParentDirRequired", "请先选择项目父目录"))
        return
      }

      setPath(parentDir)
      await createDirectory(parentDir)

      // J01-T03 (F-003)：空名→生成不冲突暂名「未命名项目 N」，后续可改名/题目工坊回填。
      // 冲突检测以父目录现有条目为准；序号从 2 起（首个直接「未命名项目」）。
      const finalName = rawName.length > 0
        ? rawName
        : await resolveUntitledName(parentDir)
      const project = await createProject(finalName, parentDir)
      const pp = normalizePath(project.path)

      const template = getTemplate(selectedTemplateId)
      await writeFile(`${pp}/schema.md`, template.schema)
      await writeFile(`${pp}/purpose.md`, template.purpose)
      for (const dir of template.extraDirs) {
        await createDirectory(`${pp}/${dir}`)
      }

      const lang: OutputLanguage = "Chinese"
      setOutputLanguage(lang)
      await saveOutputLanguage(lang, project.id)

      onCreated(project)
      onOpenChange(false)
      setName("")
      setPath("")
      setSelectedTemplateId("general")
    } catch (err) {
      // 本地化引导 + 原始诊断：引导语缺失时诊断不会丢。
      setError(`${t("project.createFailed", "创建项目失败")}：${String(err)}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("project.createTitle")}</DialogTitle>
          {/* J01-T06：步骤进度指示（逻辑分区，非分页） */}
          <div className="flex items-center gap-1 pt-2 text-xs text-muted-foreground" aria-label={t("project.stepProgress", { defaultValue: "创建步骤" })}>
            {STEPS.map((label, i) => (
              <span key={i} className="flex items-center">
                <span
                  className={i <= currentStep + 1
                    ? "rounded-full bg-primary px-1.5 py-0.5 text-primary-foreground"
                    : "rounded-full bg-muted px-1.5 py-0.5"}
                >
                  {i + 1}
                </span>
                <span className="ml-1 mr-2">{label}</span>
                {i < STEPS.length - 1 && <span className="mr-2 text-border">→</span>}
              </span>
            ))}
          </div>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!creating) {
              void handleCreate()
            }
          }}
        >
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">{t("project.name")}</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("project.namePlaceholder")} />
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("project.templateLabel", { defaultValue: "项目模板" })}</Label>
              <TemplatePicker selected={selectedTemplateId} onSelect={setSelectedTemplateId} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="path">{t("project.parentDir")}</Label>
              <div className="flex gap-2">
                <Input id="path" value={path} onChange={(e) => setPath(e.target.value)} placeholder={t("project.parentDirPlaceholder")} className="flex-1" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleBrowse}
                  type="button"
                  aria-label={t("project.browseParentDir", "浏览目录")}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {/* J01-T01：模型服务状态——可展开，不阻塞创建，但明示跳过后果 */}
            <div className="rounded-md border px-3 py-2">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left text-sm"
                onClick={() => setLlmExpanded((v) => !v)}
                aria-expanded={llmExpanded}
              >
                <span className="flex items-center gap-2">
                  <span className={llmTone}>●</span>
                  <span>{t("project.llmService")}</span>
                  <span className={`text-xs ${llmTone}`}>{llmHealth.label}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(llmExpanded ? "project.llmServiceCollapse" : "project.llmServiceExpand")}
                </span>
              </button>
              {llmExpanded && (
                <div className="mt-2 flex flex-col gap-2 border-t pt-2 text-xs text-muted-foreground">
                  {!llmHealth.canWrite && llmHealth.nextStep && (
                    <p>{llmHealth.nextStep}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onOpenChange(false)
                        setActiveView("settings")
                      }}
                    >
                      {t("project.llmConfigure")}
                    </Button>
                    <span>{t("project.llmSkipHint")}</span>
                  </div>
                </div>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("project.cancel")}</Button>
            <Button type="submit" disabled={creating}>{creating ? t("project.creating") : t("project.create")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
