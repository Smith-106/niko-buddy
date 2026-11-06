import { describe, expect, it } from "vitest"
import type { InteractiveStoryGraph } from "./interactive-film-graph"
import {
  createPlayState,
  replayPlay,
  renderPlayFrame,
  stepPlay,
} from "./play-runtime"

const GRAPH: InteractiveStoryGraph = {
  version: 1,
  startId: "k1",
  nodes: [
    { id: "k1", kind: "knot", title: "雪夜敲门", text: "风雪夜，你站在门前。", emotionTag: "惧" },
    { id: "c1", kind: "choice", title: "抉择", text: "李四开门。" },
    { id: "k2", kind: "knot", title: "屋内", text: "你进了屋。" },
    { id: "end1", kind: "end", title: "终章", text: "故事到此。" },
  ],
  edges: [
    { from: "k1", to: "c1" },
    { from: "c1", to: "k2", choiceLabel: "接过茶" },
    { from: "c1", to: "end1", choiceLabel: "转身离开" },
  ],
}

describe("play-runtime (64 号实施：P0-2 Play 可玩面引擎)", () => {
  it("createPlayState：落在 start，未结束", () => {
    const s = createPlayState(GRAPH)
    expect(s.nodeId).toBe("k1")
    expect(s.ended).toBe(false)
    expect(s.path).toEqual(["k1"])
  })

  it("合法 choice 前进：k1 → c1 → k2", () => {
    let s = createPlayState(GRAPH)
    s = stepPlay(GRAPH, s, 0)!
    expect(s.nodeId).toBe("c1")
    s = stepPlay(GRAPH, s, 0)!
    expect(s.nodeId).toBe("k2")
    expect(s.path).toEqual(["k1", "c1", "k2"])
    expect(s.choicePath).toEqual(["c1", "k2"])
  })

  it("非法索引 → null（不抛）", () => {
    const s = createPlayState(GRAPH)
    expect(stepPlay(GRAPH, s, 99)).toBeNull()
    expect(stepPlay(GRAPH, s, -1)).toBeNull()
  })

  it("end 后 step → null", () => {
    let s = createPlayState(GRAPH)
    s = stepPlay(GRAPH, s, 0)!
    s = stepPlay(GRAPH, s, 1)!
    expect(s.nodeId).toBe("end1")
    expect(s.ended).toBe(true)
    expect(stepPlay(GRAPH, s, 0)).toBeNull()
  })

  it("分叉路径不串（同输入同输出确定性）", () => {
    const a = stepPlay(GRAPH, createPlayState(GRAPH), 1)
    const b = stepPlay(GRAPH, createPlayState(GRAPH), 1)
    expect(a).toEqual(b)
  })

  it("renderPlayFrame：ended 帧 choices 为空；非 ended 有选项", () => {
    let s = createPlayState(GRAPH)
    const frame = renderPlayFrame(GRAPH, s)!
    expect(frame.choices.length).toBe(1)
    expect(frame.text).toContain("风雪夜")
    s = stepPlay(GRAPH, s, 0)!
    const frame2 = renderPlayFrame(GRAPH, s)!
    expect(frame2.choices.length).toBe(2)
    expect(frame2.choices[0].label).toBe("接过茶")
    s = stepPlay(GRAPH, s, 1)!
    const frame3 = renderPlayFrame(GRAPH, s)!
    expect(frame3.ended).toBe(true)
    expect(frame3.choices).toEqual([])
  })

  it("renderPlayFrame：带 book 时产出配图 brief（cover-brief 接线）", () => {
    const frame = renderPlayFrame(GRAPH, createPlayState(GRAPH), {
      title: "血月剑歌",
      genre: "玄幻",
      protagonistBrief: "",
      tone: "热血",
      keyImagery: ["剑"],
    })!
    expect(frame.illustrationBrief).toBeTruthy()
    expect(frame.illustrationBrief!.subject).toContain("雪夜敲门")
  })

  it("renderPlayFrame：未知节点 → null", () => {
    const g: InteractiveStoryGraph = { ...GRAPH, startId: "missing" }
    expect(renderPlayFrame(g, createPlayState(g))).toBeNull()
  })

  it("replayPlay：同 choicePath 幂等达同节点", () => {
    const s1 = replayPlay(GRAPH, ["c1", "end1"])!
    const s2 = replayPlay(GRAPH, ["c1", "end1"])!
    expect(s1).toEqual(s2)
    expect(s1.nodeId).toBe("end1")
    expect(s1.ended).toBe(true)
  })

  it("replayPlay：非法路径 → null", () => {
    expect(replayPlay(GRAPH, ["c1", "nowhere"])).toBeNull()
  })

  it("replayPlay：空路径 = 初始态", () => {
    const s = replayPlay(GRAPH, [])!
    expect(s.nodeId).toBe("k1")
    expect(s.ended).toBe(false)
  })

  it("stepPlay：当前 nodeId 不在图中（脏 state）→ null，不越界取节点", () => {
    const stale = { ...createPlayState(GRAPH), nodeId: "ghost" }
    expect(stepPlay(GRAPH, stale, 0)).toBeNull()
  })

  it("stepPlay：出边指向不存在的节点（悬空边）→ null", () => {
    const dangling: InteractiveStoryGraph = {
      ...GRAPH,
      edges: [{ from: "k1", to: "nowhere" }],
    }
    expect(stepPlay(dangling, createPlayState(dangling), 0)).toBeNull()
  })

  it("replayPlay：choicePath 越过已结束节点 → null（end 后不可再步进）", () => {
    // end1 之后仍挂一条出边，模拟作者后期补写：end 后 step 必然返回 null，
    // replay 的「中途失效 → null」因此可达。
    const extended: InteractiveStoryGraph = {
      ...GRAPH,
      nodes: [
        ...GRAPH.nodes,
        { id: "tail", kind: "knot", title: "余波", text: "故事之后。" },
      ],
      edges: [...GRAPH.edges, { from: "end1", to: "tail" }],
    }
    expect(replayPlay(extended, ["c1", "end1", "tail"])).toBeNull()
    // 同一图上只回放到 end1 仍然成功（证明 null 来自越界，而非图不可用）
    expect(replayPlay(extended, ["c1", "end1"])!.ended).toBe(true)
  })

  it("纯性：stepPlay 不改输入 state", () => {
    const s = createPlayState(GRAPH)
    const snapshot = JSON.stringify(s)
    stepPlay(GRAPH, s, 0)
    expect(JSON.stringify(s)).toBe(snapshot)
  })
})
