import { useEffect, useMemo, useState } from "react"
import {
  BOOK_RULES_SCHEMA_VERSION,
  EMPTY_BOOK_RULES,
  bookRulesToPromptFragment,
  loadBookRules,
  saveBookRules,
  type BookRules,
  type FanficMode,
} from "@/lib/novel"
import { toErrorMessage } from "@/lib/utils"

export interface BookRulesPanelProps {
  projectPath: string
}

function splitLinesOrCommas(input: string): string[] {
  return input
    .split(/[\n,，、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function joinLines(items: readonly string[] | undefined): string {
  return (items ?? []).join("\n")
}

export function BookRulesPanel({ projectPath }: BookRulesPanelProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const [prohibitionsText, setProhibitionsText] = useState("")
  const [allowedDeviationsText, setAllowedDeviationsText] = useState("")
  const [genrePrimary, setGenrePrimary] = useState("")
  const [genreForbiddenText, setGenreForbiddenText] = useState("")
  const [protagonistName, setProtagonistName] = useState("")
  const [personalityLockText, setPersonalityLockText] = useState("")
  const [behavioralConstraintsText, setBehavioralConstraintsText] = useState("")
  const [eraEnabled, setEraEnabled] = useState(false)
  const [eraPeriod, setEraPeriod] = useState("")
  const [eraRegion, setEraRegion] = useState("")
  const [eraAnachronismsText, setEraAnachronismsText] = useState("")
  const [fanficMode, setFanficMode] = useState<FanficMode | "">("")
  const [canonLockNamesText, setCanonLockNamesText] = useState("")
  const [auDeviationsText, setAuDeviationsText] = useState("")
  const [oocMarkersText, setOocMarkersText] = useState("")
  const [pairingA, setPairingA] = useState("")
  const [pairingB, setPairingB] = useState("")

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErrorMessage(null)
    setStatusMessage(null)
    loadBookRules(projectPath)
      .then((loaded) => {
        if (cancelled) return
        const rules = loaded ?? EMPTY_BOOK_RULES
        setProhibitionsText(joinLines(rules.prohibitions))
        setAllowedDeviationsText(joinLines(rules.allowedDeviations))
        setGenrePrimary(rules.genreLock?.primary ?? "")
        setGenreForbiddenText(joinLines(rules.genreLock?.forbidden))
        setProtagonistName(rules.protagonist?.name ?? "")
        setPersonalityLockText(joinLines(rules.protagonist?.personalityLock))
        setBehavioralConstraintsText(joinLines(rules.protagonist?.behavioralConstraints))
        setEraEnabled(Boolean(rules.eraConstraints?.enabled))
        setEraPeriod(rules.eraConstraints?.period ?? "")
        setEraRegion(rules.eraConstraints?.region ?? "")
        setEraAnachronismsText(joinLines(rules.eraConstraints?.anachronismTerms))
        setFanficMode(rules.fanficMode ?? "")
        setCanonLockNamesText(joinLines(rules.canonLockNames))
        setAuDeviationsText(joinLines(rules.auDeviations))
        setOocMarkersText(joinLines(rules.oocMarkers))
        setPairingA(rules.pairing?.[0] ?? "")
        setPairingB(rules.pairing?.[1] ?? "")
      })
      .catch((err) => {
        if (!cancelled) setErrorMessage(`读取书籍规则失败：${toErrorMessage(err)}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const draftRules: BookRules = useMemo(() => {
    const next: BookRules = {
      ...EMPTY_BOOK_RULES,
      version: BOOK_RULES_SCHEMA_VERSION,
      prohibitions: splitLinesOrCommas(prohibitionsText),
      allowedDeviations: splitLinesOrCommas(allowedDeviationsText),
    }
    if (genrePrimary.trim()) {
      next.genreLock = {
        primary: genrePrimary.trim(),
        forbidden: splitLinesOrCommas(genreForbiddenText),
      }
    }
    if (protagonistName.trim()) {
      next.protagonist = {
        name: protagonistName.trim(),
        personalityLock: splitLinesOrCommas(personalityLockText),
        behavioralConstraints: splitLinesOrCommas(behavioralConstraintsText),
      }
    }
    if (eraEnabled || eraPeriod.trim() || eraRegion.trim() || eraAnachronismsText.trim()) {
      next.eraConstraints = {
        enabled: eraEnabled,
        anachronismTerms: splitLinesOrCommas(eraAnachronismsText),
        ...(eraPeriod.trim() ? { period: eraPeriod.trim() } : {}),
        ...(eraRegion.trim() ? { region: eraRegion.trim() } : {}),
      }
    }
    if (fanficMode) {
      next.fanficMode = fanficMode
    }
    const canonLockNames = splitLinesOrCommas(canonLockNamesText)
    if (canonLockNames.length > 0) next.canonLockNames = canonLockNames
    const auDeviations = splitLinesOrCommas(auDeviationsText)
    if (auDeviations.length > 0) next.auDeviations = auDeviations
    const oocMarkers = splitLinesOrCommas(oocMarkersText)
    if (oocMarkers.length > 0) next.oocMarkers = oocMarkers
    if (pairingA.trim() && pairingB.trim()) {
      next.pairing = [pairingA.trim(), pairingB.trim()]
    }
    return next
  }, [
    prohibitionsText,
    allowedDeviationsText,
    genrePrimary,
    genreForbiddenText,
    protagonistName,
    personalityLockText,
    behavioralConstraintsText,
    eraEnabled,
    eraPeriod,
    eraRegion,
    eraAnachronismsText,
    fanficMode,
    canonLockNamesText,
    auDeviationsText,
    oocMarkersText,
    pairingA,
    pairingB,
  ])

  const promptPreview = useMemo(() => bookRulesToPromptFragment(draftRules), [draftRules])

  async function handleSave() {
    if (!projectPath || saving) return
    setSaving(true)
    setErrorMessage(null)
    setStatusMessage(null)
    try {
      await saveBookRules(projectPath, draftRules)
      setStatusMessage("书籍规则已保存至 .novel/book-rules.json，并自动注入写作与审稿上下文。")
    } catch (err) {
      setErrorMessage(`保存书籍规则失败：${toErrorMessage(err)}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-5 text-sm text-muted-foreground" data-testid="book-rules-loading">
        正在读取书籍规则…
      </div>
    )
  }

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5 elevation-1" data-testid="book-rules-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">书籍治理规则（.novel/book-rules.json）</h2>
          <p className="text-xs text-muted-foreground">
            配置全书禁止项、题材锁、主角人设锁、时代约束与同人模式；保存后自动进入稳定前缀与机械门控。
          </p>
        </div>
        <button
          type="button"
          data-testid="book-rules-save"
          disabled={saving || !projectPath}
          onClick={() => void handleSave()}
          className="h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存书籍规则"}
        </button>
      </div>

      {statusMessage && (
        <div role="status" data-testid="book-rules-saved" className="rounded-md border border-success bg-success/10 px-3 py-2 text-xs text-success-foreground">
          {statusMessage}
        </div>
      )}
      {errorMessage && (
        <div role="alert" data-testid="book-rules-error" className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errorMessage}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">全书禁止项（每行或逗号分隔，词面命中即判违规）</span>
          <textarea
            data-testid="book-rules-prohibitions"
            value={prohibitionsText}
            onChange={(e) => setProhibitionsText(e.target.value)}
            rows={3}
            placeholder="例如：系统提示音、降智打脸、后宫收女"
            className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">允许偏差白名单（豁免短语，每行或逗号分隔）</span>
          <textarea
            data-testid="book-rules-deviations"
            value={allowedDeviationsText}
            onChange={(e) => setAllowedDeviationsText(e.target.value)}
            rows={3}
            placeholder="例如：梦境回溯片段中可出现现代术语"
            className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <div className="space-y-2 rounded-md border p-3">
          <div className="text-xs font-semibold">题材锁（GenreLock）</div>
          <input
            data-testid="book-rules-genre-primary"
            type="text"
            value={genrePrimary}
            onChange={(e) => setGenrePrimary(e.target.value)}
            placeholder="主题材，如：凡人流硬核修仙 / 规则怪谈悬疑"
            className="h-8 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <textarea
            data-testid="book-rules-genre-forbidden"
            value={genreForbiddenText}
            onChange={(e) => setGenreForbiddenText(e.target.value)}
            rows={2}
            placeholder="题材禁止元素（逗号或换行分隔）"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <div className="text-xs font-semibold">主角人设锁（ProtagonistRule）</div>
          <input
            data-testid="book-rules-protagonist-name"
            type="text"
            value={protagonistName}
            onChange={(e) => setProtagonistName(e.target.value)}
            placeholder="主角名称"
            className="h-8 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <textarea
            data-testid="book-rules-personality-lock"
            value={personalityLockText}
            onChange={(e) => setPersonalityLockText(e.target.value)}
            rows={2}
            placeholder="性格锁（如：极端克制、重利轻名）"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <textarea
            data-testid="book-rules-behavioral-constraints"
            value={behavioralConstraintsText}
            onChange={(e) => setBehavioralConstraintsText(e.target.value)}
            rows={2}
            placeholder="行为硬约束（如：不轻信陌生人、先验代价再出手）"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <label className="flex items-center gap-2 text-xs font-semibold">
            <input
              type="checkbox"
              data-testid="book-rules-era-enabled"
              checked={eraEnabled}
              onChange={(e) => setEraEnabled(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            启用时代约束（EraConstraints）
          </label>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={eraPeriod}
              onChange={(e) => setEraPeriod(e.target.value)}
              placeholder="时代（如：晚唐 / 民国）"
              className="h-8 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              type="text"
              value={eraRegion}
              onChange={(e) => setEraRegion(e.target.value)}
              placeholder="地域（如：江南 / 关中）"
              className="h-8 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <textarea
            value={eraAnachronismsText}
            onChange={(e) => setEraAnachronismsText(e.target.value)}
            rows={2}
            placeholder="禁用穿越词（如：手机、水泥、土豆）"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <div className="text-xs font-semibold">同人模式（FanficPolicy v1.1）</div>
          <select
            data-testid="book-rules-fanfic-mode"
            value={fanficMode}
            onChange={(e) => setFanficMode(e.target.value as FanficMode | "")}
            className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">非同人（关闭）</option>
            <option value="canon">canon（正典锁）</option>
            <option value="au">au（设定分叉白名单）</option>
            <option value="ooc">ooc（显式 OOC 标注）</option>
            <option value="cp">cp（配对双人同框检查）</option>
          </select>
          {fanficMode === "canon" && (
            <input
              type="text"
              value={canonLockNamesText}
              onChange={(e) => setCanonLockNamesText(e.target.value)}
              placeholder="正典名册锁角色名（逗号分隔）"
              className="h-8 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          )}
          {fanficMode === "au" && (
            <input
              type="text"
              value={auDeviationsText}
              onChange={(e) => setAuDeviationsText(e.target.value)}
              placeholder="AU 分叉豁免项（逗号分隔）"
              className="h-8 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          )}
          {fanficMode === "ooc" && (
            <input
              type="text"
              value={oocMarkersText}
              onChange={(e) => setOocMarkersText(e.target.value)}
              placeholder="自定义 OOC 标记（留空使用内置 5 种标记）"
              className="h-8 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          )}
          {fanficMode === "cp" && (
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={pairingA}
                onChange={(e) => setPairingA(e.target.value)}
                placeholder="CP 角色 A"
                className="h-8 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                type="text"
                value={pairingB}
                onChange={(e) => setPairingB(e.target.value)}
                placeholder="CP 角色 B"
                className="h-8 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-muted/20 p-3">
        <div className="mb-1 text-xs font-medium text-muted-foreground">Prompt 注入预览（自动合并进稳定前缀）</div>
        <pre className="whitespace-pre-wrap text-xs text-foreground">
          {promptPreview || "（当前未配置任何规则；保存空规则不会向提示词注入额外文本）"}
        </pre>
      </div>
    </section>
  )
}
