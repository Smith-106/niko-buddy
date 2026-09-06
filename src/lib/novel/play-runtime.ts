/**
 * 64 号实施（63 号共识 §6 P0-2）：PlayRuntime — 互动影游可玩步进器.
 *
 * 定位：纯函数分支树运行时（HUD/选项/自动配图的引擎契约，无 DOM）。消费
 * interactive-film-graph 的图模型；配图 brief 复用 cover-brief 端口
 * （buildNodeIllustrationBrief），不调图像 provider。stepPlay 非法输入 →
 * null（不抛，与 advanceTranslationStatus 同纪律）。replayPlay 供崩溃续玩
 * （同 choicePath 必达同节点，幂等）。
 *
 * Draft-first：Play 是阅读态，不写章节正文；「从 Play 回写正文」必须走
 * pending draft（禁止 formal-writeback）。
 */

import type { InteractiveStoryGraph, InteractiveNode } from "./interactive-film-graph"
import { buildNodeIllustrationBrief, type CoverBrief, type BookCoverMeta } from "./cover-brief"

export interface PlayState {
  graphVersion: 1
  nodeId: string
  path: string[]
  /** 已选 choice 边 id 序列，供幂等回放。 */
  choicePath: string[]
  ended: boolean
}

export interface PlayChoice {
  edgeIndex: number
  label: string
  to: string
}

export interface PlayFrame {
  node: InteractiveNode
  text: string
  choices: PlayChoice[]
  ended: boolean
  emotionHint?: string
  illustrationBrief?: CoverBrief
}

export function createPlayState(graph: InteractiveStoryGraph): PlayState {
  return {
    graphVersion: 1,
    nodeId: graph.startId,
    path: [graph.startId],
    choicePath: [],
    ended: false,
  }
}

function nodeById(graph: InteractiveStoryGraph, id: string): InteractiveNode | undefined {
  return graph.nodes.find((n) => n.id === id)
}

/**
 * 步进：选择第 edgeIndex 条出边前进。非法索引 / 已结束 / 目标缺失 → null。
 * 确定性：同图同状态同索引同结果。
 */
export function stepPlay(
  graph: InteractiveStoryGraph,
  state: PlayState,
  edgeIndex: number,
): PlayState | null {
  if (state.ended) return null
  const node = nodeById(graph, state.nodeId)
  if (!node) return null
  const outEdges = graph.edges.filter((e) => e.from === state.nodeId)
  const edge = outEdges[edgeIndex]
  if (!edge || !edge.to) return null
  if (!nodeById(graph, edge.to)) return null
  const next = nodeById(graph, edge.to)!
  return {
    graphVersion: 1,
    nodeId: edge.to,
    path: [...state.path, edge.to],
    choicePath: [...state.choicePath, edge.to],
    ended: next.kind === "end",
  }
}

/** 渲染当前帧（HUD 引擎契约：text + choices + 配图 brief）。 */
export function renderPlayFrame(
  graph: InteractiveStoryGraph,
  state: PlayState,
  book?: BookCoverMeta,
): PlayFrame | null {
  const node = nodeById(graph, state.nodeId)
  if (!node) return null
  const outEdges = graph.edges.filter((e) => e.from === state.nodeId)
  const choices: PlayChoice[] = outEdges.map((e, i) => ({
    edgeIndex: i,
    label: e.choiceLabel ?? "继续",
    to: e.to,
  }))
  return {
    node,
    text: node.text,
    choices: state.ended ? [] : choices,
    ended: state.ended || node.kind === "end",
    emotionHint: node.emotionTag,
    illustrationBrief: book ? buildNodeIllustrationBrief(node, book) : undefined,
  }
}

/** 崩溃续玩：按 choicePath 重放（同路径必达同节点；中途失效 → null）。 */
export function replayPlay(
  graph: InteractiveStoryGraph,
  choicePath: string[],
): PlayState | null {
  let state = createPlayState(graph)
  for (const target of choicePath) {
    const outEdges = graph.edges.filter((e) => e.from === state.nodeId)
    const idx = outEdges.findIndex((e) => e.to === target)
    if (idx === -1) return null
    const stepped = stepPlay(graph, state, idx)
    if (!stepped) return null
    state = stepped
  }
  return state
}
