/**
 * context-pack-replay-panel.tsx — ContextPack 决策回放面板 (Roadmap Batch C6)
 *
 * 纯展示组件 (零副作用 / 零 I/O / 零状态变更)：输入单个 prop `pack`
 * (ContextPack，或其可序列化子集)，把一次 buildContextPack 的「决策轨迹」
 * 回放到三段时间线分区：
 *   ① 检索源   —— 本次装配实际入选的页 / chunk / 派生源 (入选/未入选)；
 *   ② 门控结果  —— consistency / anti-ai 两门 PASS/WARN 各附判定理由；
 *   ③ 最终节选  —— 最终组装节选 + contextUsage 分配 + gaps 回放 (IC-02)。
 *
 * morpheus trace「逐步可展开」理念：原生 <details>/<summary> 手风琴，
 * 默认折叠、逐段展开，无自定义状态、无对外回调，可快照断言。
 *
 * 门控口径 (对齐 audit-taxonomy.ts 的 GateKey 语义，仅作回放透视的代理判定，
 * 非生成文本机械审计)：
 *   - consistency：以核心一致性源 (时间线/人设/设定/正典) 是否灌入为代理；
 *   - anti-ai    ：以文风 / 语音风格指南 / 风格锚点是否注入为代理。
 * 生成文本真实审计见 control-sentinels / audit-taxonomy。
 *
 * 宿主集成说明 (本轮不改共享布局，仅建议宿主读位)：
 *   - 首选宿主：`src/components/chat/chat-panel.tsx` 两处 buildContextPack
 *     组装点 (约 1443 / 2067 行，contextPackToPrompt 前) —— 拿到 pack 后
 *     直接渲染 <ContextPackReplayPanel pack={contextPack} /> 即可。
 *   - 备选宿主：`src/components/novel/character-workstation-view.tsx`。
 *
 * MIT License — independently implemented.
 */
import type { ContextPack } from "@/lib/novel/context-engine"
import type { ContextUsage } from "@/lib/context-usage"
import { FileText } from "lucide-react"

export type GateStatus = "PASS" | "WARN"
export interface GateVerdict { key: "consistency" | "anti_ai"; label: string; status: GateStatus; reason: string }
export interface RetrievalSourceEntry { key: string; label: string; selected: boolean; excerpt: string }
interface PackReplay { sources: RetrievalSourceEntry[]; gates: GateVerdict[]; hasGaps: boolean; gapNotes: string[]; usage: ContextUsage | null; assemblyExcerpt: string }

const SOURCE_DEFS: { key: string; label: string; scalar: boolean }[] = [
  { key: "searchResults", label: "全文检索 searchResults", scalar: true },
  { key: "graphSearchResults", label: "图谱检索 graphSearchResults", scalar: true },
  { key: "relatedChapters", label: "四维反查 relatedChapters", scalar: true },
  { key: "references", label: "@ 引用检索 references", scalar: true },
  { key: "communitySummaries", label: "社区摘要 communitySummaries", scalar: true },
  { key: "recentSummaries", label: "近期摘要 recentSummaries", scalar: false },
  { key: "recentChapterContents", label: "最近正文分页 recentChapterContents", scalar: false },
]

function asText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  return String(value)
}
function clipPreview(text: string, max = 160): string {
  const t = text.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…`
}

export function buildPackReplay(pack: ContextPack | undefined | null): PackReplay {
  if (!pack) {
    return { sources: [], gates: [], hasGaps: false, gapNotes: [], usage: null, assemblyExcerpt: "" }
  }
  const sources: RetrievalSourceEntry[] = SOURCE_DEFS.map(({ key, label, scalar }) => {
    const raw = ((pack as unknown as Record<string, unknown>))[key]
    if (!scalar && Array.isArray(raw)) {
      const text = raw.filter((v): v is string => typeof v === "string").join(" / ")
      return { key, label, selected: text.length > 0, excerpt: clipPreview(text) }
    }
    const text = asText(raw)
    return { key, label, selected: text.length > 0, excerpt: clipPreview(text) }
  })

  const gapNotes: string[] = (pack.gaps ?? []).map(
    (g) => `[${g.type}/${g.reason}] ${g.ref}: retained ${g.retainedLength}/${g.originalLength} chars`,
  )
  const hasGaps = gapNotes.length > 0

  const consistencyCore: [string, string][] = [
    ["timeline", "时间线 timeline"],
    ["characterStates", "人设状态 characterStates"],
    ["canonRules", "正典规则 canonRules"],
    ["relatedSettings", "相关设定 relatedSettings"],
  ]
  const missingCore: string[] = []
  for (const [field, label] of consistencyCore) {
    if (!(((pack as unknown as Record<string, unknown>))[field] as string | undefined)?.trim()) missingCore.push(label)
  }
  const consistencyGate: GateVerdict = {
    key: "consistency",
    label: "设定一致性",
    status: missingCore.length === 0 ? "PASS" : "WARN",
    reason: missingCore.length === 0
      ? "时间线 / 人设 / 设定 / 正典核心源均已灌入"
      : `缺失核心一致性源：${missingCore.join("、")}`,
  }

  const styleSignal =
    Boolean(pack.writingStyle?.trim()) ||
    Boolean(pack.voiceStyleGuide?.trim()) ||
    (pack.styleExemplars && pack.styleExemplars.length > 0)
  const antiAiGate: GateVerdict = {
    key: "anti_ai",
    label: "反 AI 味",
    status: styleSignal ? "PASS" : "WARN",
    reason: styleSignal
      ? "文风 / 语音风格指南 / 风格锚点已注入，作为反 AI 味正向约束"
      : "缺少文风签名 / 风格锚点，无正向反 AI 味引导",
  }

  const gates: GateVerdict[] = [consistencyGate, antiAiGate]
  const assemblyExcerpt = buildAssemblyExcerpt(pack)
  return { sources, gates, hasGaps, gapNotes, usage: pack.contextUsage ?? null, assemblyExcerpt }
}

function buildAssemblyExcerpt(pack: ContextPack): string {
  const sections: string[] = []
  if (pack.chapterGoal?.trim()) sections.push(`章纲目标：${pack.chapterGoal.trim()}`)
  if (pack.previousChapterEnding?.trim()) sections.push(`上一章结尾：${pack.previousChapterEnding.trim()}`)
  if (pack.mustDo?.trim()) sections.push(`必须做到：${pack.mustDo.trim()}`)
  if (pack.mustAvoid?.trim()) sections.push(`必须避免：${pack.mustAvoid.trim()}`)
  if (sections.length === 0) return ""
  return clipPreview(sections.join("\n"), 420)
}

interface ContextPackReplayPanelProps { pack: ContextPack | null; title?: string }

export function ContextPackReplayPanel({ pack, title = "ContextPack 决策回放" }: ContextPackReplayPanelProps) {
  const replay = buildPackReplay(pack)
  const selectedCount = replay.sources.filter((s) => s.selected).length
  return (
    <section
      data-testid="context-pack-replay-panel"
      className="flex flex-col gap-3 rounded-lg border bg-background p-4 text-sm"
      aria-label={title}
    >
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold">
          <FileText className="h-4 w-4 text-primary" />
          {title}
        </div>
        {pack && (
          <span className="text-xs text-muted-foreground" data-selected-count>
            收录 {selectedCount} 源
          </span>
        )}
      </header>

      {!pack ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-empty-panel>
          无 ContextPack 数据 —— 尚未完成一次装配。
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <ZoneTitle>① 检索源 —— 本次入选的页 / chunk</ZoneTitle>
          {replay.sources.map((s) => (
            <details key={s.key} className="group rounded-md border px-3 py-2" data-testid={`source-${s.key}`}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2" data-testid={`source-toggle-${s.key}`} role="button">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${s.selected ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground"}`}
                    data-source-status={s.key}
                  >
                    {s.selected ? "入选" : "未入选"}
                  </span>
                  <span className="truncate">{s.label}</span>
                </span>
                <span className="text-xs text-muted-foreground">▸</span>
              </summary>
              <p className="mt-2 border-t pt-2 text-xs leading-5 text-muted-foreground break-words" data-source-detail={s.key}>
                {s.selected ? s.excerpt || "（该源已入选，预览为空）" : "装配时未注入该源。"}
              </p>
            </details>
          ))}
          <ZoneTitle>② 门控结果（consistency / anti-ai）</ZoneTitle>
          {replay.gates.map((g) => (
            <div key={g.key} className="flex items-start justify-between gap-2 rounded-md border px-3 py-2" data-gate={g.key}>
              <div className="min-w-0">
                <div className="font-medium">
                  {g.label}<span className="ml-1 text-xs font-normal text-muted-foreground">({g.key})</span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">{g.reason}</div>
              </div>
              <span
                data-testid={`gate-${g.key}`}
                className={`shrink-0 rounded px-2 py-0.5 font-semibold ${g.status === "PASS" ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"}`}
              >
                {g.status}
              </span>
            </div>
          ))}
          <ZoneTitle>③ 最终组装节选</ZoneTitle>
          {replay.assemblyExcerpt ? (
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
              {replay.assemblyExcerpt}
            </pre>
          ) : (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">无组装节选内容。</p>
          )}
          {replay.usage && (
            <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground" data-usage>
              <span className="rounded bg-muted/60 px-2 py-1">记忆 {replay.usage.memoryChars} chars</span>
              <span className="rounded bg-muted/60 px-2 py-1">检索 {replay.usage.retrievalChars} chars</span>
              <span className="rounded bg-muted/60 px-2 py-1">图谱 {replay.usage.graphChars} chars</span>
              <span className="rounded bg-muted/60 px-2 py-1">正文 {replay.usage.bodyChars} chars</span>
              <span className="rounded bg-muted/60 px-2 py-1">其他 {replay.usage.otherChars} chars</span>
            </div>
          )}
          {replay.hasGaps && (
            <div
              data-gaps
              className="rounded-md border border-dashed px-3 py-2"
            >
              <div className="text-xs text-muted-foreground">压缩/截断/加载失败 (gaps)</div>
              <ul className="mt-1 list-disc pl-4">
                {replay.gapNotes.map((n, i) => (
                  <li key={i} className="text-xs text-muted-foreground">{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function ZoneTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}
