// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useId } from "react"
import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import { OUTLINE_GENRE_CODES } from "@/lib/novel"
import type { NovelConfig } from "@/stores/wiki-store"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import {
  NovelDecimalField,
  NovelExperimentalDetails,
  NovelNumberField,
  NovelSettingTooltip,
  NovelSwitchRow,
} from "./novel-section-panels"

// 兼容旧导入路径：NovelToggle / NovelSettingTooltip 现在实现于 novel-section-panels。
export { NovelSettingTooltip, NovelToggle } from "./novel-section-panels"

interface NovelBaseSettingsSectionProps {
  draft: SettingsDraft
  setDraft: DraftSetter
  updateNovelConfig: (patch: Partial<NovelConfig>) => Promise<void>
}

/** 按钮组选中态样式（chat 历史长度 / 审查推理强度共用）。 */
function choiceClass(active: boolean, size: "md" | "sm"): string {
  const base = size === "md" ? "rounded-md border px-3 py-1.5 text-sm" : "min-h-6 rounded-md border px-2.5 py-1 text-xs"
  return `${base} transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
    active ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent"
  }`
}

/**
 * 基础小说设置网格体（novel-section 增量切片 M11-2）。
 * 纯展示组件：数值/类型/genre/开关/检索路由/内容组装/治理/社区条件块，
 * 数据流经 props（draft/setDraft/updateNovelConfig）进出，不直连 store。
 * 数字框失焦/回车才提交；实验性开关收进默认折叠的 <details>。
 */
export function NovelBaseSettingsSection({ draft, setDraft, updateNovelConfig }: NovelBaseSettingsSectionProps) {
  const { t } = useTranslation()
  const baseId = useId()
  const chatHistoryLabelId = `${baseId}-chat-history`
  const reasoningLabelId = `${baseId}-reasoning`
  const genreSelectId = `${baseId}-genre`
  const settingTooltip = (key: string) => <NovelSettingTooltip tipKey={key} />
  return (
    <>
          <NovelNumberField
            label={t("novel.settings.recentSummaryWindow")}
            tipKey="recentSummaryWindowHint"
            value={draft.novelConfig.recentSummaryWindow}
            min={1}
            max={30}
            onCommit={(n) => updateNovelConfig({ recentSummaryWindow: n })}
          />

          <NovelNumberField
            label={t("novel.settings.searchTopK")}
            tipKey="searchTopKHint"
            value={draft.novelConfig.searchTopK}
            min={1}
            max={20}
            onCommit={(n) => updateNovelConfig({ searchTopK: n })}
          />

          <NovelNumberField
            label={t("novel.settings.contextTokenBudget")}
            tipKey="contextTokenBudgetHelp"
            hint={t("novel.settings.contextTokenBudgetHint")}
            value={draft.novelConfig.contextTokenBudget}
            min={0}
            max={200000}
            onCommit={(n) => updateNovelConfig({ contextTokenBudget: n })}
            className="w-32"
          />

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <span id={chatHistoryLabelId} className="text-sm leading-none font-medium">
                {t("novel.settings.chatHistoryLength")}
              </span>
              {settingTooltip("chatHistoryLengthHint")}
            </div>
            <div role="group" aria-labelledby={chatHistoryLabelId} className="flex flex-wrap gap-2">
              {[2, 4, 6, 8, 10, 20].map((n) => {
                const active = draft.maxHistoryMessages === n
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDraft("maxHistoryMessages", n)}
                    className={choiceClass(active, "md")}
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
              <Label htmlFor={genreSelectId}>{t("novel.settings.genre")}</Label>
              {settingTooltip("genreHint")}
            </div>
            <select
              id={genreSelectId}
              data-testid="novel-genre-select"
              value={draft.novelConfig.genre ?? ""}
              onChange={(e) => {
                const value = e.target.value
                // 空 = 未设置 (undefined); "general" 也存 undefined (通用基线)。
                updateNovelConfig({ genre: value && value !== "general" ? value : undefined })
              }}
              className="h-9 w-48 rounded-md border border-input bg-background px-3 py-1 text-sm"
            >
              <option value="">{t("novel.settings.genreUnset")}</option>
              {OUTLINE_GENRE_CODES.map((code) => (
                <option key={code} value={code}>
                  {t(`novel.outlineGenerator.genres.${code}`)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {t("novel.settings.genreHint")}
            </p>
          </div>

          <NovelNumberField
            label={t("novel.settings.chapterTargetChars")}
            tipKey="chapterTargetCharsHint"
            hint={t("novel.settings.chapterTargetCharsHint")}
            value={draft.novelConfig.chapterTargetChars}
            min={500}
            max={20000}
            step={100}
            onCommit={(n) => updateNovelConfig({ chapterTargetChars: n })}
            className="w-32"
          />

          <NovelSwitchRow
            label={t("novel.settings.autoIngestOnSave")}
            tipKey="autoIngestOnSaveHint"
            checked={draft.novelConfig.autoIngestOnSave}
            onChange={() => updateNovelConfig({ autoIngestOnSave: !draft.novelConfig.autoIngestOnSave })}
          />

          <NovelSwitchRow
            label={t("novel.settings.reviewBeforeSave")}
            tipKey="reviewBeforeSaveHint"
            checked={draft.novelConfig.reviewBeforeSave}
            onChange={() => updateNovelConfig({ reviewBeforeSave: !draft.novelConfig.reviewBeforeSave })}
          />

          <NovelSwitchRow
            label={t("novel.settings.deepPreviousChaptersAnalysis")}
            tipKey="deepPreviousChaptersAnalysisHint"
            checked={draft.novelConfig.deepPreviousChaptersAnalysis}
            onChange={() => updateNovelConfig({ deepPreviousChaptersAnalysis: !draft.novelConfig.deepPreviousChaptersAnalysis })}
          />

          <NovelSwitchRow
            label={t("novel.settings.deepChapterReview")}
            tipKey="deepChapterReviewHint"
            checked={draft.novelConfig.deepChapterReview}
            onChange={() => updateNovelConfig({ deepChapterReview: !draft.novelConfig.deepChapterReview })}
          />

          <NovelSwitchRow
            label={t("novel.settings.literaryPolishAfterGate")}
            tipKey="literaryPolishAfterGateHint"
            checked={!!draft.novelConfig.literaryPolishAfterGate}
            onChange={() => updateNovelConfig({ literaryPolishAfterGate: !draft.novelConfig.literaryPolishAfterGate })}
          />

          <NovelSwitchRow
            label={t("novel.settings.residualCampaignEnabled")}
            tipKey="residualCampaignEnabledHint"
            checked={!!draft.novelConfig.residualCampaignEnabled}
            onChange={() => updateNovelConfig({ residualCampaignEnabled: !draft.novelConfig.residualCampaignEnabled })}
          />

          {/* R9（Round-9 用户可感知开关）：stage-output-journal 任务书缓存用户开关
              （user-r9“journal 零感知零开关”整改——此前 chat-panel 硬编码默认启用，设置面无入口）。
              关=每次直调 LLM；开=同 digest 重入命中跳过 LLM 并在 thinking 流提示。默认开。 */}
          <NovelSwitchRow
            label={t("novel.settings.stageJournalEnabled")}
            tipKey="stageJournalEnabledHint"
            checked={draft.novelConfig.stageJournalEnabled !== false}
            onChange={() => updateNovelConfig({ stageJournalEnabled: draft.novelConfig.stageJournalEnabled === false })}
          />

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <span id={reasoningLabelId} className="text-sm leading-none font-medium">
                {t("novel.settings.reviewReasoningEffort")}
              </span>
              {settingTooltip("reviewReasoningEffortHint")}
            </div>
            <div role="group" aria-labelledby={reasoningLabelId} className="flex flex-wrap gap-1.5">
              {(["low", "medium", "high"] as const).map((m) => {
                const active = (draft.novelConfig.reviewReasoningEffort ?? "high") === m
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={active}
                    onClick={() => updateNovelConfig({ reviewReasoningEffort: m })}
                    className={choiceClass(active, "sm")}
                  >
                    {t(`settings.sections.llm.reasoning.${m}`)}
                  </button>
                )
              })}
            </div>
          </div>

          <NovelSwitchRow
            label={t("novel.settings.communitySummaryEnabled")}
            tipKey="communitySummaryEnabledHint"
            checked={draft.novelConfig.communitySummaryEnabled}
            onChange={() => updateNovelConfig({ communitySummaryEnabled: !draft.novelConfig.communitySummaryEnabled })}
          />

          <NovelSwitchRow
            label={t("novel.settings.temporalFactsEnabled")}
            tipKey="temporalFactsEnabledHint"
            checked={draft.novelConfig.temporalFactsEnabled}
            onChange={() => updateNovelConfig({ temporalFactsEnabled: !draft.novelConfig.temporalFactsEnabled })}
          />

          <NovelSwitchRow
            label={t("novel.settings.entityBoostEnabled")}
            tipKey="entityBoostEnabledHint"
            checked={draft.novelConfig.entityBoostEnabled !== false}
            onChange={() => updateNovelConfig({ entityBoostEnabled: !(draft.novelConfig.entityBoostEnabled !== false) })}
          />

          <NovelSwitchRow
            label={t("novel.settings.stateDeltaLightCheckEnabled")}
            tipKey="stateDeltaLightCheckEnabledHint"
            checked={draft.novelConfig.stateDeltaLightCheckEnabled !== false}
            onChange={() => updateNovelConfig({ stateDeltaLightCheckEnabled: !(draft.novelConfig.stateDeltaLightCheckEnabled !== false) })}
          />

          <NovelSwitchRow
            label={t("novel.settings.outlineThrillSoftGateEnabled")}
            tipKey="outlineThrillSoftGateEnabledHint"
            checked={draft.novelConfig.outlineThrillSoftGateEnabled !== false}
            onChange={() => updateNovelConfig({ outlineThrillSoftGateEnabled: !(draft.novelConfig.outlineThrillSoftGateEnabled !== false) })}
          />

          <NovelExperimentalDetails>
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-1.5">
                <h4 className="text-sm font-medium">{t("novel.settings.retrievalRoutingSection")}</h4>
                {settingTooltip("retrievalRoutingSectionHint")}
              </div>
              <NovelSwitchRow
                label={t("novel.settings.dualKbRoutingEnabled")}
                tipKey="dualKbRoutingEnabledHint"
                checked={draft.novelConfig.dualKbRoutingEnabled === true}
                onChange={() => updateNovelConfig({ dualKbRoutingEnabled: !(draft.novelConfig.dualKbRoutingEnabled === true) })}
              />
              <NovelSwitchRow
                label={t("novel.settings.usefulnessRerankEnabled")}
                tipKey="usefulnessRerankEnabledHint"
                checked={draft.novelConfig.usefulnessRerankEnabled === true}
                onChange={() => updateNovelConfig({ usefulnessRerankEnabled: !(draft.novelConfig.usefulnessRerankEnabled === true) })}
              />
              <NovelSwitchRow
                label={t("novel.settings.hardInjectEnabled")}
                tipKey="hardInjectEnabledHint"
                checked={draft.novelConfig.hardInjectEnabled !== false}
                onChange={() => updateNovelConfig({ hardInjectEnabled: !(draft.novelConfig.hardInjectEnabled !== false) })}
              />
              <NovelDecimalField
                label={t("novel.settings.entityBoostWeight")}
                tipKey="entityBoostWeightHint"
                value={draft.novelConfig.entityBoostWeight}
                min={0}
                max={1}
                step={0.05}
                onCommit={(n) => updateNovelConfig({ entityBoostWeight: n })}
              />
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <h4 className="text-sm font-medium">{t("novel.settings.contentAssemblySection")}</h4>
              {([
                ["exemplarEnabled", "exemplarEnabled"],
                ["relatedChaptersEnabled", "relatedChaptersEnabled"],
                ["referenceEnabled", "referenceEnabled"],
                ["sceneBreakdownEnabled", "sceneBreakdownEnabled"],
                ["conditionalRoutingEnabled", "conditionalRoutingEnabled"],
                ["inspectorEnabled", "inspectorEnabled"],
                ["stateDeltaBlocksTrackA", "stateDeltaBlocksTrackA"],
              ] as const).map(([configKey, i18nKey]) => (
                <NovelSwitchRow
                  key={configKey}
                  label={t(`novel.settings.${i18nKey}`)}
                  tipKey={`${i18nKey}Hint`}
                  checked={draft.novelConfig[configKey] !== false}
                  onChange={() => updateNovelConfig({ [configKey]: !(draft.novelConfig[configKey] !== false) } as Partial<NovelConfig>)}
                />
              ))}
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-1.5">
                <h4 className="text-sm font-medium">{t("novel.settings.governanceSection")}</h4>
                {settingTooltip("governanceSectionHint")}
              </div>
              {([
                ["trustFilterEnabledReadonly", "trustFilterEnabledReadonlyHint"],
                ["decayEnabledReadonly", "decayEnabledReadonlyHint"],
                ["supersessionFilterEnabledReadonly", "supersessionFilterEnabledReadonlyHint"],
              ] as const).map(([labelKey, hintKey]) => (
                <div key={labelKey} className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5">
                    {/* 只读展示，无对应控件：用文本而非 <label>，避免孤立 label */}
                    <span className="text-sm leading-none font-medium">{t(`novel.settings.${labelKey}`)}</span>
                    {settingTooltip(hintKey)}
                  </div>
                  <span className="rounded border px-2 py-0.5 text-xs text-muted-foreground">
                    {t("novel.settings.governanceBadgeNotWired")}
                  </span>
                </div>
              ))}
            </div>
          </NovelExperimentalDetails>

          {draft.novelConfig.communitySummaryEnabled && (
            <>
              <NovelNumberField
                label={t("novel.settings.communitySummaryInterval")}
                tipKey="communitySummaryIntervalHint"
                value={draft.novelConfig.communitySummaryInterval}
                min={1}
                max={50}
                onCommit={(n) => updateNovelConfig({ communitySummaryInterval: n })}
              />

              <NovelSwitchRow
                label={t("novel.settings.communitySummaryAsync")}
                tipKey="communitySummaryAsyncHint"
                checked={draft.novelConfig.communitySummaryAsync}
                onChange={() => updateNovelConfig({ communitySummaryAsync: !draft.novelConfig.communitySummaryAsync })}
              />
            </>
          )}
    </>
  )
}
