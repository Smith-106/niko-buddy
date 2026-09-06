import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Play, RotateCcw, Save, Share2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import {
  createPlayState,
  replayPlay,
  renderPlayFrame,
  stepPlay,
  type PlayState,
} from "@/lib/novel/play-runtime"
import type { InteractiveStoryGraph } from "@/lib/novel/interactive-film-graph"
import { evaluatePlayableEmotionPath } from "@/lib/novel/emotion-ledger"
import { loadInteractiveGraph, loadPlaySession, savePlaySession } from "@/lib/novel/interactive-io"
import { exportInteractiveStory } from "@/lib/novel/export"
import { saveGenerationHistoryEntry } from "@/lib/novel/generation-history"
import { normalizePath } from "@/lib/path-utils"

/**
 * PlayRuntimePanel — 互动影游 Play 面板（65 号共识 G2 挂载：形态轴 F1/F2 消费侧）。
 *
 * 边界：零 LLM（纯状态机）；图源 = `.novel/interactive-graph.json`（additive IO，
 * 缺失时示例图降级演示）；崩溃续玩 = `replayPlay` 按 `play-session.json` 重放；
 * 导出成功/结束时记 `snapshot-film` run（M3 生产接线）；Draft-first：会话快照
 * 仅落 `.novel/` pending 区。
 */
const DEMO_GRAPH: InteractiveStoryGraph = {
  version: 1,
  startId: "demo-start",
  nodes: [
    { id: "demo-start", kind: "knot", title: "开场", text: "示例开场：你站在故事岔路口。" },
    { id: "demo-a", kind: "choice", title: "光亮小径", text: "你选择了光亮的小径。" },
    { id: "demo-b", kind: "choice", title: "幽暗密林", text: "你选择了幽暗的密林。" },
    { id: "demo-end", kind: "end", title: "终章", text: "旅途告一段落（示例图演示）。" },
  ],
  edges: [
    { from: "demo-start", to: "demo-a", choiceLabel: "走光亮的小径" },
    { from: "demo-start", to: "demo-b", choiceLabel: "走幽暗的密林" },
    { from: "demo-a", to: "demo-end", choiceLabel: "继续" },
    { from: "demo-b", to: "demo-end", choiceLabel: "继续" },
  ],
}

export function PlayRuntimePanel() {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path)
  const [graph, setGraph] = useState<InteractiveStoryGraph | null>(null)
  const [graphSource, setGraphSource] = useState<"project" | "demo" | "none">("none")
  const [state, setState] = useState<PlayState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 图装载：项目图优先，缺失时示例图降级（优雅降级，按钮始终可用）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!projectPath) {
        setGraph(DEMO_GRAPH)
        setGraphSource("demo")
        setState(createPlayState(DEMO_GRAPH))
        return
      }
      const loaded = await loadInteractiveGraph(projectPath)
      if (cancelled) return
      if (loaded) {
        setGraph(loaded)
        setGraphSource("project")
        setState(createPlayState(loaded))
      } else {
        setGraph(DEMO_GRAPH)
        setGraphSource("demo")
        setState(createPlayState(DEMO_GRAPH))
        setNotice(t("novel.play.demoHint") ?? "未找到 .novel/interactive-graph.json，使用示例图演示")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath, t])

  const frame = useMemo(() => (graph && state ? renderPlayFrame(graph, state) : null), [graph, state])

  const choose = useCallback(
    (edgeIndex: number) => {
      if (!graph || !state) return
      const next = stepPlay(graph, state, edgeIndex)
      if (next) setState(next)
    },
    [graph, state],
  )

  const restart = useCallback(() => {
    if (!graph) return
    setState(createPlayState(graph))
    setNotice(null)
  }, [graph])

  // 崩溃续玩：尝试从 play-session.json 恢复
  const resume = useCallback(async () => {
    if (!graph || !projectPath) return
    const choicePath = await loadPlaySession(projectPath)
    if (!choicePath || choicePath.length === 0) {
      setNotice(t("novel.play.noSession") ?? "无续玩会话")
      return
    }
    const replayed = replayPlay(graph, choicePath)
    if (replayed) {
      setState(replayed)
      setNotice(t("novel.play.resumed") ?? `已续玩（${choicePath.length} 步）`)
    } else {
      setNotice(t("novel.play.replayFailed") ?? "续玩路径失效，已回到开头")
      setState(createPlayState(graph))
    }
  }, [graph, projectPath, t])

  // Draft-first：会话快照仅落 .novel/ pending 区（M3 不在此写正式层）
  const saveSession = useCallback(async () => {
    if (!state || !projectPath) return
    await savePlaySession(projectPath, state.choicePath)
    setNotice(t("novel.play.sessionSaved") ?? "会话已保存（.novel/play-session.json）")
  }, [state, projectPath, t])

  // 导出 + M3 snapshot-film run 记录
  const exportStory = useCallback(async () => {
    if (!graph || !projectPath) return
    const exportPath = `${normalizePath(projectPath)}/.novel/play-graph`
    const result = await exportInteractiveStory({ projectPath, exportPath, graph })
    if (result.success) {
      await saveGenerationHistoryEntry(normalizePath(projectPath), {
        kind: "snapshot-film",
        title: "interactive-play-export",
        results: [],
        snapshotMeta: { shape: "film", artifactRef: `${exportPath}/interactive.html`, summary: `${graph.nodes.length} nodes` },
      })
      setNotice(t("novel.play.exported") ?? `已导出 ${result.exportedPath}`)
    } else {
      setNotice(result.message)
    }
  }, [graph, projectPath, t])

  const emotionPath = useMemo(() => {
    if (!graph || !state || !state.choicePath.length) return null
    // choicePath 上每个节点的 emotionTag → PlayableEmotionSample（未知标签三轴 0）
    const samples = state.choicePath
      .map((nodeId) => graph.nodes.find((n) => n.id === nodeId))
      .filter((n): n is NonNullable<typeof n> => Boolean(n))
      .map((n) => ({ nodeId: n.id, tag: n.emotionTag ?? "" }))
    if (samples.length === 0) return null
    return evaluatePlayableEmotionPath(samples)
  }, [graph, state])

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4 play-runtime-panel" data-testid="play-runtime-panel">
      <div className="flex items-center gap-2 text-sm font-semibold">
          <Play className="h-4 w-4" />
          {t("novel.play.title")}
          <span className="text-xs font-normal text-muted-foreground">
            {graphSource === "project" ? t("novel.play.sourceProject") : graphSource === "demo" ? t("novel.play.sourceDemo") : ""}
          </span>
        </div>
      <div className="space-y-3 pt-2">
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
        {frame ? (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-sm">{frame.text}</p>
            {!frame.ended && frame.choices.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {frame.choices.map((c) => (
                  <Button key={c.edgeIndex} size="sm" variant="outline" onClick={() => choose(c.edgeIndex)}>
                    {c.label}
                  </Button>
                ))}
              </div>
            )}
            {frame.ended && (
              <p className="text-xs text-muted-foreground">{t("novel.play.ended") ?? "—— 终局 ——"}</p>
            )}
            {emotionPath && (
              <p className="text-xs text-muted-foreground">
                {t("novel.play.emotionPath")}: {emotionPath.path.join(" → ")}（净 {emotionPath.netValue.toFixed(1)}，
                {emotionPath.circuit === "suspend" ? t("novel.play.suspended") : t("novel.play.ok")}）
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("novel.play.empty") ?? "无图可玩"}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={restart}>
            <RotateCcw className="mr-1 h-3 w-3" />
            {t("novel.play.restart")}
          </Button>
          <Button size="sm" variant="outline" onClick={resume} disabled={!projectPath}>
            <Play className="mr-1 h-3 w-3" />
            {t("novel.play.resume")}
          </Button>
          <Button size="sm" variant="outline" onClick={saveSession} disabled={!state || !projectPath}>
            <Save className="mr-1 h-3 w-3" />
            {t("novel.play.saveSession")}
          </Button>
          <Button size="sm" variant="outline" onClick={exportStory} disabled={!projectPath}>
            <Share2 className="mr-1 h-3 w-3" />
            {t("novel.play.export")}
          </Button>
        </div>
      </div>
    </div>
  )
}
