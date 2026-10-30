// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * pipeline-motion-panel.tsx — 「管线动态」面板（只读，深色终端拓扑大屏）。
 *
 * 回答「工作正跑到哪一步」：把 projectPipelineMotion 的投影画成深色
 * 工业驾驶舱风格的正交拓扑（目标 → 定稿 → 回流），蓝色当前路径只跟真实事件。
 *
 * 诚实口径（死守契约）：零事件且未开回放/演示时显示空态（不画一条灰管线
 * 假装有跑）；返工计数为 0 的边画灰色虚线，不画红；统计条全部来自事件计数。
 * 既有 data-testid / data-state / data-hot / data-active 全部保留，单测照旧。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  REWORK_EDGES,
  projectPipelineMotion,
  type MotionNodeProjection,
  type PipelineMotionInput,
  type PipelineMotionProjection,
  type RunEvent,
} from "@/lib/novel"

export interface PipelineMotionPanelProps {
  /** 注入投影结果（测试可替换）。 */
  readonly projection?: PipelineMotionProjection
  /** 注入输入（未给 projection 时用于计算）。 */
  readonly input?: PipelineMotionInput
}

const EMPTY_INPUT: PipelineMotionInput = { events: [], traceEntries: [] }

// ── 自上而下分层正交拓扑：7 层纵向主干 + 左右外挂 + 右侧双回路 ───────────────
// L1 goal→evidence · L2 outline→chapter-plan（左挂 knowledge-base）·
// L3 draft（左/右挂 model-router）· L4 self-gate→review · L5 审查维度芯片条 ·
// L6 review-gate→ingest（右侧红色返工走廊）· L7 ingest→deliver→reflow→retrospective。
// 外部依赖挂左右琥珀列。固定座标，节点数固定=15，不随数据变化。

const NODE_W = 120
const NODE_H = 30

const NODE_XY: Record<string, { x: number; y: number }> = {
  goal: { x: 360, y: 60 },
  evidence: { x: 640, y: 60 },
  outline: { x: 360, y: 145 },
  "chapter-plan": { x: 640, y: 145 },
  draft: { x: 500, y: 230 },
  "self-gate": { x: 360, y: 315 },
  review: { x: 640, y: 315 },
  "review-gate": { x: 500, y: 455 },
  revise: { x: 940, y: 455 },
  ingest: { x: 500, y: 545 },
  deliver: { x: 360, y: 625 },
  reflow: { x: 640, y: 625 },
  retrospective: { x: 880, y: 625 },
  "model-router": { x: 130, y: 230 },
  "knowledge-base": { x: 130, y: 145 },
}

function nodeXY(id: string): { x: number; y: number } {
  return NODE_XY[id] ?? { x: 500, y: 60 }
}

/** 主干正交边：同列纵连画竖线，异列画自上而下的 L 形（上出下入）。 */
function trunkPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  if (a.x === b.x) {
    return `M ${a.x} ${a.y + NODE_H / 2} V ${b.y - NODE_H / 2}`
  }
  const outY = a.y + NODE_H / 2
  const inY = b.y - NODE_H / 2
  const midY = (outY + inY) / 2
  return `M ${a.x} ${outY} V ${midY} H ${b.x} V ${inY}`
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

/** 状态字形双编码：色盲用户不靠颜色也能区分（▶ 进行中 / ● 已走过 / ○ 未到）。 */
function stateGlyph(state: MotionNodeProjection["state"]): string {
  return state === "current" ? "▶" : state === "visited" ? "●" : "○"
}

// ── 审查维度芯片条（review / self-gate 区域下方，静态装饰不碰契约） ──────────
const REVIEW_DIMS = ["爽感", "自洽", "节奏", "人设", "衔接", "追读", "认知", "Canon", "AI味"]

// ── 示例演示事件流（取证→生成→审稿门触发返修→v2通过→记忆入库→回流） ─────────
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

// ── KPI 卡片（底部彩色进度细条） ─────────────────────────────────────────────
function KpiCard({ label, value, tone, max }: { label: string; value: number; tone: string; max: number }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0
  return (
    <div className="rounded border border-border bg-card px-2 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-bold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 h-0.5 w-full bg-muted">
        <div className="h-0.5" style={{ width: `${Math.round(ratio * 100)}%`, background: tone }} />
      </div>
    </div>
  )
}

function ReworkPath({ from, to, active, lane }: { from: string; to: string; active: boolean; lane: number }): React.ReactElement {
  const a = nodeXY(from)
  const b = nodeXY(to)
  // 右侧正交返工环：从起点右出 → 返工专用通道 x → 终点右入。
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

function ExternalNode({ node, tos }: { node: MotionNodeProjection; tos: readonly string[] }): React.ReactElement {
  const { x, y } = nodeXY(node.id)
  const lit = node.state !== "idle"
  const stroke = lit ? "#f59e0b" : "#334155"
  const text = lit ? "#f59e0b" : "#475569"
  return (
    <g data-testid={`motion-node-${node.id}`} data-state={node.state}>
      {tos.map((to) => {
        const t = nodeXY(to)
        const d = x < t.x
          ? `M ${x + NODE_W / 2} ${y} H ${(x + NODE_W / 2 + (t.x - NODE_W / 2)) / 2} V ${t.y} H ${t.x - NODE_W / 2}`
          : `M ${x - NODE_W / 2} ${y} H ${(x - NODE_W / 2 + (t.x + NODE_W / 2)) / 2} V ${t.y} H ${t.x + NODE_W / 2}`
        return (
          <path
            key={to}
            d={d}
            fill="none"
            stroke={stroke}
            strokeWidth={lit ? 2 : 1.25}
            strokeDasharray="5 4"
            className={lit ? "motion-glow-amber" : undefined}
          />
        )
      })}
      <rect
        x={x - NODE_W / 2}
        y={y - NODE_H / 2}
        width={NODE_W}
        height={NODE_H}
        rx={5}
        fill="#0b1220"
        stroke={stroke}
        strokeWidth={1.5}
        className={lit ? "motion-glow-amber" : undefined}
      />
      <text x={x} y={y + 4} textAnchor="middle" fontSize="12" fill={text}>
        {stateGlyph(node.state)} ◇ {node.label}
      </text>
    </g>
  )
}

// ── log 行：时间戳 + 彩色阶段标签 + 摘要 + 右侧阶段分组 ──────────────────────
function logToneColor(tone: string): string {
  return tone === "error" ? "#f87171" : tone === "rework" ? "#f59e0b" : tone === "pass" ? "#34d399" : "#94a3b8"
}

function phaseGroup(label: string): string {
  if (/retriev|evidence|取证|goal|目标/.test(label)) return "开场"
  if (/generat|draft|outline|plan|正文|大纲|章纲|生成/.test(label)) return "派活"
  if (/gate|review|critic|revise|返修|审/.test(label)) return "审校"
  return "完结"
}

const STAGE_CAPSULES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "goal", label: "目标" },
  { id: "evidence", label: "取证" },
  { id: "outline", label: "大纲" },
  { id: "chapter-plan", label: "章纲" },
  { id: "draft", label: "正文" },
  { id: "self-gate", label: "自检门" },
  { id: "review", label: "审稿" },
  { id: "revise", label: "返修" },
  { id: "ingest", label: "入库" },
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
  const [finished, setFinished] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sourceEvents = useMemo<readonly RunEvent[]>(() => {
    if (projection) return []
    if (input?.events && input.events.length > 0) return input.events
    return []
  }, [input, projection])
  const demoEvts = useMemo(() => demoEvents(), [])
  // activeEvents：回放用账本前 frame+1 条；演示用 demo 流；静态用全量。
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
    setFinished(false)
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
    setFinished(false)
    setReplaying(true)
    timerRef.current = setInterval(() => {
      setFrame((f) => {
        if (f + 1 >= total) {
          if (timerRef.current !== null) {
            clearInterval(timerRef.current)
            timerRef.current = null
          }
          setFinished(true)
          return f
        }
        return f + 1
      })
    }, 700)
  }, [replaying, sourceEvents, demoEvts, stopReplay])

  const showingDemo = replaying && demoMode
  // 空态口径：零事件且未开回放/演示 → 空态（演示开即有图，不算空）。
  const isEmpty = !resolved.checked && !replaying

  const { counts, hotEdge } = resolved
  const currentNode =
    [...resolved.nodes, ...resolved.externals].find((node) => node.state === "current") ?? null
  const lastLog = resolved.log.length > 0 ? resolved.log[resolved.log.length - 1] : null
  const maxCount = Math.max(1, counts.events, counts.evidence, counts.generated, counts.gates, counts.passed, counts.reworks, counts.accepts, counts.chapters)

  const isHotEdge = (from: string, to: string): boolean =>
    !!hotEdge && hotEdge.from === from && hotEdge.to === to

  // 主线正交边（自上而下 7 层纵向主干，自显式序列；主干自上而下折向，hot 边发光）。
  const TRUNK_ORDER: ReadonlyArray<readonly [string, string]> = [
    ["goal", "evidence"],
    ["outline", "chapter-plan"],
    ["evidence", "outline"],
    ["chapter-plan", "draft"],
    ["draft", "self-gate"],
    ["self-gate", "review"],
    ["review", "review-gate"],
    ["review-gate", "ingest"],
    ["ingest", "deliver"],
    ["deliver", "reflow"],
    ["reflow", "retrospective"],
  ]
  const trunkEdges: Array<{ key: string; d: string; hot: boolean; index: number }> = []
  TRUNK_ORDER.forEach(([from, to], orderIdx) => {
    const hot = isHotEdge(from, to)
    trunkEdges.push({ key: `${from}->${to}`, d: trunkPath(nodeXY(from), nodeXY(to)), hot, index: orderIdx })
  })

  return (
    <section
      data-testid="pipeline-motion-panel"
      className="overflow-x-auto rounded-md border border-border bg-card p-3 font-mono text-foreground"
    >
      <style>{`.motion-glow{filter:drop-shadow(0 0 6px rgba(56,189,248,.65))}.motion-glow-red{filter:drop-shadow(0 0 6px rgba(248,81,73,.75))}.motion-glow-amber{filter:drop-shadow(0 0 6px rgba(245,158,11,.6))}.motion-pulse-dot{filter:drop-shadow(0 0 6px currentColor)}`}</style>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-center text-sm font-semibold tracking-widest text-foreground">
            NIKO-BUDDY · 完整写作管线 · 目标 → 定稿 → 回流
          </h3>
          <button
            type="button"
            data-testid="motion-replay-toggle"
            onClick={toggleReplay}
            className="ml-auto rounded border border-kind-slate px-2 py-0.5 text-xs text-kind-slate hover:bg-muted"
          >
            {finished ? "↻ 重新回放 / 退出" : replaying ? "■ 停止回放" : "▶ 流程回放 / 步进演示"}
          </button>
        </div>
        {showingDemo ? (
          <p data-testid="motion-demo-note" className="text-center text-xs text-warning-foreground">
            演示模式：内置示例事件流（取证→生成→审稿门返修→v2通过→入库→回流），退出恢复原状
          </p>
        ) : null}
        <div
          data-testid="motion-legend"
          className="flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground"
        >
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#38bdf8]" />当前路径</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#f59e0b]" />外部依赖</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#f87171]" />↩ 返工循环</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#34d399]" />记忆回流</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#475569]" />○ 其余环节（● 已走过）</span>
        </div>
        {/* KPI 数字卡片矩阵（带底部彩色进度细条） */}
        <div data-testid="motion-kpis" className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
          <KpiCard label="事件" value={counts.events} tone="#38bdf8" max={maxCount} />
          <KpiCard label="取证" value={counts.evidence} tone="#38bdf8" max={maxCount} />
          <KpiCard label="生成" value={counts.generated} tone="#38bdf8" max={maxCount} />
          <KpiCard label="门禁" value={counts.gates} tone="#a78bfa" max={maxCount} />
          <KpiCard label="通过" value={counts.passed} tone="#34d399" max={maxCount} />
          <KpiCard label="返工" value={counts.reworks} tone="#f87171" max={maxCount} />
          <KpiCard label="入库章节" value={counts.chapters} tone="#34d399" max={maxCount} />
        </div>
        {/* 契约统计条：完整文本保留，兼容既有单测配对 */}
        <p data-testid="motion-stats" className="text-center text-xs text-muted-foreground">
          事件 <b className="text-foreground">{counts.events}</b>
          {" · "}取证 <b className="text-foreground">{counts.evidence}</b>
          {" · "}生成 <b className="text-foreground">{counts.generated}</b>
          {" · "}门运行 <b className="text-foreground">{counts.gates}</b>
          {" · "}通过 <b className="text-foreground">{counts.passed}</b>
          {" · "}返工 <b className="text-destructive">{counts.reworks}</b>
          {" · "}接收 <b className="text-foreground">{counts.accepts}</b>
          {" · "}错误 <b className="text-destructive">{counts.errors}</b>
          {" · "}章节 <b className="text-foreground">{counts.chapters}</b>
        </p>
      </header>

      {isEmpty ? (
        <p data-testid="motion-empty" className="py-8 text-center text-xs text-muted-foreground">
          尚无运行事件：主控跑过一次章节工作流，蓝色当前路径才会亮起（不播演示动画）。
        </p>
      ) : (
        <svg
          data-testid="motion-diagram"
          viewBox="0 0 1100 680"
          className="mx-auto block w-full min-w-[640px]"
          role="img"
          aria-label="写作管线动态图"
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
          {/* 返工次数角标 */}
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
          {resolved.externals.map((node) => (
            <ExternalNode
              key={node.id}
              node={node}
              tos={node.id === "knowledge-base" ? ["evidence", "chapter-plan"] : ["draft"]}
            />
          ))}
          {/* 审查维度芯片条：review 下方居中 9 维；自检/审稿活跃时青蓝点亮 */}
          {(() => {
            const lit = ["self-gate", "review", "review-gate"].some(
              (id) => resolved.nodes.find((n) => n.id === id)?.state !== "idle",
            )
            const stroke = lit ? "#38bdf8" : "#334155"
            const fill = lit ? "#38bdf8" : "#94a3b8"
            return (
              <g data-testid="motion-review-dims">
                <line
                  x1={nodeXY("review").x}
                  y1={nodeXY("review").y + NODE_H / 2}
                  x2={nodeXY("review").x}
                  y2={371}
                  stroke={stroke}
                  strokeWidth={1}
                />
                {REVIEW_DIMS.map((dim, i) => (
                  <g key={dim}>
                    <rect x={221 + i * 62} y={371} width={56} height={20} rx={10} fill="#0f172a" stroke={stroke} strokeWidth={1} />
                    <text x={249 + i * 62} y={385} textAnchor="middle" fontSize="11" fill={fill}>
                      {dim}
                    </text>
                  </g>
                ))}
              </g>
            )
          })()}
          {/* 记忆回流闭环：reflow/retrospective 沿右侧大环回到顶部 goal（青绿色） */}
          {(() => {
            const lit = ["reflow", "retrospective"].some(
              (id) => resolved.nodes.find((n) => n.id === id)?.state !== "idle",
            )
            const stroke = lit ? "#34d399" : "#1f3a33"
            const d = `M ${nodeXY("retrospective").x + NODE_W / 2} ${nodeXY("retrospective").y} H 1040 V 30 H ${nodeXY("goal").x} V ${nodeXY("goal").y - NODE_H / 2}`
            return (
              <g data-testid="motion-reflow-loop">
                <path
                  d={d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={lit ? 2.5 : 1.5}
                  strokeDasharray={lit ? undefined : "6 4"}
                  className={lit ? "motion-glow" : undefined}
                />
                {lit ? (
                  <circle r="4" fill="#34d399" className="motion-pulse-dot">
                    <animateMotion dur="1.6s" repeatCount="indefinite" path={d} />
                  </circle>
                ) : null}
                <text x={1052} y={330} fontSize="11" fill={stroke} transform="rotate(90 1052,330)" textAnchor="middle">
                  记忆回流
                </text>
              </g>
            )
          })()}
        </svg>
      )}

      <div className="mt-2 border-t border-border pt-2">
        <p className="text-xs text-muted-foreground">session log</p>
        {(resolved.log.length === 0) ? (
          <p data-testid="motion-log-empty" className="text-xs text-muted-foreground">
            （空）
          </p>
        ) : (
          <ul data-testid="motion-log" className="max-h-36 space-y-0.5 overflow-y-auto rounded bg-black/40 p-2 text-xs">
            {resolved.log.slice(-8).map((entry, index) => (
              <li key={`${entry.ts}-${index}`} className="flex items-center gap-2">
                <span className="shrink-0 text-muted-foreground tabular-nums">{entry.ts}</span>
                <span
                  className="shrink-0 rounded px-1"
                  style={{ color: logToneColor(entry.tone), border: `1px solid ${logToneColor(entry.tone)}55`, background: `${logToneColor(entry.tone)}11` }}
                >
                  {entry.tone}
                </span>
                <span className="truncate" style={{ color: logToneColor(entry.tone) }}>
                  {entry.label}
                </span>
                <span className="ml-auto shrink-0 text-kind-slate">{phaseGroup(entry.label)}</span>
              </li>
            ))}
          </ul>
        )}
        {/* CLI 命令状态栏：提示符 + 阶段胶囊条 */}
        <div data-testid="motion-status" className="mt-1 flex flex-wrap items-center gap-1.5 rounded bg-black/40 px-2 py-1.5 text-xs text-muted-foreground">
          <span className="text-success-foreground">$</span>
          <span className="text-kind-slate">niko-buddy pipeline --live</span>
          <span className="text-kind-slate">|</span>
          <span className="text-muted-foreground">阶段</span>
          {STAGE_CAPSULES.map((cap) => {
            const active = currentNode?.id === cap.id
            return (
              <span
                key={cap.id}
                data-stage={cap.id}
                data-active={active ? "true" : "false"}
                className={active ? "rounded border border-info/40 bg-info/10 px-1 text-info" : "rounded border border-border px-1 text-muted-foreground"}
              >
                [{cap.label}]
              </span>
            )
          })}
          <span className="ml-auto text-muted-foreground">
            {currentNode ? <>当前路径 [{currentNode.label}]{lastLog ? ` · ${lastLog.label}` : ""}</> : <>未在运行{lastLog ? ` · 上次：${lastLog.label}` : ""}</>}
          </span>
        </div>
      </div>
    </section>
  )
}
