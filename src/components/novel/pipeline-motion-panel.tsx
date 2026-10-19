// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * pipeline-motion-panel.tsx — 「管線動態」面板（只讀）。
 *
 * 回答「工作正跑到哪一步」：把 projectPipelineMotion 的投影畫成一條
 * 終端風格的縱向管線（需求 → 成片 → 回流），藍色當前路徑只跟真實事件。
 *
 * 誠實口徑：零事件時顯示空態（不畫一條灰管線假裝有跑）；返工紅邊
 * 計數為 0 時畫灰色虛線，不畫紅；統計條全部來自事件計數。
 */

import { useMemo } from "react"

import {
  PIPELINE_STAGES,
  REWORK_EDGES,
  projectPipelineMotion,
  type MotionNodeProjection,
  type PipelineMotionInput,
  type PipelineMotionProjection,
} from "@/lib/novel"

export interface PipelineMotionPanelProps {
  /** 注入投影結果（測試可替換）。 */
  readonly projection?: PipelineMotionProjection
  /** 注入輸入（未給 projection 時用於計算）。 */
  readonly input?: PipelineMotionInput
}

const EMPTY_INPUT: PipelineMotionInput = { events: [], traceEntries: [] }

// ── SVG 版式（固定座標，節點數固定=13，不隨數據變化） ──────────────────────────

const COL_X = 150
const EXT_X = 320
const NODE_W = 116
const NODE_H = 26
const ROW_GAP = 46
const TOP_Y = 24

function rowY(index: number): number {
  return TOP_Y + index * ROW_GAP
}

function stageIndex(id: string): number {
  const index = PIPELINE_STAGES.findIndex((stage) => stage.id === id)
  return index < 0 ? 0 : index
}

const NODE_TEXT: Record<string, string> = {
  current: "#58a6ff",
  visited: "#8b949e",
  idle: "#484f58",
}

const NODE_STROKE: Record<string, string> = {
  current: "#58a6ff",
  visited: "#6e7681",
  idle: "#30363d",
}

function externalRow(id: string): number {
  // 黃色側節點固定掛在相關行：模型路由-取證行，知識庫-大綱行。
  return id === "model-router" ? stageIndex("evidence") : stageIndex("outline")
}

/** 狀態字形雙編碼：色盲用戶不靠顏色也能區分（▶ 進行中 / ● 已走過 / ○ 未到）。 */
function stateGlyph(state: MotionNodeProjection["state"]): string {
  return state === "current" ? "▶" : state === "visited" ? "●" : "○"
}

function ReworkPath({ from, to, active, lane }: { from: string; to: string; active: boolean; lane: number }): React.ReactElement {
  const y1 = rowY(stageIndex(from))
  const y2 = rowY(stageIndex(to))
  const x = COL_X - NODE_W / 2 - lane
  const color = active ? "#f85149" : "#30363d"
  return (
    <path
      d={`M ${COL_X - NODE_W / 2} ${y1} C ${x} ${y1}, ${x} ${y2}, ${COL_X - NODE_W / 2} ${y2}`}
      fill="none"
      stroke={color}
      strokeWidth={active ? 2 : 1}
      strokeDasharray={active ? undefined : "4 3"}
      data-testid={`motion-rework-${from}-${to}`}
      data-active={active ? "true" : "false"}
    />
  )
}

function MotionNode({ node, index }: { node: MotionNodeProjection; index: number }): React.ReactElement {
  const y = rowY(index)
  const stroke = NODE_STROKE[node.state]
  const fill = node.state === "current" ? "#0d2740" : "#0d1117"
  const testId = `motion-node-${node.id}`
  if (node.kind === "decision") {
    const w = NODE_W / 2
    const h = NODE_H / 2 + 4
    return (
      <g data-testid={testId} data-state={node.state}>
        <polygon
          points={`${COL_X},${y - h} ${COL_X + w},${y} ${COL_X},${y + h} ${COL_X - w},${y}`}
          fill={fill}
          stroke={stroke}
          strokeWidth={node.state === "current" ? 2 : 1}
        />
        <text x={COL_X} y={y + 4} textAnchor="middle" fontSize="11" fill={NODE_TEXT[node.state]}>
          {stateGlyph(node.state)} ◆ {node.label}
        </text>
      </g>
    )
  }
  return (
    <g data-testid={testId} data-state={node.state}>
      <rect
        x={COL_X - NODE_W / 2}
        y={y - NODE_H / 2}
        width={NODE_W}
        height={NODE_H}
        rx={4}
        fill={fill}
        stroke={stroke}
        strokeWidth={node.state === "current" ? 2 : 1}
      />
      <text x={COL_X} y={y + 4} textAnchor="middle" fontSize="11" fill={NODE_TEXT[node.state]}>
        {node.kind === "terminal" ? `${stateGlyph(node.state)} ■ ${node.label}` : `${stateGlyph(node.state)} ${node.label}`}
      </text>
    </g>
  )
}

function ExternalNode({ node }: { node: MotionNodeProjection }): React.ReactElement {
  const y = rowY(externalRow(node.id))
  const lit = node.state !== "idle"
  const stroke = lit ? "#d29922" : "#30363d"
  const text = lit ? "#d29922" : "#484f58"
  return (
    <g data-testid={`motion-node-${node.id}`} data-state={node.state}>
      <line
        x1={COL_X + NODE_W / 2}
        y1={y}
        x2={EXT_X - 52}
        y2={y}
        stroke={stroke}
        strokeWidth={1}
        strokeDasharray="4 3"
      />
      <rect
        x={EXT_X - 52}
        y={y - 13}
        width={104}
        height={26}
        rx={4}
        fill="#0d1117"
        stroke={stroke}
        strokeWidth={1}
      />
      <text x={EXT_X} y={y + 4} textAnchor="middle" fontSize="11" fill={text}>
        {stateGlyph(node.state)} ◇ {node.label}
      </text>
    </g>
  )
}

export function PipelineMotionPanel({ projection, input }: PipelineMotionPanelProps) {
  const resolved = useMemo<PipelineMotionProjection>(
    () => projection ?? projectPipelineMotion(input ?? EMPTY_INPUT),
    [input, projection],
  )

  const height = rowY(PIPELINE_STAGES.length - 1) + 30
  const currentNode =
    [...resolved.nodes, ...resolved.externals].find((node) => node.state === "current") ?? null
  const lastLog = resolved.log.length > 0 ? resolved.log[resolved.log.length - 1] : null
  const { counts, hotEdge } = resolved

  const isHotEdge = (index: number): boolean => {
    if (!hotEdge || index <= 0) return false
    const node = resolved.nodes[index]
    const prev = resolved.nodes[index - 1]
    return node.id === hotEdge.to && prev.id === hotEdge.from
  }

  return (
    <section
      data-testid="pipeline-motion-panel"
      className="overflow-x-auto rounded-md border border-border bg-[#0d1117] p-3 font-mono"
    >
      <header className="space-y-2">
        <h3 className="text-center text-sm font-semibold tracking-widest text-[#e6edf3]">
          管線動態 <span className="text-[#58a6ff]">·</span> 需求 → 成片 → 回流
        </h3>
        <div
          data-testid="motion-legend"
          className="flex flex-wrap items-center justify-center gap-3 text-[11px] text-[#8b949e]"
        >
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#58a6ff]" />▶ 當前路徑</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#d29922]" />◇ 外部依賴（虛線）</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#f85149]" />↩ 返工回路（有計數才紅）</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#484f58]" />○ 其餘節點（● 已走過）</span>
        </div>
        <p data-testid="motion-stats" className="text-center text-[11px] text-[#8b949e]">
          事件 <b className="text-[#e6edf3]">{counts.events}</b>
          {" · "}取證 <b className="text-[#e6edf3]">{counts.evidence}</b>
          {" · "}生成 <b className="text-[#e6edf3]">{counts.generated}</b>
          {" · "}門運行 <b className="text-[#e6edf3]">{counts.gates}</b>
          {" · "}通過 <b className="text-[#e6edf3]">{counts.passed}</b>
          {" · "}返工 <b className="text-[#f85149]">{counts.reworks}</b>
          {" · "}接收 <b className="text-[#e6edf3]">{counts.accepts}</b>
          {" · "}錯誤 <b className="text-[#f85149]">{counts.errors}</b>
          {" · "}章節 <b className="text-[#e6edf3]">{counts.chapters}</b>
        </p>
      </header>

      {!resolved.checked ? (
        <p data-testid="motion-empty" className="py-8 text-center text-[12px] text-[#8b949e]">
          尚無運行事件：主控跑過一次章節工作流，藍色當前路徑才會亮起（不播演示動畫）。
        </p>
      ) : (
        <svg
          data-testid="motion-diagram"
          viewBox={`0 0 400 ${height}`}
          className="mx-auto block w-full max-w-[420px]"
          role="img"
          aria-label="寫作管線動態圖"
        >
          {resolved.nodes.slice(1).map((_node, offset) => {
            const index = offset + 1
            const y1 = rowY(index - 1) + NODE_H / 2
            const y2 = rowY(index) - NODE_H / 2
            const hot = isHotEdge(index)
            return (
              <line
                key={`edge-${index}`}
                x1={COL_X}
                y1={y1}
                x2={COL_X}
                y2={y2}
                stroke={hot ? "#58a6ff" : "#30363d"}
                strokeWidth={hot ? 2 : 1}
                data-testid={`motion-edge-${index}`}
                data-hot={hot ? "true" : "false"}
              />
            )
          })}
          {REWORK_EDGES.map((edge) => (
            <ReworkPath
              key={`${edge.from}-${edge.to}`}
              from={edge.from}
              to={edge.to}
              active={(resolved.reworkCounts[`${edge.from}->${edge.to}`] ?? 0) > 0}
              lane={edge.from === "self-gate" ? 58 : 34}
            />
          ))}
          {resolved.nodes.map((node, index) => (
            <MotionNode key={node.id} node={node} index={index} />
          ))}
          {resolved.externals.map((node) => (
            <ExternalNode key={node.id} node={node} />
          ))}
        </svg>
      )}

      <div className="mt-2 border-t border-[#21262d] pt-2">
        <p className="text-[11px] text-[#484f58]">session log</p>
        {resolved.log.length === 0 ? (
          <p data-testid="motion-log-empty" className="text-[11px] text-[#484f58]">
            （空）
          </p>
        ) : (
          <ul data-testid="motion-log" className="max-h-28 space-y-0.5 overflow-y-auto text-[11px]">
            {resolved.log.slice(-8).map((entry, index) => (
              <li key={`${entry.ts}-${index}`} className="flex gap-2">
                <span className="shrink-0 text-[#484f58]">{entry.ts}</span>
                <span
                  className={
                    entry.tone === "error"
                      ? "text-[#f85149]"
                      : entry.tone === "rework"
                        ? "text-[#d29922]"
                        : entry.tone === "pass"
                          ? "text-[#3fb950]"
                          : "text-[#8b949e]"
                  }
                >
                  {entry.label}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p data-testid="motion-status" className="mt-1 text-[11px] text-[#8b949e]">
          {currentNode ? (
            <>當前路徑 [{currentNode.label}]{lastLog ? ` · ${lastLog.label}` : ""}</>
          ) : (
            <>未在運行{lastLog ? ` · 上次：${lastLog.label}` : ""}</>
          )}
        </p>
      </div>
    </section>
  )
}
