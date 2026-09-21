import { useEffect, useState } from "react"
import { FolderOpen, Plus, Clock, X, Database } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getRecentProjects, removeFromRecentProjects } from "@/lib/project-store"
import type { WikiProject } from "@/types/wiki"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { importBackup } from "@/lib/backup/import"

interface WelcomeScreenProps {
  onCreateProject: () => void
  onOpenProject: () => void
  onSelectProject: (project: WikiProject) => void
}

export function WelcomeScreen({
  onCreateProject,
  onOpenProject,
  onSelectProject,
}: WelcomeScreenProps) {
  const { t } = useTranslation()
  const novelMode = useWikiStore((s) => s.novelMode)
  const [recentProjects, setRecentProjects] = useState<WikiProject[]>([])
  const [isRestoring, setIsRestoring] = useState(false)
  // J01-T05 (F-001)：恢复数据为低频高危操作——需应用内确认，不直接用原生 alert/一键触发
  const [confirmRestore, setConfirmRestore] = useState(false)

  useEffect(() => {
    getRecentProjects().then(setRecentProjects).catch(() => {})
  }, [])

  async function handleRemoveRecent(e: React.MouseEvent, path: string) {
    e.stopPropagation()
    await removeFromRecentProjects(path)
    const updated = await getRecentProjects()
    setRecentProjects(updated)
  }

  async function handleRestoreBackup() {
    if (isRestoring) return
    setIsRestoring(true)
    try {
      const result = await importBackup("full", undefined, (_progress) => {
      })
      if (result.success) {
        // 恢复成功后刷新最近项目列表
        const updated = await getRecentProjects()
        setRecentProjects(updated)
        alert(`恢复成功！共恢复 ${result.projects.filter(p => p.success).length} 个项目。\n请在列表中选择项目打开。`)
      } else {
        alert(`恢复失败：${result.error || "未知错误"}`)
      }
    } catch (e) {
      alert(`恢复失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setIsRestoring(false)
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-8 px-4">
        <div className="text-center">
          <h1 className="text-3xl font-bold">{t(novelMode ? "novel.app.title" : "app.title")}</h1>
          <p className="mt-2 text-muted-foreground">
            {t(novelMode ? "novel.app.subtitle" : "app.subtitle")}
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-3">
          <Button onClick={onCreateProject}>
            <Plus className="mr-2 h-4 w-4" />
            {t("welcome.newProject")}
          </Button>
          <Button variant="outline" onClick={onOpenProject}>
            <FolderOpen className="mr-2 h-4 w-4" />
            {t("welcome.openProject")}
          </Button>
          {/* J01-T05：恢复数据降级为次级入口（ghost+小字），主操作=新建/打开 */}
          <Button variant="ghost" size="sm" onClick={() => setConfirmRestore(true)} disabled={isRestoring}>
            <Database className="mr-2 h-4 w-4" />
            {isRestoring ? "恢复中..." : t("welcome.restoreBackup", { defaultValue: "恢复先前数据" })}
          </Button>
        </div>

        {/* 新手引导：首次无项目时显示3步快速上手（ISO 3.4.2 learnability + 3.4.8 self-descriptiveness） */}
        {recentProjects.length === 0 && (
          <div className="w-full max-w-md rounded-lg border bg-muted/30 p-4">
            <div className="mb-3 text-sm font-medium">
              {t("welcome.quickStart", { defaultValue: "快速上手" })}
            </div>
            <ol className="space-y-2 text-xs text-muted-foreground">
              <li className="flex gap-2">
                <span className="font-medium text-foreground">1.</span>
                {t("welcome.quickStart1", {
                  defaultValue: novelMode
                    ? "新建项目 —— 创建工作区（小说模式默认开启：wiki + .novel 记忆）"
                    : "新建项目 —— 选择目录，创建 wiki 知识库工作区",
                })}
              </li>
              <li className="flex gap-2">
                <span className="font-medium text-foreground">2.</span>
                {t("welcome.quickStart2", {
                  defaultValue: novelMode
                    ? "配置 LLM —— 设置 → LLM 提供商，填 API endpoint + key（支持代理）"
                    : "开始编辑 —— 左侧文件树新建/编辑 markdown 页面",
                })}
              </li>
              <li className="flex gap-2">
                <span className="font-medium text-foreground">3.</span>
                {t("welcome.quickStart3", {
                  defaultValue: novelMode
                    ? "开始写作 —— 章节生成走 Draft-first：AI 草稿 accept 后才写正式，安全可靠"
                    : "使用功能 —— 搜索/图谱/导入导出在顶部工具栏",
                })}
              </li>
            </ol>
          </div>
        )}

        {recentProjects.length > 0 && (
          <div className="w-full max-w-md">
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {t("welcome.recentProjects")}
            </div>
            <div className="rounded-lg border">
              {recentProjects.map((proj) => (
                <button
                  key={proj.path}
                  onClick={() => onSelectProject(proj)}
                  className="group flex w-full items-center justify-between border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{proj.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {proj.path}
                    </div>
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(e) => handleRemoveRecent(e, proj.path)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRemoveRecent(e as unknown as React.MouseEvent, proj.path)
                    }}
                    className="ml-2 shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/10 group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* J01-T05：恢复前应用内确认——说明操作性质+将进入文件选择；不直接用 alert */}
        {confirmRestore && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
            <div className="w-full max-w-sm rounded-lg border bg-background p-5 shadow-lg">
              <h2 className="text-base font-semibold">
                {t("welcome.restoreConfirmTitle", { defaultValue: "恢复先前数据？" })}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {t("welcome.restoreConfirmBody", { defaultValue: "将从备份文件恢复项目数据。下一步会选择备份文件；现有同名项目可能被覆盖，请先确认已备份当前工作。" })}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setConfirmRestore(false)}>
                  {t("project.cancel", { defaultValue: "取消" })}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirmRestore(false)
                    void handleRestoreBackup()
                  }}
                >
                  {t("welcome.restoreConfirmGo", { defaultValue: "选择备份并恢复" })}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
