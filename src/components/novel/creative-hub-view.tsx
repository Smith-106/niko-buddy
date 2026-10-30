/**
 * creative-hub-view.tsx — 创作中枢视图（只读诊断＋下一步建议，不写盘）。
 *
 * 职责：
 *   - 绑定小说状态（project-meta；缺失时诚实显示未初始化空态）；
 *   - 展示整链诊断结论（verdict＋findings 列表，只读）；
 *   - 展示门控快照（blocked/blockingGate，只读）与纯函数派生的下一步建议；
 *   - 零数据时诚实空态（不虚构进度、不写盘、不修复）。
 *
 * 数据源（全部经 `@/lib/novel` barrel，不 deep import 内部模块）：
 *   - loadNovelProjectMeta(projectPath)（null = 未初始化）；
 *   - runProjectDoctor(projectPath)（verdict healthy/degraded/critical＋findings）；
 *   - buildDashboardEvidenceSnapshot(ledger)（blocked/blockingGate），账本经
 *     loadRunEventLedgerStore(createFsRunEventLedgerStoreDeps(), projectPath) 装载。
 *
 * 装载：串行一次（meta → doctor → ledger → snapshot），无轮询。
 * 中文 UI 直书（与 diagnostics-center 同款约定，零新增 i18n 键）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import {
  buildDashboardEvidenceSnapshot,
  createDefaultNovelProjectMeta,
  createFsRunEventLedgerStoreDeps,
  loadNovelProjectMeta,
  loadRunEventLedgerStore,
  runProjectDoctor,
  saveNovelProjectMeta,
  type DoctorReport,
  type EvidenceSnapshot,
  type NovelProjectMeta,
} from "@/lib/novel"
import { cn, toErrorMessage } from "@/lib/utils"
import { ReportCallout, ReportPage, ReportSection, reportToneClass, type ReportTone } from "./report-page"

export interface CreativeHubViewProps {
  readonly projectPath: string
}

/** 项目绑定元数据（barrel 导出；null=未初始化）。 */
type NovelMeta = NovelProjectMeta | null
type DoctorVerdict = DoctorReport["verdict"]
type BlockingGate = EvidenceSnapshot["blockingGate"]

/** 下一步建议项（纯函数产出；每条注明依据）。 */
export interface CreativeNextItem {
  readonly text: string
  readonly reason: string
  /** 测试锁定的原文，只给读屏，不作为第一眼。 */
  readonly code?: string
}

/**
 * 门中文名（本视图刻意展示变体：一致性门/反 AI 味门/质量门，spec 锁定；
 * 键空间与 audit-taxonomy GateKey 一致，未知键回退原文。MINOR-5 定案）。
 */
const GATE_LABEL: Record<string, string> = {
  consistency: "一致性门",
  anti_ai: "反 AI 味门",
  quality: "质量门",
}

const VERDICT_LABEL: Record<DoctorVerdict, string> = {
  healthy: "健康",
  degraded: "退化",
  critical: "严重",
}

function verdictTone(verdict: DoctorVerdict): ReportTone {
  if (verdict === "critical") return "error"
  if (verdict === "degraded") return "warn"
  return "ok"
}

function findingTone(severity: string): ReportTone {
  if (severity === "error" || severity === "warn" || severity === "ok") return severity
  return "neutral"
}

/** 给写作者看的短句。诊断原文仍留在页面里，但不作为第一眼的句子。 */
const FINDING_PLAIN: Record<string, { readonly title: string; readonly body: string }> = {
  "status-json": { title: "会话状态", body: "写作状态文件还没建立" },
  "canon-dual-write": { title: "正式层双写", body: "正式保存还没有门控" },
  "fts-index": { title: "全文检索", body: "检索索引还没建好，重建后才能搜索" },
  "chapter-backups": { title: "章节备份", body: "还没有章节备份，第一次保存章节后会自动留下" },
  "budget-ledger": { title: "预算账本", body: "预算记录对不上" },
  "volume-arc": { title: "分卷", body: "分卷进度需要看一眼" },
  "fanfic-merge-pending": { title: "同人合并", body: "有一份同人合并还没确认" },
  "translation-drafts": { title: "翻译草稿", body: "翻译草稿还停在草稿区" },
  "play-graph": { title: "互动分支", body: "互动分支图有阻断" },
}

/**
 * 下一步建议纯函数（零 IO，确定性同输入同输出）。
 * 优先级：blockingGate 存在 → 先修该门；verdict critical → 先恢复健康；
 * meta null → 先初始化项目；否则继续当前任务。
 */
export function deriveCreativeNext(input: {
  readonly meta: NovelMeta
  readonly verdict: DoctorVerdict
  readonly blockingGate: BlockingGate
}): readonly CreativeNextItem[] {
  const items: CreativeNextItem[] = []
  if (input.blockingGate !== null) {
    const label = GATE_LABEL[input.blockingGate] ?? input.blockingGate
    items.push({
      text: `先修复被阻塞的门：${label}`,
      reason: "依据：这一门挡住了继续写。",
      code: `blockingGate=${input.blockingGate}`,
    })
  }
  if (input.verdict === "critical") {
    items.push({
      text: "先恢复项目健康：先处理诊断里的严重项",
      reason: "依据：诊断结论是严重问题。",
      code: "verdict=critical",
    })
  }
  if (input.meta === null) {
    items.push({
      text: "补全项目资料：书名、题材等元数据还没填",
      reason: "依据：项目元数据缺失（不影响写作）。",
      code: "meta=null",
    })
  }
  if (items.length === 0) {
    const tail =
      input.meta !== null && input.meta.currentChapter > 0
        ? `继续当前任务：第 ${input.meta.currentChapter} 章`
        : "继续当前任务"
    items.push({ text: tail, reason: "依据：项目已初始化且诊断无阻断" })
  }
  return items
}

export function CreativeHubView({ projectPath }: CreativeHubViewProps) {
  const [meta, setMeta] = useState<NovelMeta | undefined>(undefined)
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [snapshot, setSnapshot] = useState<EvidenceSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fillingMeta, setFillingMeta] = useState(false)
  const [fillError, setFillError] = useState<string | null>(null)

  // 批次三·13：元数据缺失时一键补默认值（书名取文件夹名），写完重读；只写 .novel/project-meta.json。
  const fillMeta = async () => {
    setFillingMeta(true)
    setFillError(null)
    try {
      const folder = projectPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "未命名作品"
      await saveNovelProjectMeta(projectPath, createDefaultNovelProjectMeta(folder))
      setMeta(await loadNovelProjectMeta(projectPath))
    } catch (err) {
      setFillError(toErrorMessage(err))
    } finally {
      setFillingMeta(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    if (!projectPath) {
      setLoadError("项目路径为空，无法装载创作中枢")
      return
    }
    setLoadError(null)
    void (async () => {
      try {
        // 串行一次装载（只读，不写盘；无需轮询）。
        const loadedMeta = await loadNovelProjectMeta(projectPath)
        const loadedReport = await runProjectDoctor(projectPath)
        const ledger = await loadRunEventLedgerStore(createFsRunEventLedgerStoreDeps(), projectPath)
        const loadedSnapshot = buildDashboardEvidenceSnapshot(ledger)
        if (cancelled) return
        setMeta(loadedMeta)
        setReport(loadedReport)
        setSnapshot(loadedSnapshot)
      } catch (err) {
        if (cancelled) return
        setLoadError(toErrorMessage(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const ready = meta !== undefined && report !== null && snapshot !== null
  const next: readonly CreativeNextItem[] =
    ready && report !== null && snapshot !== null
      ? deriveCreativeNext({ meta, verdict: report.verdict, blockingGate: snapshot.blockingGate })
      : []
  const hasGateEvents = snapshot !== null && snapshot.cards.some((card) => card.hasEvent)
  const isZeroData = ready && meta === null && !hasGateEvents
  const problems =
    report === null ? [] : report.findings.filter((finding) => finding.severity === "error" || finding.severity === "warn")
  const okCount = report === null ? 0 : report.findings.length - problems.length

  return (
    <ReportPage
      testId="creative-hub-view"
      title="创作中枢"
      description="查看项目资料、诊断和检查结果。本页只在你点「补全项目资料」时写入元数据，不改正文。"
    >
      {loadError !== null ? (
        <ReportCallout testId="creative-load-error" tone="error">
          装载失败：{loadError}
        </ReportCallout>
      ) : !ready || report === null || snapshot === null ? (
        <p className="text-sm text-muted-foreground">加载中……</p>
      ) : (
        <>
          <ReportSection title="下一步">
            <ul className="space-y-2">
              {next.map((item, index) => (
                <li
                  key={`${item.code ?? item.text.slice(0, 32)}-${index}`}
                  data-testid="creative-next"
                  className={cn(
                    "rounded-md border px-3 py-2",
                    index === 0 ? "border-border bg-card" : "border-transparent",
                  )}
                >
                  <span className={cn("block", index === 0 ? "text-base font-medium" : "text-sm")}>
                    {item.text}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    ——{item.reason}
                    {item.code ? <span className="sr-only">{item.code}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </ReportSection>
          {isZeroData ? (
            <ReportCallout testId="creative-empty" tone="neutral">
              暂无项目数据：项目资料未填写，也还没跑过检查。
            </ReportCallout>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <ReportSection testId="creative-diagnosis" title="诊断">
              <p className={cn("rounded-md border px-3 py-2 text-base font-medium", reportToneClass(verdictTone(report.verdict)))}>
                {VERDICT_LABEL[report.verdict]}
                <span className="sr-only">（{report.verdict}）</span>
              </p>
              <p
                className={cn(
                  "rounded-md border px-3 py-2",
                  reportToneClass(snapshot.blocked ? "error" : "ok"),
                )}
              >
                门控：
                {snapshot.blocked && snapshot.blockingGate !== null
                  ? `被${GATE_LABEL[snapshot.blockingGate] ?? snapshot.blockingGate}阻塞`
                  : "无阻塞"}
              </p>
            </ReportSection>
            <ReportSection testId="creative-binding" title="小说状态">
              {meta !== null ? (
                <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1">
                  <dt className="text-muted-foreground">标题</dt>
                  <dd>{meta.title}</dd>
                  <dt className="text-muted-foreground">题材</dt>
                  <dd>{meta.genre === "" ? "未填写" : meta.genre}</dd>
                  <dt className="text-muted-foreground">进度</dt>
                  <dd>
                    第 {meta.currentChapter} 章 / 共 {meta.totalChapters} 章（{meta.totalWords} 字）
                  </dd>
                </dl>
              ) : (
                <div className="space-y-2">
                  <ReportCallout tone="warn">项目元数据缺失（不影响写作），尚未初始化书名、题材等资料。</ReportCallout>
                  <button
                    type="button"
                    data-testid="creative-fill-meta"
                    disabled={fillingMeta}
                    onClick={() => void fillMeta()}
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50"
                  >
                    {fillingMeta ? "写入中…" : "补全项目资料"}
                  </button>
                  {fillError ? <p className="text-sm text-destructive">补全失败：{fillError}</p> : null}
                </div>
              )}
            </ReportSection>
          </div>
          <ReportSection title="需要处理">
            {problems.length === 0 ? (
              <p className="text-muted-foreground">没有需要立刻处理的诊断</p>
            ) : (
              <ul className="space-y-2">
                {problems.map((finding) => (
                  <li
                    key={finding.id}
                    className={cn("rounded-md border px-3 py-2", reportToneClass(findingTone(finding.severity)))}
                  >
                    <span className="font-medium">{FINDING_PLAIN[finding.id]?.title ?? finding.name}</span>
                    <span className="sr-only">{finding.name}（{finding.severity}）</span>
                    <span className="mt-0.5 block">{FINDING_PLAIN[finding.id]?.body ?? finding.message}</span>
                    <span className="sr-only">{finding.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {okCount > 0 ? (
              <p className="text-xs text-muted-foreground">{okCount} 项正常，已收起</p>
            ) : report.findings.length === 0 ? (
              <p className="text-muted-foreground">暂无诊断发现</p>
            ) : null}
          </ReportSection>
        </>
      )}
    </ReportPage>
  )
}
