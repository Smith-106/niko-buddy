// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * pipeline-motion-panel.tsx — 「管線動態」面板（只讀，深色终端拓扑大屏）。
 *
 * 回答「工作正跑到哪一步」：把 projectPipelineMotion 的投影畫成深色
 * 工業駕駛艙風格的正交拓撲（目標 → 定稿 → 回流），藍色當前路徑只跟真實事件。
 *
 * 誠實口徑（死守契约）：零事件且未開回放/演示時顯示空態（不畫一條灰管線
 * 假裝有跑）；返工計數為 0 的邊畫灰色虛線，不畫紅；統計條全部來自事件計數。
 * 既有 data-testid / data-state / data-hot / data-active 全部保留，單測照舊。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  PIPELINE_STAGES,
  REWORK_EDGES,
  projectPipelineMotion,
  type MotionNodeProjection,
  type PipelineMotionInput,
  type PipelineMotionProjection,
  type RunEvent,
} from "@/lib/novel"

export interface PipelineMotionPanelProps {
  /** 注入投影結果（測試可替換）。 */
  readonly projection?: PipelineMotionProjection
  /** 注入輸入（未給 projection 時用於計算）。 */
  readonly input?: PipelineMotionInput
}

const EMPTY_INPUT: PipelineMotionInput = { events: [], traceEntries: [] }

// ── 正交拓撲版式：6 層 × 列，主線自上而下折返 ────────────────────────────────
// 13 主階段按列排布（層 = 列）：L0 goal/evidence · L1 outline/chapter-plan ·
// L2 draft/self-gate · L3 review/review-gate · L4 revise/ingest · L5 deliver/reflow/retrospective。
// 外部依賴掛右側琥珀列。固定座標，節點數固定=15，不隨數據變化。

const COL_X = [120, 300, 480, 660, 840, 1020]
const EXT_X = 1180
const NODE_W = 120
const NODE_H = 30
const ROW_Y = [70, 170, 270, 370]

const LAYER_OF: Record<string, number> = {
  goal: 0,
  evidence: 0,
  outline: 1,
  "chapter-plan": 1,
  draft: 2,
  "self-gate": 2,
  review: 3,
  "review-gate": 3,
  revise: 4,
  ingest: 4,
  deliver: 5,
  reflow: 5,
  retrospective: 5,
}

const ROW_OF: Record<string, number> = {
  goal: 0,
  evidence: 2,
  outline: 0,
  "chapter-plan": 2,
  draft: 0,
  "self-gate": 2,
  review: 0,
  "review-gate": 2,
  revise: 0,
  ingest: 2,
  deliver: 0,
  reflow: 1,
  retrospective: 2,
}

function nodeXY(id: string): { x: number; y: number } {
  return { x: COL_X[LAYER_OF[id] ?? 0], y: ROW_Y[ROW_OF[id] ?? 1] }
}

const STATE_TEXT: Record<string, string> = {
  current: "#38bdf8",
  visited: "#94a3b8",
  idle: "#475569",
}

const STATE_STROKE: Record<string, string> = {
  current: "#38bdf8",
  visited: "#64748b",
  idle: "#334155",
}

const STATE_FILL: Record<string, string> = {
  current: "#0c2a3f",
  visited: "#0f172a",
  idle: "#0b1220",
}

/** 狀態字形雙編碼：色盲用戶不靠顏色也能區分（▶ 進行中 / ● 已走過 / ○ 未到）。 */
function stateGlyph(state: MotionNodeProjection["state"]): string {
  return state === "current" ? "▶" : state === "visited" ? "●" : "○"
}

// ── 審查維度芯片條（review / self-gate 區域下方，靜態裝飾不碰契约） ──────────
const REVIEW_DIMS = ["爽感", "自洽", "節奏", "人設", "銜接", "追讀", "認知", "Canon", "AI味"]

// ── 示例演示事件流（取證→生成→審稿門觸發返修→v2通過→記憶入庫→回流） ─────────
const DEMO_TS = "2026-10-19T00:00:00.000Z"
function demoEvents(): RunEvent[] {
  let seq = 0
  const ev = (kind: RunEvent["kind"], extra?: Partial<RunEvent>): RunEvent =>
    ({ seq: seq++, eventId: `demo:${seq}`, ts: DEMO_TS, actor: "system", kind, ...extra }) as RunEvent
  return [
    ev("retrieval"),
    ev("generate"),
    ev("gate-run", { actor: "system", payload: { gate: "consistency", pass: false } }),
    ev("retry"),
    ev("generate"),
    ev("gate-run", { actor: "system", payload: { gate: "consistency", pass: true } }),
    ev("accept"),
    ev("stage"),
  ]
}

// ── KPI 卡片（底部彩色進度細條） ─────────────────────────────────────────────
function KpiCard({ label, value, tone, max }: { label: string; value: number; tone: string; max: number }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="text-lg font-bold tabular-nums text-slate-100">{value}</div>
      <div className="mt-1 h-0.5 w-full bg-slate-800">
        <div className="h-0.5" style={{ width: `${Math.round(ratio * 100)}%`, background: tone }} />
      </div>
    </div>
  )
}

function ReworkPath({ from, to, active, lane }: { from: string; to: string; active: boolean; lane: number }): React.ReactElement {
  const a = nodeXY(from)
  const b = nodeXY(to)
  // 右側正交返工環：從起點右出 → 返工專用通道 x → 終點右入。
  const x = Math.max(a.x, b.x) + NODE_W / 2 + lane
  const color = active ? "#f85149" : "#334155"
  const d = `M ${a.x + NODE_W / 2} ${a.y} H ${x} V ${b.y} H ${b.x + NODE_W / 2}`
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={active ? 2.5 : 1.5}
        strokeDasharray={active ? undefined : "4 3"}
        data-testid={`motion-rework-${from}-${to}`}
        data-active={active ? "true" : "false"}
        className={active ? "motion-glow-red" : undefined}
      />
      {active ? (
        <circle r="4" fill="#f85149" className="motion-pulse-dot">
          <animateMotion dur="1.4s" repeatCount="indefinite" path={d} />
        </circle>
      ) : null}
    </g>
  )
}

function MotionNode({ node }: { node: MotionNodeProjection }): React.ReactElement {
  const { x, y } = nodeXY(node.id)
  const stroke = STATE_STROKE[node.state]
  const fill = STATE_FILL[node.state]
  const testId = `motion-node-${node.id}`
  if (node.kind === "decision") {
    const w = NODE_W / 2
    const h = NODE_H / 2 + 6
    return (
      <g data-testid={testId} data-state={node.state}>
        <polygon
          points={`${x},${y - h} ${x + w},${y} ${x},${y + h} ${x - w},${y}`}
          fill={fill}
          stroke={stroke}
          strokeWidth={node.state === "current" ? 2.5 : 1.5}
          className={node.state === "current" ? "motion-glow" : undefined}
        />
        <text x={x} y={y + 4} textAnchor="middle" fontSize="12" fill={STATE_TEXT[node.state]}>
          {stateGlyph(node.state)} ◆ {node.label}
        </text>
      </g>
    )
  }
  return (
    <g data-testid={testId} data-state={node.state}>
      <rect
        x={x - NODE_W / 2}
        y={y - NODE_H / 2}
        width={NODE_W}
        height={NODE_H}
        rx={5}
        fill={fill}
        stroke={stroke}
        strokeWidth={node.state === "current" ? 2.5 : 1.5}
        className={node.state === "current" ? "motion-glow" : undefined}
      />
      <text x={x} y={y + 4} textAnchor="middle" fontSize="12" fill={STATE_TEXT[node.state]}>
        {node.kind === "terminal" ? `${stateGlyph(node.state)} ■ ${node.label}` : `${stateGlyph(node.state)} ${node.label}`}
      </text>
    </g>
  )
}

function ExternalNode({ node, row }: { node: MotionNodeProjection; row: number }): React.ReactElement {
  const lit = node.state !== "idle"
  const stroke = lit ? "#f59e0b" : "#334155"
  const text = lit ? "#f59e0b" : "#475569"
  return (
    <g data-testid={`motion-node-${node.id}`} data-state={node.state}>
      <line x1={EXT_X - 62} y1={ROW_Y[row]} x2={EXT_X - 62} y2={ROW_Y[row]} stroke={stroke} strokeWidth={1} strokeDasharray="4 3" />
      <rect
        x={EXT_X - 62}
        y={ROW_Y[row] - NODE_H / 2}
        width={124}
        height={NODE_H}
        rx={5}
        fill="#0b1220"
        stroke={stroke}
        strokeWidth={1.5}
        className={lit ? "motion-glow-amber" : undefined}
      />
      <text x={EXT_X} y={ROW_Y[row] + 4} textAnchor="middle" fontSize="12" fill={text}>
        {stateGlyph(node.state)} ◇ {node.label}
      </text>
    </g>
  )
}

// ── log 行：時間戳 + 彩色階段標籤 + 摘要 + 右側階段分組 ──────────────────────
function logToneColor(tone: string): string {
  return tone === "error" ? "#f87171" : tone === "rework" ? "#f59e0b" : tone === "pass" ? "#34d399" : "#94a3b8"
}

function phaseGroup(label: string): string {
  if (/retriev|evidence|取證|goal|目標/.test(label)) return "開場"
  if (/generat|draft|outline|plan|正文|大綱|章綱|生成/.test(label)) return "派活"
  if (/gate|review|critic|revise|返修|審/.test(label)) return "審校"
  return "完結"
}

const STAGE_CAPSULES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "goal", label: "目標" },
  { id: "evidence", label: "取證" },
  { id: "outline", label: "大綱" },
  { id: "chapter-plan", label: "章綱" },
  { id: "draft", label: "正文" },
  { id: "self-gate", label: "自檢門" },
  { id: "review", label: "審稿" },
  { id: "revise", label: "返修" },
  { id: "ingest", label: "入庫" },
  { id: "reflow", label: "回流" },
]

export function PipelineMotionPanel({ projection, input }: PipelineMotionPanelProps) {
  const baseResolved = useMemo<PipelineMotionProjection>(
    () => projection ?? projectPipelineMotion(input ?? EMPTY_INPUT),
    [input, projection],
  )

  // ── 回放 / 演示 ──
  const [replaying, setReplaying] = useState(false)
  const [frame, setFrame] = useState(0)
  const [demoMode, setDemoMode] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sourceEvents = useMemo<readonly RunEvent[]>(() => {
    if (projection) return []
    if (input?.events && input.events.length > 0) return input.events
    return []
  }, [input, projection])
  const demoEvts = useMemo(() => demoEvents(), [])
  // activeEvents：回放用賬本前 frame+1 條；演示用 demo 流；靜態用全量。
  const activeEvents = useMemo(() => {
    if (replaying && !demoMode) return sourceEvents.slice(0, frame + 1)
    if (replaying && demoMode) return demoEvts.slice(0, frame + 1)
    return null
  }, [replaying, demoMode, frame, sourceEvents, demoEvts])
  const resolved = useMemo<PipelineMotionProjection>(() => {
    if (!replaying || !activeEvents) return baseResolved
    return projectPipelineMotion({ events: activeEvents, traceEntries: input?.traceEntries ?? [] })
  }, [replaying, activeEvents, baseResolved, input])

  const stopReplay = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setReplaying(false)
    setDemoMode(false)
    setFrame(0)
  }, [])

  useEffect(() => () => {
    if (timerRef.current !== null) clearInterval(timerRef.current)
  }, [])

  const toggleReplay = useCallback(() => {
    if (replaying) {
      stopReplay()
      return
    }
    const useDemo = sourceEvents.length === 0
    const total = useDemo ? demoEvts.length : sourceEvents.length
    if (total === 0) return
    setDemoMode(useDemo)
    setFrame(0)
    setReplaying(true)
    timerRef.current = setInterval(() => {
      setFrame((f) => {
        if (f + 1 >= total) {
          if (timerRef.current !== null) {
            clearInterval(timerRef.current)
            timerRef.current = null
          }
          return f
        }
        return f + 1
      })
    }, 700)
  }, [replaying, sourceEvents, demoEvts, stopReplay])

  const showingDemo = replaying && demoMode
  // 空態口徑：零事件且未開回放/演示 → 空態（演示開即有圖，不算空）。
  const isEmpty = !resolved.checked && !replaying

  const { counts, hotEdge } = resolved
  const currentNode =
    [...resolved.nodes, ...resolved.externals].find((node) => node.state === "current") ?? null
  const lastLog = resolved.log.length > 0 ? resolved.log[resolved.log.length - 1] : null
  const maxCount = Math.max(1, counts.events, counts.evidence, counts.generated, counts.gates, counts.passed, counts.reworks, counts.accepts, counts.chapters)

  const isHotEdge = (from: string, to: string): boolean =>
    !!hotEdge && hotEdge.from === from && hotEdge.to === to

  // 主線正交邊：同列縱連 + 跨列折線（L 形），hot 邊發光。
  const trunkEdges: Array<{ key: string; d: string; hot: boolean; index: number }> = []
  for (let i = 1; i < PIPELINE_STAGES.length; i += 1) {
    const prev = PIPELINE_STAGES[i - 1]
    const cur = PIPELINE_STAGES[i]
    const a = nodeXY(prev.id)
    const b = nodeXY(cur.id)
    const hot = isHotEdge(prev.id, cur.id)
    let d: string
    if (a.x === b.x) {
      d = `M ${a.x} ${a.y + NODE_H / 2} V ${b.y - NODE_H / 2}`
    } else {
      const midX = (a.x + b.x) / 2
      d = `M ${a.x + NODE_W / 2} ${a.y} H ${midX} V ${b.y} H ${b.x - NODE_W / 2}`
    }
    trunkEdges.push({ key: `${prev.id}->${cur.id}`, d, hot, index: i })
  }

  return (
    <section
      data-testid="pipeline-motion-panel"
      className="overflow-x-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-slate-100"
    >
      <style>{`.motion-glow{filter:drop-shadow(0 0 6px rgba(56,189,248,.65))}.motion-glow-red{filter:drop-shadow(0 0 6px rgba(248,81,73,.75))}.motion-glow-amber{filter:drop-shadow(0 0 6px rgba(245,158,11,.6))}.motion-pulse-dot{filter:drop-shadow(0 0 6px currentColor)}`}</style>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-center text-sm font-semibold tracking-widest text-slate-100">
            NIKO-BUDDY · 完整寫作管線 · 目標 → 定稿 → 回流
          </h3>
          <button
            type="button"
            data-testid="motion-replay-toggle"
            onClick={toggleReplay}
            className="ml-auto rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            {replaying ? "■ 停止回放" : "▶ 流程回放 / 步進演示"}
          </button>
        </div>
        {showingDemo ? (
          <p data-testid="motion-demo-note" className="text-center text-xs text-amber-400">
            演示模式：內置示例事件流（取證→生成→審稿門返修→v2通過→入庫→回流），退出恢復原狀
          </p>
        ) : null}
        <div
          data-testid="motion-legend"
          className="flex flex-wrap items-center justify-center gap-3 text-xs text-slate-400"
        >
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#38bdf8]" />當前路徑</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#f59e0b]" />外部依賴</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#f87171]" />↩ 返工循環</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#34d399]" />記憶回流</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#475569]" />○ 其餘環節（● 已走過）</span>
        </div>
        {/* KPI 數字卡片矩陣（帶底部彩色進度細條） */}
        <div data-testid="motion-kpis" className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
          <KpiCard label="事件" value={counts.events} tone="#38bdf8" max={maxCount} />
          <KpiCard label="取證" value={counts.evidence} tone="#38bdf8" max={maxCount} />
          <KpiCard label="生成" value={counts.generated} tone="#38bdf8" max={maxCount} />
          <KpiCard label="門禁" value={counts.gates} tone="#a78bfa" max={maxCount} />
          <KpiCard label="通過" value={counts.passed} tone="#34d399" max={maxCount} />
          <KpiCard label="返工" value={counts.reworks} tone="#f87171" max={maxCount} />
          <KpiCard label="入庫章節" value={counts.chapters} tone="#34d399" max={maxCount} />
        </div>
        {/* 契约統計條：完整文本保留，兼容既有單測配對 */}
        <p data-testid="motion-stats" className="text-center text-xs text-slate-400">
          事件 <b className="text-slate-100">{counts.events}</b>
          {" · "}取證 <b className="text-slate-100">{counts.evidence}</b>
          {" · "}生成 <b className="text-slate-100">{counts.generated}</b>
          {" · "}門運行 <b className="text-slate-100">{counts.gates}</b>
          {" · "}通過 <b className="text-slate-100">{counts.passed}</b>
          {" · "}返工 <b className="text-red-400">{counts.reworks}</b>
          {" · "}接收 <b className="text-slate-100">{counts.accepts}</b>
          {" · "}錯誤 <b className="text-red-400">{counts.errors}</b>
          {" · "}章節 <b className="text-slate-100">{counts.chapters}</b>
        </p>
      </header>

      {isEmpty ? (
        <p data-testid="motion-empty" className="py-8 text-center text-xs text-slate-500">
          尚無運行事件：主控跑過一次章節工作流，藍色當前路徑才會亮起（不播演示動畫）。
        </p>
      ) : (
        <svg
          data-testid="motion-diagram"
          viewBox="0 0 1320 440"
          className="mx-auto block w-full min-w-[640px]"
          role="img"
          aria-label="寫作管線動態圖"
        >
          {trunkEdges.map((edge) => (
            <g key={edge.key}>
              <path
                d={edge.d}
                fill="none"
                stroke={edge.hot ? "#38bdf8" : "#334155"}
                strokeWidth={edge.hot ? 2.5 : 1.5}
                data-testid={`motion-edge-${edge.index}`}
                data-hot={edge.hot ? "true" : "false"}
                className={edge.hot ? "motion-glow" : undefined}
              />
              {edge.hot ? (
                <circle r="4" fill="#38bdf8" className="motion-pulse-dot">
                  <animateMotion dur="1.2s" repeatCount="indefinite" path={edge.d} />
                </circle>
              ) : null}
            </g>
          ))}
          {REWORK_EDGES.map((edge) => (
            <ReworkPath
              key={`${edge.from}-${edge.to}`}
              from={edge.from}
              to={edge.to}
              active={(resolved.reworkCounts[`${edge.from}->${edge.to}`] ?? 0) > 0}
              lane={edge.from === "self-gate" ? 96 : 56}
            />
          ))}
          {/* 返工次數角標 */}
          {REWORK_EDGES.map((edge) => {
            const n = resolved.reworkCounts[`${edge.from}->${edge.to}`] ?? 0
            if (n <= 0) return null
            const a = nodeXY(edge.from)
            const x = Math.max(a.x, nodeXY(edge.to).x) + NODE_W / 2 + (edge.from === "self-gate" ? 96 : 56)
            return (
              <g key={`badge-${edge.from}-${edge.to}`}>
                <circle cx={x} cy={(a.y + nodeXY(edge.to).y) / 2} r="9" fill="#7f1d1d" stroke="#f87171" strokeWidth="1" />
                <text x={x} y={(a.y + nodeXY(edge.to).y) / 2 + 4} textAnchor="middle" fontSize="11" fill="#fecaca">
                  {n}
                </text>
              </g>
            )
          })}
          {resolved.nodes.map((node) => (
            <MotionNode key={node.id} node={node} />
          ))}
          {resolved.externals.map((node, i) => (
            <ExternalNode key={node.id} node={node} row={i === 0 ? 0 : 2} />
          ))}
          {/* 審查維度芯片條（review / self-gate 區域下方） */}
          <g data-testid="motion-review-dims">
            {REVIEW_DIMS.map((dim, i) => (
              <g key={dim}>
                <rect x={440 + i * 62} y={392} width={56} height={20} rx={10} fill="#0f172a" stroke="#334155" strokeWidth={1} />
                <text x={468 + i * 62} y={406} textAnchor="middle" fontSize="11" fill="#94a3b8">
                  {dim}
                </text>
              </g>
            ))}
          </g>
          {/* 記憶回流閉環：deliver → reflow → retrospective → goal（青綠色） */}
          <g data-testid="motion-reflow-loop">
            <path
              d={`M ${nodeXY("deliver").x} ${nodeXY("deliver").y + NODE_H / 2 + 8} H 1120 V 40 H ${nodeXY("goal").x} V ${nodeXY("goal").y - NODE_H / 2}`}
              fill="none"
              stroke="#34d399"
              strokeWidth={1.5}
              strokeDasharray="6 4"
            />
            <text x={1130} y={220} fontSize="11" fill="#34d399" transform="rotate(90 1130,220)" textAnchor="middle">
              記憶回流
            </text>
          </g>
        </svg>
      )}

      <div className="mt-2 border-t border-slate-800 pt-2">
        <p className="text-xs text-slate-500">session log</p>
        {(resolved.log.length === 0) ? (
          <p data-testid="motion-log-empty" className="text-xs text-slate-500">
            （空）
          </p>
        ) : (
          <ul data-testid="motion-log" className="max-h-36 space-y-0.5 overflow-y-auto rounded bg-black/40 p-2 text-xs">
            {resolved.log.slice(-8).map((entry, index) => (
              <li key={`${entry.ts}-${index}`} className="flex items-center gap-2">
                <span className="shrink-0 text-slate-500 tabular-nums">{entry.ts}</span>
                <span
                  className="shrink-0 rounded px-1"
                  style={{ color: logToneColor(entry.tone), border: `1px solid ${logToneColor(entry.tone)}55`, background: `${logToneColor(entry.tone)}11` }}
                >
                  {entry.tone}
                </span>
                <span className="truncate" style={{ color: logToneColor(entry.tone) }}>
                  {entry.label}
                </span>
                <span className="ml-auto shrink-0 text-slate-600">{phaseGroup(entry.label)}</span>
              </li>
            ))}
          </ul>
        )}
        {/* CLI 命令狀態欄：提示符 + 階段膠囊條 */}
        <div data-testid="motion-status" className="mt-1 flex flex-wrap items-center gap-1.5 rounded bg-black/40 px-2 py-1.5 text-xs text-slate-400">
          <span className="text-emerald-400">$</span>
          <span className="text-slate-300">niko-buddy pipeline --live</span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-500">階段</span>
          {STAGE_CAPSULES.map((cap) => {
            const active = currentNode?.id === cap.id
            return (
              <span
                key={cap.id}
                data-stage={cap.id}
                data-active={active ? "true" : "false"}
                className={active ? "rounded border border-sky-400/60 bg-sky-400/10 px-1 text-sky-300" : "rounded border border-slate-800 px-1 text-slate-500"}
              >
                [{cap.label}]
              </span>
            )
          })}
          <span className="ml-auto text-slate-500">
            {currentNode ? <>當前路徑 [{currentNode.label}]{lastLog ? ` · ${lastLog.label}` : ""}</> : <>未在運行{lastLog ? ` · 上次：${lastLog.label}` : ""}</>}
          </span>
        </div>
      </div>
    </section>
  )
}
