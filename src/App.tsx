import { useState, useEffect } from "react"
import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { isTauri, pickDirectory } from "@/lib/platform"
import { openProject } from "@/commands/fs"
import { saveScheduledImportConfig } from "@/lib/project-store"
import { setupAutoSave } from "@/lib/auto-save"
import { hydrateProjectOnOpen, initializeApp } from "@/lib/composition-root"
import { AppLayout } from "@/components/layout/app-layout"
import { WelcomeScreen } from "@/components/project/welcome-screen"
import { CreateProjectDialog } from "@/components/project/create-project-dialog"
import { formatAppTitle } from "@/lib/app-title"
import { resetProjectState } from "@/lib/reset-project-state"
import { toast } from "@/lib/toast"
import type { WikiProject } from "@/types/wiki"
import { applyTheme, watchSystemTheme } from "@/lib/theme-utils"

function App() {
  const project = useWikiStore((s) => s.project)
  const setProject = useWikiStore((s) => s.setProject)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const uiFontSizeScale = useWikiStore((s) => s.uiFontSizeScale)
  const communitySummaryError = useWikiStore((s) => s.communitySummaryError)
  const setCommunitySummaryError = useWikiStore((s) => s.setCommunitySummaryError)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    document.documentElement.style.fontSize = `${Math.round(uiFontSizeScale * 100)}%`
  }, [uiFontSizeScale])

  // 监听社区摘要生成错误，弹窗提示
  useEffect(() => {
    if (communitySummaryError) {
      toast.error(i18n.t("novel.settings.communitySummaryFailed", { message: communitySummaryError }))
      setCommunitySummaryError(null)
    }
  }, [communitySummaryError, setCommunitySummaryError])

  // Set up auto-save once on mount
  useEffect(() => {
    setupAutoSave()
  }, [])

  // 启动编排（组合根）：加载全部持久化配置并自动打开上次项目
  useEffect(() => {
    void initializeApp().finally(() => setLoading(false))
  }, [])

  // 监听系统主题变化，当设置为跟随系统时自动切换
  const theme = useWikiStore((s) => s.theme)
  useEffect(() => {
    if (theme === "system") {
      applyTheme("system")
      const unwatch = watchSystemTheme(() => {
        applyTheme("system")
      })
      return unwatch
    } else {
      applyTheme(theme)
    }
  }, [theme])

  useEffect(() => {
    const title = formatAppTitle(project?.name)
    document.title = title
    if (isTauri()) {
      import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
        .catch(() => {})
    }
  }, [project?.name])

  async function handleSelectRecent(proj: WikiProject) {
    try {
      const validated = await openProject(proj.path)
      await hydrateProjectOnOpen(validated)
    } catch (err) {
      window.alert(`打开项目失败：${err}`)
    }
  }

  async function handleOpenProject() {
    const path = await pickDirectory()
    if (!path) return
    try {
      const proj = await openProject(path)
      await hydrateProjectOnOpen(proj)
    } catch (err) {
      window.alert(`打开项目失败：${err}`)
    }
  }

  async function handleProjectCreated(proj: WikiProject) {
    try {
      await hydrateProjectOnOpen(proj)
    } catch (err) {
      window.alert(`项目创建后初始化失败：${err}`)
    }
  }

  async function handleSwitchProject() {
    // Stop scheduled import before switching projects
    import("@/lib/scheduled-import").then(({ stopScheduledImport }) => {
      stopScheduledImport()
    }).catch(() => {})

    // Save current project's scheduled import config before clearing
    const currentProject = useWikiStore.getState().project
    if (currentProject) {
      const currentConfig = useWikiStore.getState().scheduledImportConfig
      saveScheduledImportConfig(currentProject.path, currentConfig).catch(() => {})
    }

    // Clear all per-project state BEFORE flipping back to the welcome screen
    // so old data cannot leak in via any async render pass.
    await resetProjectState()
    setProject(null)
    setFileTree([])
    setSelectedFile(null)
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (!project) {
    return (
      <>
        <WelcomeScreen
          onCreateProject={() => setShowCreateDialog(true)}
          onOpenProject={handleOpenProject}
          onSelectProject={handleSelectRecent}
        />
        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onCreated={handleProjectCreated}
        />
      </>
    )
  }

  return (
    <>
      <AppLayout onSwitchProject={handleSwitchProject} />
      <CreateProjectDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleProjectCreated}
      />
    </>
  )
}

export default App
