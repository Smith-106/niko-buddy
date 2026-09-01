import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { X, MessageCircle, Trash2, Clock, User, ChevronRight, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import { useWikiStore } from "@/stores/wiki-store"
import { loadInterviews, deleteInterview } from "@/lib/novel/story-simulation/interview-store"
import { exportInterview } from "@/lib/novel/story-simulation/interview-export"
import { deserializeSimulationSnapshot } from "@/lib/novel/story-simulation/simulation-serializer"
import { loadSimulationResults } from "@/lib/novel/story-simulation/framework-store"
import type { SavedInterview } from "@/lib/novel/story-simulation/interview-store"
import type { NovelAgent } from "@/lib/novel/story-simulation/types"

export function InterviewHistoryView() {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path)
  const showInterviewHistory = useStorySimulationStore((s) => s.showInterviewHistory)
  const savedInterviews = useStorySimulationStore((s) => s.savedInterviews)
  const viewingInterview = useStorySimulationStore((s) => s.viewingInterview)
  const setShowInterviewHistory = useStorySimulationStore((s) => s.setShowInterviewHistory)
  const setSavedInterviews = useStorySimulationStore((s) => s.setSavedInterviews)
  const setViewingInterview = useStorySimulationStore((s) => s.setViewingInterview)
  const setError = useStorySimulationStore((s) => s.setError)
  const setInfoMessage = useStorySimulationStore((s) => s.setInfoMessage)
  const setContinuingInterviewId = useStorySimulationStore((s) => s.setContinuingInterviewId)
  const setActiveChatAgent = useStorySimulationStore((s) => s.setActiveChatAgent)
  const setAgentChatMessages = useStorySimulationStore((s) => s.setAgentChatMessages)

  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)

  // 加载采访列表
  useEffect(() => {
    if (!showInterviewHistory || !projectPath) return
    let cancelled = false
    setLoading(true)
    loadInterviews(projectPath)
      .then((interviews) => {
        if (!cancelled) {
          setSavedInterviews(interviews)
        }
      })
      .catch((err) => {
        console.error("加载采访历史失败:", err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [showInterviewHistory, projectPath, setSavedInterviews])

  const handleClose = () => {
    setShowInterviewHistory(false)
    setViewingInterview(null)
  }

  const handleDelete = async (interview: SavedInterview) => {
    if (!projectPath) return
    if (!confirm(t("storySimulation.deleteInterviewConfirm", { name: interview.agentName }))) {
      return
    }
    setDeleting(interview.id)
    try {
      await deleteInterview(projectPath, interview.id)
      const updated = savedInterviews.filter((i) => i.id !== interview.id)
      setSavedInterviews(updated)
      if (viewingInterview?.id === interview.id) {
        setViewingInterview(null)
      }
      setInfoMessage(t("storySimulation.interviewDeleted"))
      setTimeout(() => setInfoMessage(null), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("storySimulation.deleteFailed"))
      setTimeout(() => setError(null), 3000)
    } finally {
      setDeleting(null)
    }
  }

  const handleExport = async (interview: SavedInterview) => {
    if (!projectPath) return
    setExporting(interview.id)
    try {
      const filePath = await exportInterview(projectPath, interview)
      setInfoMessage(t("storySimulation.interviewExported", { path: filePath }))
      setTimeout(() => setInfoMessage(null), 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("storySimulation.exportFailed"))
      setTimeout(() => setError(null), 3000)
    } finally {
      setExporting(null)
    }
  }

  const handleContinueInterview = async (interview: SavedInterview) => {
    if (!projectPath) return
    setResuming(true)
    try {
      let agents: NovelAgent[] = []

      // 优先从采访记录的 agentSnapshot 恢复
      if (interview.agentSnapshot) {
        const { agents: deserializedAgents } = deserializeSimulationSnapshot(interview.agentSnapshot)
        agents = deserializedAgents
      }

      // 若采访记录无快照，尝试从对应 frameworkId 的推演结果恢复
      if (agents.length === 0 && interview.frameworkId) {
        const results = await loadSimulationResults(projectPath, interview.frameworkId)
        for (const r of results) {
          if (r.agentSnapshot) {
            const { agents: deserializedAgents } = deserializeSimulationSnapshot(r.agentSnapshot)
            if (deserializedAgents.some((a) => a.name === interview.agentName)) {
              agents = deserializedAgents
              break
            }
          }
        }
      }

      if (agents.length === 0) {
        setError(t("storySimulation.cannotRestoreReadonly"))
        setTimeout(() => setError(null), 3000)
        return
      }

      // 找到对应角色的 agent
      const targetAgent = agents.find((a) => a.name === interview.agentName)
      if (!targetAgent) {
        setError(t("storySimulation.agentDataNotFound", { name: interview.agentName }))
        setTimeout(() => setError(null), 3000)
        return
      }

      // 加载旧对话消息到 store
      setAgentChatMessages(interview.session.messages)
      setActiveChatAgent({ id: targetAgent.characterId, name: targetAgent.name })
      setContinuingInterviewId(interview.id)
      setShowInterviewHistory(false)
      setViewingInterview(null)
      setInfoMessage(t("storySimulation.interviewResumed"))
      setTimeout(() => setInfoMessage(null), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("storySimulation.restoreFailed"))
      setTimeout(() => setError(null), 3000)
    } finally {
      setResuming(false)
    }
  }

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr)
      return date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    } catch {
      return dateStr
    }
  }

  const getMessageCount = (interview: SavedInterview) => {
    return interview.session.messages.length
  }

  const getPreview = (interview: SavedInterview) => {
    const messages = interview.session.messages
    if (messages.length === 0) return t("storySimulation.emptyConversation")
    const lastMsg = messages[messages.length - 1]
    return lastMsg.content.slice(0, 50) + (lastMsg.content.length > 50 ? "..." : "")
  }

  if (!showInterviewHistory) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-background shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">
              {viewingInterview
                ? t("storySimulation.chatViewTitle", { name: viewingInterview.agentName })
                : t("storySimulation.interviewHistory")}
            </h2>
          </div>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 内容区 */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {viewingInterview ? (
            // 对话详情视图
            <div className="flex flex-1 flex-col">
              {/* 返回按钮和信息栏 */}
              <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
                <button
                  type="button"
                  className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  onClick={() => setViewingInterview(null)}
                >
                  <ChevronRight className="h-4 w-4 rotate-180" />
                  {t("storySimulation.backToList")}
                </button>
                <div className="flex items-center gap-2">
                  {viewingInterview.frameworkTitle && (
                    <span className="text-xs text-muted-foreground">
                      {t("storySimulation.frameworkPrefix", { title: viewingInterview.frameworkTitle })}
                    </span>
                  )}
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => handleContinueInterview(viewingInterview)}
                    disabled={resuming}
                  >
                    {resuming ? t("storySimulation.resuming") : t("storySimulation.continueChat")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport(viewingInterview)}
                    disabled={exporting === viewingInterview.id}
                  >
                    <Download className="mr-1 h-3.5 w-3.5" />
                    {exporting === viewingInterview.id ? t("storySimulation.exporting") : t("storySimulation.export")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(viewingInterview)}
                    disabled={deleting === viewingInterview.id}
                    className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    {deleting === viewingInterview.id ? t("storySimulation.deleting") : t("storySimulation.delete")}
                  </Button>
                </div>
              </div>

              {/* 对话消息 */}
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="mx-auto max-w-2xl space-y-4">
                  {viewingInterview.session.messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                          msg.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted"
                        }`}
                      >
                        <div className="mb-1 flex items-center gap-1.5 text-xs opacity-70">
                          <User className="h-3 w-3" />
                          {msg.role === "user" ? t("storySimulation.you") : viewingInterview.agentName}
                        </div>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
                      </div>
                    </div>
                  ))}
                  {viewingInterview.session.messages.length === 0 && (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                      {t("storySimulation.noMessages")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            // 列表视图
            <div className="flex w-full flex-col">
              {loading ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  {t("storySimulation.loading")}
                </div>
              ) : savedInterviews.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <MessageCircle className="h-12 w-12 opacity-20" />
                  <p className="text-sm">{t("storySimulation.noInterviews")}</p>
                  <p className="text-xs">{t("storySimulation.noInterviewsHint")}</p>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <div className="space-y-2">
                    {savedInterviews.map((interview) => (
                      <div
                        key={interview.id}
                        className="group rounded-lg border p-3 transition-colors hover:border-primary/50 hover:bg-accent/30"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <button
                            type="button"
                            className="flex-1 text-left"
                            onClick={() => setViewingInterview(interview)}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{interview.agentName}</span>
                              {interview.frameworkTitle && (
                                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                  {interview.frameworkTitle}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground line-clamp-1">
                              {getPreview(interview)}
                            </p>
                            <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {formatDate(interview.updatedAt)}
                              </span>
                              <span>{t("storySimulation.messageCount", { count: getMessageCount(interview) })}</span>
                            </div>
                          </button>
                          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleExport(interview)
                              }}
                              disabled={exporting === interview.id}
                              title={t("storySimulation.export")}
                            >
                              <Download className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDelete(interview)
                              }}
                              disabled={deleting === interview.id}
                              title={t("storySimulation.delete")}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
