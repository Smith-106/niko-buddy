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
  createFsRunEventLedgerStoreDeps,
  loadNovelProjectMeta,
  loadRunEventLedgerStore,
  runProjectDoctor,
  type DoctorReport,
  type EvidenceSnapshot,
  type NovelProjectMeta,
} from "@/lib/novel"

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
      reason: `依据：门控快照 blockingGate=${input.blockingGate}`,
    })
  }
  if (input.verdict === "critical") {
    items.push({
      text: "先恢复项目健康：按诊断结论逐项修复 error 项",
      reason: "依据：诊断 verdict=critical",
    })
  }
  if (input.meta === null) {
    items.push({
      text: "先初始化项目：创建 project-meta 与会话状态",
      reason: "依据：项目元数据缺失（meta=null）",
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
        setLoadError(err instanceof Error ? err.message : String(err))
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

  return (
    <div data-testid="creative-hub-view">
      <h2>创作中枢</h2>
      {loadError !== null ? (
        <p data-testid="creative-load-error">装载失败：{loadError}</p>
      ) : !ready || report === null || snapshot === null ? (
        <p>加载中……</p>
      ) : (
        <>
          <section data-testid="creative-binding">
            <h3>小说状态绑定</h3>
            {meta !== null ? (
              <>
                <p>标题：{meta.title}</p>
                <p>题材：{meta.genre === "" ? "未填写" : meta.genre}</p>
                <p>
                  进度：第 {meta.currentChapter} 章 / 共 {meta.totalChapters} 章（{meta.totalWords} 字）
                </p>
              </>
            ) : (
              <p>项目尚未初始化：未找到 project-meta</p>
            )}
          </section>
          <section data-testid="creative-diagnosis">
            <h3>诊断结论</h3>
            <p>
              总体：{VERDICT_LABEL[report.verdict]}（{report.verdict}）
            </p>
            {report.findings.length === 0 ? (
              <p>暂无诊断发现</p>
            ) : (
              <ul>
                {report.findings.map((finding) => (
                  <li key={finding.id}>
                    {finding.name}：{finding.message}（{finding.severity}）
                  </li>
                ))}
              </ul>
            )}
            <p>
              门控：
              {snapshot.blocked && snapshot.blockingGate !== null
                ? `被${GATE_LABEL[snapshot.blockingGate] ?? snapshot.blockingGate}阻塞`
                : "无阻塞"}
            </p>
          </section>
          <section>
            <h3>下一步建议</h3>
            <ul>
              {next.map((item, index) => (
                <li key={index} data-testid="creative-next">
                  {item.text}——{item.reason}
                </li>
              ))}
            </ul>
          </section>
          {isZeroData ? (
            <p data-testid="creative-empty">暂无项目数据：尚未初始化，且暂无门控运行事件（诚实空态，不虚构进度）</p>
          ) : null}
        </>
      )}
    </div>
  )
}
