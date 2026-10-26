// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT


import { useTranslation } from "react-i18next"
import { Info } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { OUTLINE_GENRE_CODES } from "@/lib/novel"
import type { NovelConfig } from "@/stores/wiki-store"
import type { SettingsDraft, DraftSetter } from "../settings-types"

/** Standard toggle switch for novel settings rows. */
export function NovelToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
        checked ? "bg-primary" : "bg-input"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background elevation-3 ring-0 transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  )
}

/** Per-setting help tooltip (single implementation shared with novel-section). */
export function NovelSettingTooltip({ tipKey }: { tipKey: string }) {
  const { t } = useTranslation()
  return (
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
        {t(`novel.settings.${tipKey}`)}
      </TooltipContent>
    </Tooltip>
  )
}

interface NovelBaseSettingsSectionProps {
  draft: SettingsDraft
  setDraft: DraftSetter
  updateNovelConfig: (patch: Partial<NovelConfig>) => Promise<void>
}

/**
 * 基础小说设置网格体（novel-section 增量切片 M11-2）。
 * 纯展示组件：数值/类型/genre/开关/检索路由/内容组装/治理/社区条件块，
 * 数据流经 props（draft/setDraft/updateNovelConfig）进出，不直连 store。
 */
export function NovelBaseSettingsSection({ draft, setDraft, updateNovelConfig }: NovelBaseSettingsSectionProps) {
  const { t } = useTranslation()
  const settingTooltip = (key: string) => <NovelSettingTooltip tipKey={key} />
  return (
    <>
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
              <Label>{t("novel.settings.genre")}</Label>
              {settingTooltip("genreHint")}
            </div>
            <select
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
              label={t('novel.settings.autoIngestOnSave')}
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
              label={t('novel.settings.reviewBeforeSave')}
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
              label={t('novel.settings.deepPreviousChaptersAnalysis')}
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
              label={t('novel.settings.deepChapterReview')}
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
              label={t('novel.settings.literaryPolishAfterGate')}
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
              label={t('novel.settings.residualCampaignEnabled')}
              checked={!!draft.novelConfig.residualCampaignEnabled}
              onChange={() => updateNovelConfig({ residualCampaignEnabled: !draft.novelConfig.residualCampaignEnabled })}
            />
          </div>

          {/* R9（Round-9 用户可感知开关）：stage-output-journal 任务书缓存用户开关
              （user-r9“journal 零感知零开关”整改——此前 chat-panel 硬编码默认启用，设置面无入口）。
              关=每次直调 LLM；开=同 digest 重入命中跳过 LLM 并在 thinking 流提示。默认开。 */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label>{t("novel.settings.stageJournalEnabled")}</Label>
              {settingTooltip("stageJournalEnabledHint")}
            </div>
            <NovelToggle
              label={t('novel.settings.stageJournalEnabled')}
              checked={draft.novelConfig.stageJournalEnabled !== false}
              onChange={() => updateNovelConfig({ stageJournalEnabled: draft.novelConfig.stageJournalEnabled === false })}
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
              label={t('novel.settings.communitySummaryEnabled')}
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
              label={t('novel.settings.temporalFactsEnabled')}
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
              label={t('novel.settings.entityBoostEnabled')}
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
              label={t('novel.settings.stateDeltaLightCheckEnabled')}
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
              label={t('novel.settings.outlineThrillSoftGateEnabled')}
              checked={draft.novelConfig.outlineThrillSoftGateEnabled !== false}
              onChange={() => updateNovelConfig({ outlineThrillSoftGateEnabled: !(draft.novelConfig.outlineThrillSoftGateEnabled !== false) })}
            />
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium">{t("novel.settings.retrievalRoutingSection")}</p>
              {settingTooltip("retrievalRoutingSectionHint")}
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <Label>{t("novel.settings.dualKbRoutingEnabled")}</Label>
                {settingTooltip("dualKbRoutingEnabledHint")}
              </div>
              <NovelToggle
                label={t('novel.settings.dualKbRoutingEnabled')}
                checked={draft.novelConfig.dualKbRoutingEnabled === true}
                onChange={() => updateNovelConfig({ dualKbRoutingEnabled: !(draft.novelConfig.dualKbRoutingEnabled === true) })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <Label>{t("novel.settings.usefulnessRerankEnabled")}</Label>
                {settingTooltip("usefulnessRerankEnabledHint")}
              </div>
              <NovelToggle
                label={t('novel.settings.usefulnessRerankEnabled')}
                checked={draft.novelConfig.usefulnessRerankEnabled === true}
                onChange={() => updateNovelConfig({ usefulnessRerankEnabled: !(draft.novelConfig.usefulnessRerankEnabled === true) })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <Label>{t("novel.settings.hardInjectEnabled")}</Label>
                {settingTooltip("hardInjectEnabledHint")}
              </div>
              <NovelToggle
                label={t('novel.settings.hardInjectEnabled')}
                checked={draft.novelConfig.hardInjectEnabled !== false}
                onChange={() => updateNovelConfig({ hardInjectEnabled: !(draft.novelConfig.hardInjectEnabled !== false) })}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Label>{t("novel.settings.entityBoostWeight")}</Label>
                {settingTooltip("entityBoostWeightHint")}
              </div>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={draft.novelConfig.entityBoostWeight}
                onChange={(e) => updateNovelConfig({
                  entityBoostWeight: Math.max(0, Math.min(1, Number(e.target.value) || 0)),
                })}
                className="w-24"
              />
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">{t("novel.settings.contentAssemblySection")}</p>
            {([
              ["exemplarEnabled", "exemplarEnabled"],
              ["relatedChaptersEnabled", "relatedChaptersEnabled"],
              ["referenceEnabled", "referenceEnabled"],
              ["sceneBreakdownEnabled", "sceneBreakdownEnabled"],
              ["conditionalRoutingEnabled", "conditionalRoutingEnabled"],
              ["inspectorEnabled", "inspectorEnabled"],
              ["stateDeltaBlocksTrackA", "stateDeltaBlocksTrackA"],
            ] as const).map(([configKey, i18nKey]) => (
              <div key={configKey} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Label>{t(`novel.settings.${i18nKey}`)}</Label>
                  {settingTooltip(`${i18nKey}Hint`)}
                </div>
                <NovelToggle
                  label={t('novel.settings.contentAssemblySection')}
                  checked={draft.novelConfig[configKey] !== false}
                  onChange={() => updateNovelConfig({ [configKey]: !(draft.novelConfig[configKey] !== false) } as Partial<NovelConfig>)}
                />
              </div>
            ))}
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium">{t("novel.settings.governanceSection")}</p>
              {settingTooltip("governanceSectionHint")}
            </div>
            {([
              ["trustFilterEnabledReadonly", "trustFilterEnabledReadonlyHint"],
              ["decayEnabledReadonly", "decayEnabledReadonlyHint"],
              ["supersessionFilterEnabledReadonly", "supersessionFilterEnabledReadonlyHint"],
            ] as const).map(([labelKey, hintKey]) => (
              <div key={labelKey} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Label>{t(`novel.settings.${labelKey}`)}</Label>
                  {settingTooltip(hintKey)}
                </div>
                <span className="rounded border px-2 py-0.5 text-xs text-muted-foreground">
                  {t("novel.settings.governanceBadgeNotWired")}
                </span>
              </div>
            ))}
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
                  label={t('novel.settings.communitySummaryAsync')}
                  checked={draft.novelConfig.communitySummaryAsync}
                  onChange={() => updateNovelConfig({ communitySummaryAsync: !draft.novelConfig.communitySummaryAsync })}
                />
              </div>
            </>
          )}
    </>
  )
}
