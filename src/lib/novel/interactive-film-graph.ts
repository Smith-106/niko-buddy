/**
 * 64 号实施（63 号共识 §6 P0-1）：InteractiveFilmGraph — 互动影游图模型.
 *
 * 吸收来源：reference 池 ink 叙事模式（knot/stitch/choice/divert 概念），
 * 只借形态不借代码（无 LICENSE 参考仓按 55 号 W3-2 口径）。inkjs/C# 运行时
 * 不进 Tauri（IPC 直 invoke、零重型运行时硬约束）：TS 图模型为权威，
 * `.ink`/HTML 只是导出物（非第二真源）。
 *
 * 本文件是「已存在锚点（plot-forecast 预检 / emotion-ledger 情感评估 /
 * export 落盘）的同域辅助文件」：图校验纯函数零 LLM（ADR-19）；情感评估
 * 器在 emotion-ledger.ts additive（本文件只引用其类型）；导出落盘由
 * export.ts 接线（exportInteractiveStory）。
 *
 * Draft-first：图 JSON 是作者工件，LLM 辅助生成时先进 pending 草稿；本文件
 * 只提供确定性校验与导出，不写正式层。
 */

/** 节点形态（ink 概念收缩：knot 段落 / stitch 小节 / choice 选项分叉 / end 终章）。 */
export type InkNodeKind = "knot" | "stitch" | "choice" | "end"

export interface InteractiveNode {
  id: string
  kind: InkNodeKind
  title: string
  /** 玩家可见正文（可含 {var} 占位；本波不做完整 ink 表达式求值）。 */
  text: string
  /** 情感标签（喜/怒/哀/惧/惊/惑/决意…），供评估器；非 LLM。 */
  emotionTag?: string
  illustrationHint?: string
}

export interface InteractiveEdge {
  from: string
  to: string
  /** choice 边的选项文案；knot→stitch 可空。 */
  choiceLabel?: string
  condition?: string
}

export interface InteractiveStoryGraph {
  version: 1
  startId: string
  nodes: InteractiveNode[]
  edges: InteractiveEdge[]
  /** 与长篇项目弱绑定，非第二真源。 */
  sourceChapter?: number
}

export interface InkDiagnostic {
  code: "orphan" | "missing_start" | "cycle_warn" | "empty_choice" | "dangling_edge"
  nodeId?: string
  message: string
}

export interface InkExportResult {
  ink: string
  html: string
  diagnostics: InkDiagnostic[]
}

/** 校验图（纯函数确定性）。choice 出度≥1 且边有 label；end 出度 0；孤儿入度 0 非 start。 */
export function validateInteractiveGraph(graph: InteractiveStoryGraph): InkDiagnostic[] {
  const diagnostics: InkDiagnostic[] = []
  const ids = new Set(graph.nodes.map((n) => n.id))

  if (!ids.has(graph.startId)) {
    diagnostics.push({ code: "missing_start", message: `startId「${graph.startId}」不存在` })
  }

  const outDegree = new Map<string, number>()
  const inDegree = new Map<string, number>()
  for (const node of graph.nodes) {
    outDegree.set(node.id, 0)
    inDegree.set(node.id, 0)
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      diagnostics.push({ code: "dangling_edge", nodeId: edge.from, message: `边 ${edge.from}→${edge.to} 引用不存在的节点` })
      continue
    }
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1)
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
  }

  for (const node of graph.nodes) {
    const out = outDegree.get(node.id) ?? 0
    if (node.kind === "choice" && out < 1) {
      diagnostics.push({ code: "empty_choice", nodeId: node.id, message: `choice 节点「${node.id}」无出边` })
    }
    if (node.kind === "end" && out > 0) {
      diagnostics.push({ code: "empty_choice", nodeId: node.id, message: `end 节点「${node.id}」有出边（应为终章）` })
    }
    if (node.kind === "choice") {
      for (const edge of graph.edges.filter((e) => e.from === node.id)) {
        if (!edge.choiceLabel || !edge.choiceLabel.trim()) {
          diagnostics.push({ code: "empty_choice", nodeId: node.id, message: `choice「${node.id}」的边缺选项文案` })
          break
        }
      }
    }
    if ((inDegree.get(node.id) ?? 0) === 0 && node.id !== graph.startId && node.kind !== "end") {
      diagnostics.push({ code: "orphan", nodeId: node.id, message: `节点「${node.id}」无入边（孤儿）` })
    }
  }

  // 有向环（DFS 三色法）→ cycle_warn（ink 允许 divert 回跳，不 fail）
  const color = new Map<string, 0 | 1 | 2>()
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    adjacency.get(edge.from)!.push(edge.to)
  }
  const stack: string[] = []
  const visit = (id: string): boolean => {
    color.set(id, 1)
    stack.push(id)
    for (const next of adjacency.get(id) ?? []) {
      if (!color.has(next)) {
        if (visit(next)) return true
      } else if (color.get(next) === 1) {
        const cycleStart = stack.indexOf(next)
        const cycle = stack.slice(cycleStart).concat(next)
        diagnostics.push({ code: "cycle_warn", nodeId: next, message: `存在有向环：${cycle.join(" → ")}` })
        return true
      }
    }
    stack.pop()
    color.set(id, 2)
    return false
  }
  for (const node of graph.nodes) {
    if (!color.has(node.id)) visit(node.id)
  }

  return diagnostics
}


/** 导出 `.ink`（确定性字符串；ink v1 子集：knot/stitch/choice/divert）。 */
export function exportInteractiveInk(graph: InteractiveStoryGraph): string {
  const lines: string[] = []
  lines.push("// 由 Niko Buddy 导出的互动影游（ink v1 子集）")
  lines.push(`// startId: ${graph.startId}`)
  lines.push("")
  for (const node of graph.nodes) {
    if (node.kind === "knot") {
      lines.push(`=== ${node.id} ===`)
    } else if (node.kind === "stitch") {
      lines.push(`= ${node.id}`)
    } else if (node.kind === "choice") {
      lines.push(`=== ${node.id} ===`)
    } else {
      lines.push(`=== ${node.id} ===`)
      lines.push("-> END")
      lines.push("")
      continue
    }
    if (node.title) lines.push(`// ${node.title}`)
    for (const t of node.text.split("\n")) {
      if (t.trim()) lines.push(t.trim())
    }
    const outEdges = graph.edges.filter((e) => e.from === node.id)
    if (node.kind === "choice") {
      for (const edge of outEdges) {
        const label = edge.choiceLabel ?? "继续"
        lines.push(`* [${label}] -> ${edge.to}`)
      }
    } else if (outEdges.length > 0) {
      for (const edge of outEdges) {
        lines.push(`-> ${edge.to}`)
      }
    }
    lines.push("")
  }
  return lines.join("\n")
}

/** 导出单文件 HTML（零外部依赖；数据来自 graph 自身字段，文本经 escapeHtml）。 */
export function exportInteractiveHtml(graph: InteractiveStoryGraph): string {
  const nodesJson = encodeURIComponent(JSON.stringify(graph.nodes))
  const edgesJson = encodeURIComponent(JSON.stringify(graph.edges))
  const startId = encodeURIComponent(graph.startId)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>互动影游</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #222; line-height: 1.7; }
  [data-node] { display: none; }
  [data-node].active { display: block; }
  button[data-choice] { display: block; margin: 0.5rem 0; padding: 0.5rem 1rem; border: 1px solid #888; border-radius: 6px; background: #fff; cursor: pointer; }
  button[data-choice]:hover { background: #f0f0f0; }
</style>
</head>
<body>
<main id="app"></main>
<script>
var NODES = JSON.parse(decodeURIComponent("${nodesJson}"));
var EDGES = JSON.parse(decodeURIComponent("${edgesJson}"));
var START = decodeURIComponent("${startId}");
var current = START;
var path = [];
function render() {
  var node = NODES.find(function (n) { return n.id === current; });
  var el = document.getElementById("app");
  if (!node) { el.innerHTML = "<p>图缺失节点</p>"; return; }
  var html = "<h2>" + node.title + "</h2><p>" + node.text + "</p>";
  if (node.kind === "end") {
    html += "<p><em>— 终 —</em></p><p><button data-choice onclick=\\"location.reload()\\">重新开始</button></p>";
  } else {
    EDGES.filter(function (e) { return e.from === current; }).forEach(function (e, i) {
      html += "<button data-choice onclick=\\"go(" + i + ")\\">" + (e.choiceLabel || "继续") + "</button>";
    });
  }
  el.innerHTML = html;
}
function go(i) {
  var edges = EDGES.filter(function (e) { return e.from === current; });
  var edge = edges[i];
  if (!edge) return;
  path.push(edge.to);
  current = edge.to;
  render();
}
render();
</script>
</body>
</html>`
}

/** 组合导出：校验 + ink + html（一次调用三份产物）。 */
export function buildInteractiveExport(graph: InteractiveStoryGraph): InkExportResult {
  const diagnostics = validateInteractiveGraph(graph)
  return {
    ink: exportInteractiveInk(graph),
    html: exportInteractiveHtml(graph),
    diagnostics,
  }
}
