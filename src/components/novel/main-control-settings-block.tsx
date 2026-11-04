// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 主控运行设置块（G1）：把最常调的 5 项 novelConfig + 全局工作流强度搬到操作现场。
 *
 * 纪律：
 * - novelConfig 写入一律经 persistNovelConfigPatch（逐键回滚唯一实现），patch 只放本次改动的一个键；
 * - aiWorkflowMode 是全局单键（D1=A），走 saveAiWorkflowMode 落盘成功后再更新 store；
 * - preWriteGateMode 旁必须显示生效位置说明（D3=A）：生效于正式库写入，主控草稿阶段不拦；
 * - writingModel 是死字段（D2=C）：只显示「已移除」说明，不提供可编辑控件。
 */

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import type { NovelConfig } from "@/stores/wiki-store"
import { saveAiWorkflowMode } from "@/lib/project-store"
import { clampChapterTargetChars, persistNovelConfigPatch, projectMainControlSettings } from "@/lib/novel"
import type { MainControlPreWriteGateMode } from "@/lib/novel"
import type { AiWorkflowMode } from "@/lib/agent/workflow-mode"
import { ChatModelSelector } from "@/components/chat/chat-model-selector"
import { toErrorMessage } from "@/lib/utils"
import { toast } from "@/lib/toast"

const WORKFLOW_MODES: ReadonlyArray<{ mode: AiWorkflowMode; labelKey: string }> = [
  { mode: "fast", labelKey: "mainControl.workflowModeFast" },
  { mode: "standard", labelKey: "mainControl.workflowModeStandard" },
  { mode: "strict", labelKey: "mainControl.workflowModeStrict" },
]

const GATE_MODES: ReadonlyArray<{ mode: MainControlPreWriteGateMode; labelKey: string }> = [
  { mode: "warn", labelKey: "mainControl.settingsPreWriteGateWarn" },
  { mode: "block", labelKey: "mainControl.settingsPreWriteGateBlock" },
]

function choiceClass(active: boolean): string {
  return `min-h-6 rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
    active ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent"
  }`
}

export function MainControlSettingsBlock() {
  const { t } = useTranslation()
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const aiWorkflowMode = useWikiStore((s) => s.aiWorkflowMode)
  const aiChatModel = useWikiStore((s) => s.aiChatModel)
  const project = useWikiStore((s) => s.project)
  // 数字输入框本地草稿（失焦/回车才提交，避免每敲一位就落盘）
  const [chapterTargetDraft, setChapterTargetDraft] = useState<string | null>(null)
  const view = projectMainControlSettings(novelConfig, aiWorkflowMode)

  const writeNovelConfig = async (patch: Partial<NovelConfig>) => {
    try {
      await persistNovelConfigPatch({
        patch,
        prev: useWikiStore.getState().novelConfig,
        projectId: project?.id,
        projectPath: project?.path,
        apply: useWikiStore.getState().setNovelConfig,
      })
    } catch (err) {
      toast.error(t("mainControl.settingsSaveFailed", { message: toErrorMessage(err) }))
    }
  }

  const writeAiWorkflowMode = async (mode: AiWorkflowMode) => {
    try {
      await saveAiWorkflowMode(mode)
      useWikiStore.getState().setAiWorkflowMode(mode)
    } catch (err) {
      toast.error(t("mainControl.settingsSaveFailed", { message: toErrorMessage(err) }))
    }
  }

  return (
    <div className="rounded-lg border p-2" data-testid="main-control-settings">
      <h3 className="mb-1 text-xs font-semibold">{t("mainControl.settingsTitle")}</h3>
      <p className="mb-2 text-xs text-muted-foreground">{t("mainControl.settingsHint")}</p>

      <div className="flex flex-col gap-2">
        {/* 目标字数 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">{t("mainControl.settingsChapterTargetChars")}</span>
          <input
            type="number"
            min={500}
            max={20000}
            step={100}
            data-testid="main-control-settings-chapter-target"
            value={chapterTargetDraft ?? String(view.chapterTargetChars)}
            onChange={(e) => setChapterTargetDraft(e.target.value)}
            onBlur={() => {
              if (chapterTargetDraft === null) return
              const parsed = Number(chapterTargetDraft)
              setChapterTargetDraft(null)
              void writeNovelConfig({ chapterTargetChars: clampChapterTargetChars(parsed) })
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur()
            }}
            className="h-7 w-24 rounded-md border bg-transparent px-2 text-xs"
          />
        </div>

        {/* 写前门控（D3=A：注明生效位置） */}
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium">{t("mainControl.settingsPreWriteGateMode")}</span>
            <div role="group" className="flex flex-wrap gap-1.5">
              {GATE_MODES.map(({ mode, labelKey }) => (
                <button
                  key={mode}
                  type="button"
                  data-testid={`main-control-settings-gate-${mode}`}
                  aria-pressed={view.preWriteGateMode === mode}
                  onClick={() => void writeNovelConfig({ preWriteGateMode: mode })}
                  className={choiceClass(view.preWriteGateMode === mode)}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("mainControl.settingsPreWriteGateModeHint")}</p>
        </div>

        {/* 场景切分 / 门后文学打磨 */}
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            data-testid="main-control-settings-scene-breakdown"
            checked={view.sceneBreakdownEnabled}
            onChange={(e) => void writeNovelConfig({ sceneBreakdownEnabled: e.target.checked })}
            className="h-4 w-4"
          />
          <span>{t("mainControl.settingsSceneBreakdown")}</span>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            data-testid="main-control-settings-literary-polish"
            checked={view.literaryPolishAfterGate}
            onChange={(e) => void writeNovelConfig({ literaryPolishAfterGate: e.target.checked })}
            className="h-4 w-4"
          />
          <span>{t("mainControl.settingsLiteraryPolish")}</span>
        </label>

        {/* 审查模型（空串=跟随会话模型） */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">{t("mainControl.settingsReviewModel")}</span>
          <label className="flex min-h-6 cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              data-testid="main-control-settings-review-follow"
              checked={view.reviewModel === ""}
              onChange={(e) =>
                void writeNovelConfig({ reviewModel: e.target.checked ? "" : aiChatModel || " " })
              }
              className="h-4 w-4"
            />
            <span>{t("mainControl.settingsFollowChatModel")}</span>
          </label>
          <ChatModelSelector
            value={view.reviewModel}
            onChange={(model) => void writeNovelConfig({ reviewModel: model })}
            disabled={view.reviewModel === ""}
          />
        </div>

        {/* 工作流强度（全局单键，D1=A） */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">{t("mainControl.settingsAiWorkflowMode")}</span>
          <div role="group" className="flex flex-wrap gap-1.5">
            {WORKFLOW_MODES.map(({ mode, labelKey }) => (
              <button
                key={mode}
                type="button"
                data-testid={`main-control-ai-workflow-mode-${mode}`}
                aria-pressed={view.aiWorkflowMode === mode}
                onClick={() => void writeAiWorkflowMode(mode)}
                className={choiceClass(view.aiWorkflowMode === mode)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("mainControl.settingsAiWorkflowModeHint")}</p>

        {/* D2=C：写作模型已移除（只读说明，无可编辑控件） */}
        <p className="text-xs text-muted-foreground">{t("mainControl.settingsWritingModelRemoved")}</p>
      </div>
    </div>
  )
}
