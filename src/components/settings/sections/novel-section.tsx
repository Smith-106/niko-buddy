// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useWikiStore } from "@/stores/wiki-store"
import { saveNovelConfig } from "@/lib/project-store"

import { testNovelModel, applyAntiAiTelemetryConsentOnProjectOpen, loadAntiAiTelemetryConsent, saveAntiAiTelemetryConsent, goldenCoverageOf, goldenKbShadowCases, runKbShadowArmsIfConsented } from "@/lib/novel"
import type { TestableNovelModelTask } from "@/lib/novel"
import { ChatModelSelector } from "@/components/chat/chat-model-selector"
import { WritingPreferenceSection } from "./writing-preference-section"
import { NovelBaseSettingsSection } from "./novel-base-settings-section"
import { NovelSettingTooltip, NovelSwitchRow } from "./novel-section-panels"
import { NOVEL_GROUP_HEADING_CLASS } from "./novel-section-style"
import { CommitNumberInput } from "../settings-widgets"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import type { NovelConfig } from "@/stores/wiki-store"
import { TASK_PROMPT_KEYS } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"
import { toast } from "@/lib/toast"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function NovelSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const setNovelConfigStore = useWikiStore((s) => s.setNovelConfig)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const aiChatModel = useWikiStore((s) => s.aiChatModel)
  const project = useWikiStore((s) => s.project)
  const [testStates, setTestStates] = useState<Record<TestableNovelModelTask, {
    loading: boolean
    message: string
    success: boolean
  } | undefined>>({
    writing: undefined,
    review: undefined,
    summary: undefined,
    extract: undefined,
  })

  const ids = useId()
  // 最新草稿：落盘失败回滚时以它为底，只撤销本次 patch 的键
  const latestNovelConfigRef = useRef(draft.novelConfig)
  useEffect(() => {
    latestNovelConfigRef.current = draft.novelConfig
  }, [draft.novelConfig])
  const updateNovelConfig = async (patch: Partial<NovelConfig>) => {
    const prevConfig = draft.novelConfig
    const newConfig = { ...prevConfig, ...patch }
    setDraft("novelConfig", newConfig)
    setNovelConfigStore(patch)
    try {
      await saveNovelConfig(newConfig, project?.id, project?.path)
    } catch (err) {
      // 落盘失败：只回滚本次 patch 的键（draft 与 store 一致），
      // 期间其它项的改动（可能已落盘）不被冲掉
      const rollback: Partial<NovelConfig> = {}
      for (const key of Object.keys(patch) as (keyof NovelConfig)[]) {
        ;(rollback as Record<string, unknown>)[key] = prevConfig[key]
      }
      setDraft("novelConfig", { ...latestNovelConfigRef.current, ...rollback })
      setNovelConfigStore(rollback)
      toast.error(toErrorMessage(err))
    }
  }

  // F-34: 反 AI 遥测同意（app 级 store，不走 draft.novelConfig；null = 加载中）
  const [antiAiTelemetryConsent, setAntiAiTelemetryConsent] = useState<boolean | null>(null)
  const [consentError, setConsentError] = useState<string | null>(null)
  const [kbShadowRun, setKbShadowRun] = useState<{
    running: boolean
    written: number | null
    failed: number
    skipped: boolean
    error: string | null
  }>({ running: false, written: null, failed: 0, skipped: false, error: null })

  useEffect(() => {
    let cancelled = false
    loadAntiAiTelemetryConsent()
      .then((v) => { if (!cancelled) setAntiAiTelemetryConsent(v) })
      .catch(() => { if (!cancelled) setAntiAiTelemetryConsent(false) })
    return () => { cancelled = true }
  }, [])

  const toggleAntiAiTelemetryConsent = async () => {
    const next = !(antiAiTelemetryConsent === true)
    const prev = antiAiTelemetryConsent
    setAntiAiTelemetryConsent(next)
    setConsentError(null)
    try {
      await saveAntiAiTelemetryConsent(next)
    } catch (error) {
      setAntiAiTelemetryConsent(prev)
      setConsentError(toErrorMessage(error))
      return
    }
    try {
      if (project?.path) {
        await applyAntiAiTelemetryConsentOnProjectOpen(project.path)
      }
    } catch (error) {
      // store 已写入 next，UI 保持 next；sink 半态由下次项目打开自愈
      setConsentError(toErrorMessage(error))
    }
  }

  const runKbShadowCollection = async () => {
    const projectPath = project?.path
    if (!projectPath) {
      setKbShadowRun({ running: false, written: null, failed: 0, skipped: false, error: t("novel.settings.kbShadowNoProject") })
      return
    }
    setKbShadowRun({ running: true, written: null, failed: 0, skipped: false, error: null })
    try {
      const result = await runKbShadowArmsIfConsented(
        projectPath,
        "golden34",
        goldenKbShadowCases(),
        undefined,
        undefined,
        goldenCoverageOf,
      )
      setKbShadowRun({
        running: false,
        written: result.written,
        failed: result.failed,
        skipped: result.skipped,
        error: null,
      })
    } catch (error) {
      setKbShadowRun({
        running: false,
        written: null,
        failed: 0,
        skipped: false,
        error: toErrorMessage(error),
      })
    }
  }

  const consensusDimensionKeys = ["thrill", "consistency", "pacing", "character", "continuity", "pull"] as const

  const modelItems = useMemo(() => ([
    { task: "review", field: "reviewModel", wrapperClassName: "space-y-2" },
    { task: "summary", field: "summaryModel", wrapperClassName: "space-y-2" },
    {
      task: "extract",
      field: "extractModel",
      wrapperClassName: "space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3",
    },
  ] as const), [])

  const settingTooltip = (key: string) => <NovelSettingTooltip tipKey={key} />

  const runModelTest = async (task: TestableNovelModelTask) => {
    setTestStates((prev) => ({
      ...prev,
      [task]: {
        loading: true,
        message: t("novel.settings.testingModel"),
        success: false,
      },
    }))

    try {
      const result = await testNovelModel(llmConfig, draft.novelConfig, task)
      const suffix = result.usedFallbackModel
        ? t("novel.settings.testUsingDefaultMainModel", { model: result.model })
        : t("novel.settings.testUsingCurrentModel", { model: result.model })
      setTestStates((prev) => ({
        ...prev,
        [task]: {
          loading: false,
          message: `${t("novel.settings.testSuccess")} ${suffix}`,
          success: true,
        },
      }))
    } catch (error) {
      setTestStates((prev) => ({
        ...prev,
        [task]: {
          loading: false,
          message: t("novel.settings.testFailed", {
            message: toErrorMessage(error),
          }),
          success: false,
        },
      }))
    }
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.novel.title", { defaultValue: "小说设置" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.novel.description", {
            defaultValue:
              "项目级写作模式和小说工作流修改反馈窗口控制。",
          })}
        </p>
      </div>

      <div className="space-y-2">
        <h3 className={NOVEL_GROUP_HEADING_CLASS}>{t("novel.settings.title")}</h3>
        <div className="grid gap-4 rounded-lg border p-4">
          <NovelBaseSettingsSection draft={draft} setDraft={setDraft} updateNovelConfig={updateNovelConfig} />

          {modelItems.map((item) => {
            const state = testStates[item.task]
            const modelValue = draft.novelConfig[item.field] || ""
            const isFollowingChat = !modelValue
            const displayValue = isFollowingChat ? "" : modelValue

            const modelLabelId = `${ids}-${item.field}`
            return (
              <div
                key={item.task}
                role="group"
                aria-labelledby={modelLabelId}
                className={item.wrapperClassName}
              >
                <div className="flex items-center gap-1.5">
                  <span id={modelLabelId} className="text-sm leading-none font-medium">
                    {t(`novel.settings.${item.field}`)}
                  </span>
                  {settingTooltip(`${item.field}Hint`)}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2">
                    <label className="flex min-h-6 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isFollowingChat}
                        onChange={(e) => {
                          if (e.target.checked) {
                            updateNovelConfig({
                              [item.field]: "",
                            } as Partial<NovelConfig>)
                          } else {
                        updateNovelConfig({
                          [item.field]: aiChatModel || " ",
                        } as Partial<NovelConfig>)
                      }
                        }}
                        className="h-4 w-4"
                      />
                      <span className="text-sm">
                        {t("novel.settings.followChatModel")}
                      </span>
                    </label>
                    <ChatModelSelector
                      value={displayValue}
                      onChange={(model) => updateNovelConfig({
                        [item.field]: model,
                      } as Partial<NovelConfig>)}
                      disabled={isFollowingChat}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={state?.loading}
                    onClick={() => runModelTest(item.task)}
                  >
                    {state?.loading ? t("novel.settings.testingModel") : t("novel.settings.testModel")}
                  </Button>
                </div>
                {item.task === "extract" ? (
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("novel.settings.extractModelHint")}
                  </p>
                ) : null}
                {state?.message ? (
                  <p className={`text-xs ${state.success ? "text-success-foreground" : "text-destructive"}`}>
                    {state.message}
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      {/* 多模型共识（consensus feature）：关闭时零行为变更 */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-1.5">
          <h3 className={NOVEL_GROUP_HEADING_CLASS}>{t("novel.settings.consensusTitle")}</h3>
          {settingTooltip("consensusHelp")}
        </div>
        <label className="flex min-h-6 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={draft.novelConfig.consensusEnabled}
            onChange={(e) => updateNovelConfig({ consensusEnabled: e.target.checked })}
          />
          <span className="text-sm">{t("novel.settings.consensusEnabled")}</span>
        </label>
        {draft.novelConfig.consensusEnabled ? (
          <>
            <div className="space-y-2">
              <Label htmlFor={`${ids}-consensus-writing`} className="text-sm">{t("novel.settings.consensusWritingModels")}</Label>
              <input
                id={`${ids}-consensus-writing`}
                type="text"
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
                placeholder="providerId/modelId, providerId/modelId"
                value={draft.novelConfig.consensusWritingModels.join(", ")}
                onChange={(e) =>
                  updateNovelConfig({
                    consensusWritingModels: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                  })
                }
              />
              <p className="text-xs leading-5 text-muted-foreground">{t("novel.settings.consensusWritingModelsHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${ids}-consensus-rounds`} className="text-sm">{t("novel.settings.consensusDebateRounds")}</Label>
              <CommitNumberInput
                id={`${ids}-consensus-rounds`}
                min={1}
                max={5}
                value={draft.novelConfig.consensusDebateRounds}
                onCommit={(n) => updateNovelConfig({ consensusDebateRounds: n })}
                className="w-24"
              />
            </div>
            <div role="group" aria-labelledby={`${ids}-consensus-review`} className="space-y-2">
              <span id={`${ids}-consensus-review`} className="block text-sm leading-none font-medium">
                {t("novel.settings.consensusReviewModels")}
              </span>
              {consensusDimensionKeys.map((key) => (
                <div key={key} className="flex items-center gap-2">
                  <Label
                    htmlFor={`${ids}-consensus-review-${key}`}
                    className="w-16 shrink-0 truncate text-xs font-normal text-muted-foreground"
                    title={t(`reviewCenter.dimension.${key}`)}
                  >
                    {t(`reviewCenter.dimension.${key}`)}
                  </Label>
                  <input
                    id={`${ids}-consensus-review-${key}`}
                    type="text"
                    className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
                    placeholder="providerId/modelId, ..."
                    value={(draft.novelConfig.consensusReviewModels[key] ?? []).join(", ")}
                    onChange={(e) =>
                      updateNovelConfig({
                        consensusReviewModels: {
                          ...draft.novelConfig.consensusReviewModels,
                          [key]: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                        },
                      })
                    }
                  />
                </div>
              ))}
              <p className="text-xs leading-5 text-muted-foreground">{t("novel.settings.consensusReviewModelsHint")}</p>
            </div>
          </>
        ) : null}
      </div>

      {/* 任务提示词与技能（task customization）：默认空=行为与现状一致 */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-1.5">
          <h3 className={NOVEL_GROUP_HEADING_CLASS}>{t("novel.settings.taskCustomTitle")}</h3>
          {settingTooltip("taskCustomHelp")}
        </div>
        {TASK_PROMPT_KEYS.map((key) => (
          <div key={key} className="space-y-1.5 rounded-md border p-3">
            <Label htmlFor={`${ids}-task-skill-${key}`} className="text-sm">
              {t(`novel.settings.taskCustom_${key}`)}
            </Label>
            <input
              id={`${ids}-task-skill-${key}`}
              type="text"
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              placeholder={t("novel.settings.taskCustomSkillPlaceholder")}
              value={(draft.novelConfig.taskSkillNames?.[key] ?? []).join(", ")}
              onChange={(e) =>
                updateNovelConfig({
                  taskSkillNames: {
                    ...draft.novelConfig.taskSkillNames,
                    [key]: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                  },
                })
              }
            />
            <textarea
              rows={2}
              aria-label={t("novel.settings.taskCustomPromptAria", {
                task: t(`novel.settings.taskCustom_${key}`),
                defaultValue: "{{task}} 附加提示词",
              })}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              placeholder={t("novel.settings.taskCustomPromptPlaceholder")}
              value={draft.novelConfig.taskPrompts?.[key]?.extra ?? ""}
              onChange={(e) =>
                updateNovelConfig({
                  taskPrompts: {
                    ...draft.novelConfig.taskPrompts,
                    [key]: { extra: e.target.value },
                  },
                })
              }
            />
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <h3 className={NOVEL_GROUP_HEADING_CLASS}>
          {t("settings.sections.novel.feedbackWindow.title", {
            defaultValue: "修改反馈窗口",
          })}
        </h3>
        <div className="grid gap-4 rounded-lg border p-4">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`${ids}-lookback`}>
                {t("settings.sections.novel.feedbackWindow.lookbackChapterCount", {
                  defaultValue: "回溯章节数量",
                })}
              </Label>
              {settingTooltip("feedbackWindowLookbackChapterCountHelp")}
            </div>
            <CommitNumberInput
              id={`${ids}-lookback`}
              min={0}
              max={Number.MAX_SAFE_INTEGER}
              value={draft.revisionFeedbackWindowConfig.lookbackChapterCount}
              describedBy={`${ids}-lookback-hint`}
              onCommit={(n) => setDraft("revisionFeedbackWindowConfig", {
                ...draft.revisionFeedbackWindowConfig,
                lookbackChapterCount: n,
              })}
              className="w-24"
            />
            <p id={`${ids}-lookback-hint`} className="text-xs text-muted-foreground">
              {t("settings.sections.novel.feedbackWindow.lookbackChapterCountHint", {
                defaultValue:
                  "将多少章前序章节折叠回当前写作上下文。",
              })}
            </p>
          </div>

          <NovelSwitchRow
            label={t("settings.sections.novel.feedbackWindow.currentChapterIncludeShouldImprove", { defaultValue: "包含当前章节改进建议" })}
            tipKey="feedbackWindowCurrentChapterIncludeShouldImproveHelp"
            hint={t("settings.sections.novel.feedbackWindow.currentChapterIncludeShouldImproveHint", {
              defaultValue: "关闭后，当前章节仅贡献必须修复项和延续指示。",
            })}
            checked={draft.revisionFeedbackWindowConfig.currentChapterIncludeShouldImprove}
            onChange={() => setDraft("revisionFeedbackWindowConfig", {
              ...draft.revisionFeedbackWindowConfig,
              currentChapterIncludeShouldImprove: !draft.revisionFeedbackWindowConfig.currentChapterIncludeShouldImprove,
            })}
          />

          <NovelSwitchRow
            label={t("settings.sections.novel.feedbackWindow.previousChapterCarryEnabled", { defaultValue: "读取上一章延续事项" })}
            tipKey="feedbackWindowPreviousChapterCarryEnabledHelp"
            hint={t("settings.sections.novel.feedbackWindow.previousChapterCarryEnabledHint", {
              defaultValue: "关闭后，上一章的延续事项不会注入当前上下文。",
            })}
            checked={draft.revisionFeedbackWindowConfig.previousChapterCarryEnabled}
            onChange={() => setDraft("revisionFeedbackWindowConfig", {
              ...draft.revisionFeedbackWindowConfig,
              previousChapterCarryEnabled: !draft.revisionFeedbackWindowConfig.previousChapterCarryEnabled,
            })}
          />

          <NovelSwitchRow
            label={t("settings.sections.novel.feedbackWindow.lookbackIncludeMustFixOnly", { defaultValue: "回溯章节仅保留必须修复项" })}
            tipKey="feedbackWindowLookbackIncludeMustFixOnlyHelp"
            hint={t("settings.sections.novel.feedbackWindow.lookbackIncludeMustFixOnlyHint", {
              defaultValue: "关闭后，回溯章节也贡献改进建议。",
            })}
            checked={draft.revisionFeedbackWindowConfig.lookbackIncludeMustFixOnly}
            onChange={() => setDraft("revisionFeedbackWindowConfig", {
              ...draft.revisionFeedbackWindowConfig,
              lookbackIncludeMustFixOnly: !draft.revisionFeedbackWindowConfig.lookbackIncludeMustFixOnly,
            })}
          />
        </div>
      </div>

      {/* F-011: Voice Preservation 第一层 — spelling convention 全局拼写约定 */}
      <div className="space-y-2">
        <h3 className={NOVEL_GROUP_HEADING_CLASS}>
          {t("settings.sections.novel.spellingConvention.title", {
            defaultValue: "拼写约定（Voice Preservation）",
          })}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.novel.spellingConvention.description", {
            defaultValue: "全局拼写约定，作为 Voice Preservation 三层映射的第一层。",
          })}
        </p>
        <div className="grid gap-4 rounded-lg border p-4">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`${ids}-spelling-dialoguePunctuationStyle`}>
                {t("settings.sections.novel.spellingConvention.dialoguePunctuationStyle", {
                  defaultValue: "对话标点风格",
                })}
              </Label>
              {settingTooltip("spellingConventionDialoguePunctuationStyleHint")}
            </div>
            <Input
              id={`${ids}-spelling-dialoguePunctuationStyle`}
              value={draft.novelConfig.dialoguePunctuationStyle}
              onChange={(e) => updateNovelConfig({ dialoguePunctuationStyle: e.target.value })}
              placeholder={t("settings.sections.novel.spellingConvention.dialoguePunctuationPlaceholder", {
                defaultValue: "例如：使用中文引号「」、对话后不加破折号",
              })}
              className="w-full"
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`${ids}-spelling-paragraphIndent`}>
                {t("settings.sections.novel.spellingConvention.paragraphIndent", {
                  defaultValue: "段落缩进",
                })}
              </Label>
              {settingTooltip("spellingConventionParagraphIndentHint")}
            </div>
            <Input
              id={`${ids}-spelling-paragraphIndent`}
              value={draft.novelConfig.paragraphIndent}
              onChange={(e) => updateNovelConfig({ paragraphIndent: e.target.value })}
              placeholder={t("settings.sections.novel.spellingConvention.paragraphIndentPlaceholder", {
                defaultValue: "例如：每段首行缩进两字符",
              })}
              className="w-full"
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`${ids}-spelling-quoteConvention`}>
                {t("settings.sections.novel.spellingConvention.quoteConvention", {
                  defaultValue: "引号规范",
                })}
              </Label>
              {settingTooltip("spellingConventionQuoteConventionHint")}
            </div>
            <Input
              id={`${ids}-spelling-quoteConvention`}
              value={draft.novelConfig.quoteConvention}
              onChange={(e) => updateNovelConfig({ quoteConvention: e.target.value })}
              placeholder={t("settings.sections.novel.spellingConvention.quoteConventionPlaceholder", {
                defaultValue: "例如：对话用双引号，引用用单引号",
              })}
              className="w-full"
            />
          </div>
        </div>
      </div>

      {/* F-34: 反 AI 遥测显式同意（app 级 store，不走 draft.novelConfig） */}
      <div className="space-y-2">
        <h3 className={NOVEL_GROUP_HEADING_CLASS}>
          {t("settings.sections.novel.antiAiTelemetry.title", {
            defaultValue: "反 AI 遥测诊断",
          })}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.novel.antiAiTelemetry.description", {
            defaultValue: "应用级设置：仅控制本机匿名诊断遥测，与项目级小说设置相互独立。",
          })}
        </p>
        <div className="grid gap-4 rounded-lg border p-4">
          <NovelSwitchRow
            label={t("novel.settings.antiAiTelemetryConsent")}
            tipKey="antiAiTelemetryConsentHint"
            checked={antiAiTelemetryConsent === true}
            onChange={() => { void toggleAntiAiTelemetryConsent() }}
          />
          {consentError ? (
            <p className="text-xs text-destructive">
              {t("novel.settings.antiAiTelemetryConsentError", { message: consentError })}
            </p>
          ) : null}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <h4 className="text-sm leading-none font-medium">{t("novel.settings.kbShadowCollectionSection")}</h4>
              {settingTooltip("kbShadowCollectionHint")}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={kbShadowRun.running}
                onClick={() => { void runKbShadowCollection() }}
              >
                {t("novel.settings.kbShadowRunButton")}
              </Button>
              {kbShadowRun.running ? (
                <span className="text-xs text-muted-foreground">{t("novel.settings.kbShadowRunning")}</span>
              ) : null}
            </div>
            {kbShadowRun.skipped ? (
              <p className="text-xs text-muted-foreground">{t("novel.settings.kbShadowSkipped")}</p>
            ) : null}
            {kbShadowRun.written !== null && !kbShadowRun.skipped ? (
              <p className="text-xs text-muted-foreground">
                {t("novel.settings.kbShadowDone", { written: kbShadowRun.written, failed: kbShadowRun.failed })}
              </p>
            ) : null}
            {kbShadowRun.error ? (
              <p className="text-xs text-destructive">
                {t("novel.settings.kbShadowError", { message: kbShadowRun.error })}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <WritingPreferenceSection />
      </div>
    </TooltipProvider>
  )
}
