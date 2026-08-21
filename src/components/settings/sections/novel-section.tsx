// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Info } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useWikiStore } from "@/stores/wiki-store"
import { saveNovelConfig } from "@/lib/project-store"

import { testNovelModel, type TestableNovelModelTask } from "@/lib/novel/novel-model-test"
import { ChatModelSelector } from "@/components/chat/chat-model-selector"
import { WritingPreferenceSection } from "./writing-preference-section"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import type { NovelConfig } from "@/stores/wiki-store"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

/** Standard toggle switch for novel settings rows. */
function NovelToggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: () => void
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
        checked ? "bg-primary" : "bg-input"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  )
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

  const updateNovelConfig = async (patch: Partial<NovelConfig>) => {
    const newConfig = { ...draft.novelConfig, ...patch }
    setDraft("novelConfig", newConfig)
    setNovelConfigStore(patch)
    await saveNovelConfig(newConfig, project?.id, project?.path)
  }

  const modelItems = useMemo(() => ([
    { task: "review", field: "reviewModel", wrapperClassName: "space-y-2" },
    { task: "summary", field: "summaryModel", wrapperClassName: "space-y-2" },
    {
      task: "extract",
      field: "extractModel",
      wrapperClassName: "space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3",
    },
  ] as const), [])

  const settingTooltip = (key: string) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            aria-label={t("novel.settings.help")}
          />
        }
      >
        <Info className="h-3.5 w-3.5" />
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-sm leading-5">
        {t(`novel.settings.${key}`)}
      </TooltipContent>
    </Tooltip>
  )

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
            message: error instanceof Error ? error.message : String(error),
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
        <Label>{t("novel.settings.title")}</Label>
        <div className="grid gap-4 rounded-lg border p-4">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.recentSummaryWindow")}</Label>
              {settingTooltip("recentSummaryWindowHint")}
            </div>
            <Input
              type="number"
              min={1}
              max={30}
              value={draft.novelConfig.recentSummaryWindow}
              onChange={(e) => updateNovelConfig({
                recentSummaryWindow: Math.max(1, Math.min(30, Number(e.target.value) || 1)),
              })}
              className="w-24"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.searchTopK")}</Label>
              {settingTooltip("searchTopKHint")}
            </div>
            <Input
              type="number"
              min={1}
              max={20}
              value={draft.novelConfig.searchTopK}
              onChange={(e) => updateNovelConfig({
                searchTopK: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
              })}
              className="w-24"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.contextTokenBudget")}</Label>
              {settingTooltip("contextTokenBudgetHelp")}
            </div>
            <Input
              type="number"
              min={0}
              max={200000}
              value={draft.novelConfig.contextTokenBudget}
              onChange={(e) => updateNovelConfig({
                contextTokenBudget: Math.max(0, Math.min(200000, Number(e.target.value) || 0)),
              })}
              className="w-32"
            />
            <p className="text-xs text-muted-foreground">
              {t("novel.settings.contextTokenBudgetHint")}
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.chatHistoryLength")}</Label>
              {settingTooltip("chatHistoryLengthHint")}
            </div>
            <div className="flex flex-wrap gap-2">
              {[2, 4, 6, 8, 10, 20].map((n) => {
                const active = draft.maxHistoryMessages === n
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setDraft("maxHistoryMessages", n)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {n}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("novel.settings.chatHistoryLengthCurrent", {
                count: draft.maxHistoryMessages,
                turns: draft.maxHistoryMessages / 2,
              })}
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.chapterTargetChars")}</Label>
              {settingTooltip("chapterTargetCharsHint")}
            </div>
            <Input
              type="number"
              min={500}
              max={20000}
              step={100}
              value={draft.novelConfig.chapterTargetChars}
              onChange={(e) => updateNovelConfig({
                chapterTargetChars: Math.max(500, Math.min(20000, Number(e.target.value) || 3000)),
              })}
              className="w-32"
            />
            <p className="text-xs text-muted-foreground">
              {t("novel.settings.chapterTargetCharsHint")}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.autoIngestOnSave")}</Label>
              {settingTooltip("autoIngestOnSaveHint")}
            </div>
            <NovelToggle
              checked={draft.novelConfig.autoIngestOnSave}
              onChange={() => updateNovelConfig({ autoIngestOnSave: !draft.novelConfig.autoIngestOnSave })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.reviewBeforeSave")}</Label>
              {settingTooltip("reviewBeforeSaveHint")}
            </div>
            <NovelToggle
              checked={draft.novelConfig.reviewBeforeSave}
              onChange={() => updateNovelConfig({ reviewBeforeSave: !draft.novelConfig.reviewBeforeSave })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.deepPreviousChaptersAnalysis")}</Label>
              {settingTooltip("deepPreviousChaptersAnalysisHint")}
            </div>
            <NovelToggle
              checked={draft.novelConfig.deepPreviousChaptersAnalysis}
              onChange={() => updateNovelConfig({ deepPreviousChaptersAnalysis: !draft.novelConfig.deepPreviousChaptersAnalysis })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.deepChapterReview")}</Label>
              {settingTooltip("deepChapterReviewHint")}
            </div>
            <NovelToggle
              checked={draft.novelConfig.deepChapterReview}
              onChange={() => updateNovelConfig({ deepChapterReview: !draft.novelConfig.deepChapterReview })}
            />
          </div>



          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.literaryPolishAfterGate")}</Label>
              {settingTooltip("literaryPolishAfterGateHint")}
            </div>
            <NovelToggle
              checked={!!draft.novelConfig.literaryPolishAfterGate}
              onChange={() => updateNovelConfig({ literaryPolishAfterGate: !draft.novelConfig.literaryPolishAfterGate })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.residualCampaignEnabled")}</Label>
              {settingTooltip("residualCampaignEnabledHint")}
            </div>
            <NovelToggle
              checked={!!draft.novelConfig.residualCampaignEnabled}
              onChange={() => updateNovelConfig({ residualCampaignEnabled: !draft.novelConfig.residualCampaignEnabled })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.reviewReasoningEffort")}</Label>
              {settingTooltip("reviewReasoningEffortHint")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(["low", "medium", "high"] as const).map((m) => {
                const active = (draft.novelConfig.reviewReasoningEffort ?? "high") === m
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => updateNovelConfig({ reviewReasoningEffort: m })}
                    className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {t(`settings.sections.llm.reasoning.${m}`)}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.communitySummaryEnabled")}</Label>
              {settingTooltip("communitySummaryEnabledHint")}
            </div>
            <NovelToggle
              checked={draft.novelConfig.communitySummaryEnabled}
              onChange={() => updateNovelConfig({ communitySummaryEnabled: !draft.novelConfig.communitySummaryEnabled })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.temporalFactsEnabled")}</Label>
              {settingTooltip("temporalFactsEnabledHint")}
            </div>
            <NovelToggle
              checked={draft.novelConfig.temporalFactsEnabled}
              onChange={() => updateNovelConfig({ temporalFactsEnabled: !draft.novelConfig.temporalFactsEnabled })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.entityBoostEnabled")}</Label>
              {settingTooltip("entityBoostEnabledHint")}
            </div>
            <NovelToggle
              checked={draft.novelConfig.entityBoostEnabled !== false}
              onChange={() => updateNovelConfig({ entityBoostEnabled: !(draft.novelConfig.entityBoostEnabled !== false) })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.stateDeltaLightCheckEnabled")}</Label>
              {settingTooltip("stateDeltaLightCheckEnabledHint")}
            </div>
            <NovelToggle
              checked={draft.novelConfig.stateDeltaLightCheckEnabled !== false}
              onChange={() => updateNovelConfig({ stateDeltaLightCheckEnabled: !(draft.novelConfig.stateDeltaLightCheckEnabled !== false) })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.outlineThrillSoftGateEnabled")}</Label>
              {settingTooltip("outlineThrillSoftGateEnabledHint")}
            </div>
            <NovelToggle
              checked={draft.novelConfig.outlineThrillSoftGateEnabled !== false}
              onChange={() => updateNovelConfig({ outlineThrillSoftGateEnabled: !(draft.novelConfig.outlineThrillSoftGateEnabled !== false) })}
            />
          </div>

          {draft.novelConfig.communitySummaryEnabled && (
            <>
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>{t("novel.settings.communitySummaryInterval")}</Label>
                  {settingTooltip("communitySummaryIntervalHint")}
                </div>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={draft.novelConfig.communitySummaryInterval}
                  onChange={(e) => updateNovelConfig({
                    communitySummaryInterval: Math.max(1, Math.min(50, Number(e.target.value) || 1)),
                  })}
                  className="w-24"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Label>{t("novel.settings.communitySummaryAsync")}</Label>
                  {settingTooltip("communitySummaryAsyncHint")}
                </div>
                <NovelToggle
                  checked={draft.novelConfig.communitySummaryAsync}
                  onChange={() => updateNovelConfig({ communitySummaryAsync: !draft.novelConfig.communitySummaryAsync })}
                />
              </div>
            </>
          )}

          {modelItems.map((item) => {
            const state = testStates[item.task]
            const modelValue = draft.novelConfig[item.field] || ""
            const isFollowingChat = !modelValue
            const displayValue = isFollowingChat ? "" : modelValue

            return (
              <div key={item.task} className={item.wrapperClassName}>
                <div className="flex items-center gap-1.5">
                  <Label>{t(`novel.settings.${item.field}`)}</Label>
                  {settingTooltip(`${item.field}Hint`)}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2">
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
                  <p className={`text-xs ${state.success ? "text-emerald-600" : "text-destructive"}`}>
                    {state.message}
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      <div className="space-y-2">
        <Label>
          {t("settings.sections.novel.feedbackWindow.title", {
            defaultValue: "修改反馈窗口",
          })}
        </Label>
        <div className="grid gap-4 rounded-lg border p-4">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label>
                {t("settings.sections.novel.feedbackWindow.lookbackChapterCount", {
                  defaultValue: "回溯章节数量",
                })}
              </Label>
              {settingTooltip("feedbackWindowLookbackChapterCountHelp")}
            </div>
            <input
              type="number"
              min={0}
              value={draft.revisionFeedbackWindowConfig.lookbackChapterCount}
              onChange={(event) => setDraft("revisionFeedbackWindowConfig", {
                ...draft.revisionFeedbackWindowConfig,
                lookbackChapterCount: Math.max(0, Number(event.target.value) || 0),
              })}
              className="w-24 rounded-md border bg-background px-3 py-1.5 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.novel.feedbackWindow.lookbackChapterCountHint", {
                defaultValue:
                  "将多少章前序章节折叠回当前写作上下文。",
              })}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5">
                <Label>
                  {t("settings.sections.novel.feedbackWindow.currentChapterIncludeShouldImprove", {
                    defaultValue: "包含当前章节改进建议",
                  })}
                </Label>
                {settingTooltip("feedbackWindowCurrentChapterIncludeShouldImproveHelp")}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.novel.feedbackWindow.currentChapterIncludeShouldImproveHint", {
                  defaultValue:
                    "关闭后，当前章节仅贡献必须修复项和延续指示。",
                })}
              </p>
            </div>
            <NovelToggle
              checked={draft.revisionFeedbackWindowConfig.currentChapterIncludeShouldImprove}
              onChange={() => setDraft("revisionFeedbackWindowConfig", {
                ...draft.revisionFeedbackWindowConfig,
                currentChapterIncludeShouldImprove: !draft.revisionFeedbackWindowConfig.currentChapterIncludeShouldImprove,
              })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5">
                <Label>
                  {t("settings.sections.novel.feedbackWindow.previousChapterCarryEnabled", {
                    defaultValue: "读取上一章延续事项",
                  })}
                </Label>
                {settingTooltip("feedbackWindowPreviousChapterCarryEnabledHelp")}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.novel.feedbackWindow.previousChapterCarryEnabledHint", {
                  defaultValue:
                    "关闭后，上一章的延续事项不会注入当前上下文。",
                })}
              </p>
            </div>
            <NovelToggle
              checked={draft.revisionFeedbackWindowConfig.previousChapterCarryEnabled}
              onChange={() => setDraft("revisionFeedbackWindowConfig", {
                ...draft.revisionFeedbackWindowConfig,
                previousChapterCarryEnabled: !draft.revisionFeedbackWindowConfig.previousChapterCarryEnabled,
              })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5">
                <Label>
                  {t("settings.sections.novel.feedbackWindow.lookbackIncludeMustFixOnly", {
                    defaultValue: "回溯章节仅保留必须修复项",
                  })}
                </Label>
                {settingTooltip("feedbackWindowLookbackIncludeMustFixOnlyHelp")}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.novel.feedbackWindow.lookbackIncludeMustFixOnlyHint", {
                  defaultValue:
                    "关闭后，回溯章节也贡献改进建议。",
                })}
              </p>
            </div>
            <NovelToggle
              checked={draft.revisionFeedbackWindowConfig.lookbackIncludeMustFixOnly}
              onChange={() => setDraft("revisionFeedbackWindowConfig", {
                ...draft.revisionFeedbackWindowConfig,
                lookbackIncludeMustFixOnly: !draft.revisionFeedbackWindowConfig.lookbackIncludeMustFixOnly,
              })}
            />
          </div>
        </div>
      </div>

      {/* F-011: Voice Preservation 第一层 — spelling convention 全局拼写约定 */}
      <div className="space-y-2">
        <Label>
          {t("settings.sections.novel.spellingConvention.title", {
            defaultValue: "拼写约定（Voice Preservation）",
          })}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.novel.spellingConvention.description", {
            defaultValue: "全局拼写约定，作为 Voice Preservation 三层映射的第一层。",
          })}
        </p>
        <div className="grid gap-4 rounded-lg border p-4">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label>
                {t("settings.sections.novel.spellingConvention.dialoguePunctuationStyle", {
                  defaultValue: "对话标点风格",
                })}
              </Label>
              {settingTooltip("spellingConventionDialoguePunctuationStyleHint")}
            </div>
            <Input
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
              <Label>
                {t("settings.sections.novel.spellingConvention.paragraphIndent", {
                  defaultValue: "段落缩进",
                })}
              </Label>
              {settingTooltip("spellingConventionParagraphIndentHint")}
            </div>
            <Input
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
              <Label>
                {t("settings.sections.novel.spellingConvention.quoteConvention", {
                  defaultValue: "引号规范",
                })}
              </Label>
              {settingTooltip("spellingConventionQuoteConventionHint")}
            </div>
            <Input
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

      <WritingPreferenceSection />
      </div>
    </TooltipProvider>
  )
}
