import { useRef, useCallback, useEffect } from "react"

type WorkerRequest =
  | { id: string; type: "calc-clue-relations"; payload: { clues: { id: string; content: string }[] } }
  | { id: string; type: "calc-branch-diff"; payload: { branchA: any; branchB: any } }
  | { id: string; type: "calc-board-layout"; payload: { cards: { id: string; x: number; y: number; width: number }[]; connections: { fromCardId: string; toCardId: string }[] } }

  | { id: string; type: "clue-relations"; payload: { pairs: [string, string, number][] } }
  | { id: string; type: "branch-diff"; payload: any }
  | { id: string; type: "board-layout"; payload: { id: string; x: number; y: number }[] }

type PendingRequest = {
  resolve: (value: any) => void
  reject: (reason: any) => void
  timeoutId: ReturnType<typeof setTimeout>
}

const TIMEOUT_MS = 3000

function extractKeywords(text: string): string[] {
  const words = text.split(/[，。？！、的了是在有和与等\s,.!?;:]/).filter((w) => w.length >= 2)
  return Array.from(new Set(words))
}

function keywordOverlap(a: string, b: string): number {
  const keywordsA = extractKeywords(a)
  const keywordsB = extractKeywords(b)
  if (keywordsA.length === 0 || keywordsB.length === 0) return 0
  const setA = new Set(keywordsA)
  const shared = keywordsB.filter((w) => setA.has(w)).length
  return shared / Math.min(keywordsA.length, keywordsB.length)
}

function fallbackCalcClueRelations(clues: { id: string; content: string }[]): { pairs: [string, string, number][] } {
  const pairs: [string, string, number][] = []
  for (let i = 0; i < clues.length; i++) {
    for (let j = i + 1; j < clues.length; j++) {
      const score = keywordOverlap(clues[i].content, clues[j].content)
      if (score > 0.3) {
        pairs.push([clues[i].id, clues[j].id, score])
      }
    }
  }
  pairs.sort((a, b) => b[2] - a[2])
  return { pairs: pairs.slice(0, 50) }
}

function fallbackCalcBoardLayout(
  cards: { id: string; x: number; y: number; width: number }[],
  connections: { fromCardId: string; toCardId: string }[],
): { id: string; x: number; y: number }[] {
  const k = 80
  const iterations = 80
  let temperature = 50

  const nodes = cards.map((c) => ({
    id: c.id,
    x: c.x + c.width / 2,
    y: c.y + 60,
    vx: 0,
    vy: 0,
    width: c.width,
  }))

  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].vx = 0
      nodes[i].vy = 0
    }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x
        const dy = nodes[j].y - nodes[i].y
        let dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 1) dist = 1
        const force = (k * k) / dist
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        nodes[i].vx -= fx
        nodes[i].vy -= fy
        nodes[j].vx += fx
        nodes[j].vy += fy
      }
    }

    for (const conn of connections) {
      const from = nodeMap.get(conn.fromCardId)
      const to = nodeMap.get(conn.toCardId)
      if (!from || !to) continue
      const dx = to.x - from.x
      const dy = to.y - from.y
      let dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 1) dist = 1
      const force = dist / k
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      from.vx += fx
      from.vy += fy
      to.vx -= fx
      to.vy -= fy
    }

    for (const node of nodes) {
      const disp = Math.sqrt(node.vx * node.vx + node.vy * node.vy)
      if (disp > 0) {
        const ratio = Math.min(disp, temperature) / disp
        node.x += node.vx * ratio
        node.y += node.vy * ratio
      }
    }

    temperature *= 0.95
  }

  return nodes.map((n) => ({
    id: n.id,
    x: n.x - n.width / 2,
    y: n.y - 60,
  }))
}

const DIMENSION_KEYS = [
  "tension",
  "pace",
  "characterUtilization",
  "characterArc",
  "infoDensity",
  "emotionalResonance",
  "logicConsistency",
] as const

type DirectorScore = {
  tension: number
  pace: number
  characterUtilization: number
  characterArc: number
  infoDensity: number
  emotionalResonance: number
  logicConsistency: number
}

function fallbackGetAvgDirectorScore(branch: any): DirectorScore {
  if (branch.directorEvaluations.length === 0) {
    return {
      tension: 3.0,
      pace: 3.0,
      characterUtilization: 3.0,
      characterArc: 3.0,
      infoDensity: 3.0,
      emotionalResonance: 3.0,
      logicConsistency: 3.0,
    }
  }
  const sum: DirectorScore = {
    tension: 0,
    pace: 0,
    characterUtilization: 0,
    characterArc: 0,
    infoDensity: 0,
    emotionalResonance: 0,
    logicConsistency: 0,
  }
  for (const ev of branch.directorEvaluations) {
    for (const key of DIMENSION_KEYS) {
      sum[key] += ev.scores[key]
    }
  }
  const n = branch.directorEvaluations.length
  const avg: DirectorScore = { ...sum }
  for (const key of DIMENSION_KEYS) {
    avg[key] = Math.round((avg[key] / n) * 10) / 10
  }
  return avg
}

function fallbackCalcBranchDiff(branchA: any, branchB: any): any {
  const branches = [branchA, branchB]
  const scoresList = branches.map((b) => fallbackGetAvgDirectorScore(b))

  const dimensionDiffs = DIMENSION_KEYS.map((key) => {
    const values = scoresList.map((s) => s[key])
    const max = Math.max(...values)
    const min = Math.min(...values)
    const maxIdx = values.indexOf(max)
    return {
      key,
      diff: max - min,
      maxBranchName: branches[maxIdx].name,
      maxValue: max,
      minValue: min,
    }
  })
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 3)

  const eventCounts = branches.map((b) => b.timelineEvents.length)
  const characterCounts = branches.map((b) => b.finalAgentSnapshots.length)

  const allCharMap = new Map<string, string>()
  for (const b of branches) {
    for (const agent of b.finalAgentSnapshots) {
      allCharMap.set(agent.agentId, agent.name)
    }
  }

  const sentimentDiffs: { charId: string; charName: string; maxDiff: number; maxBranch: string; values: number[] }[] = []

  for (const [charId, charName] of allCharMap) {
    const values: number[] = []
    for (const b of branches) {
      const agent = b.finalAgentSnapshots.find((a: any) => a.agentId === charId)
      let totalSentiment = 0
      let count = 0
      if (agent) {
        for (const [, val] of agent.sentiments) {
          totalSentiment += val
          count++
        }
      }
      values.push(count > 0 ? totalSentiment / count : 0)
    }
    const max = Math.max(...values)
    const min = Math.min(...values)
    const maxIdx = values.indexOf(max)
    sentimentDiffs.push({
      charId,
      charName,
      maxDiff: max - min,
      maxBranch: branches[maxIdx].name,
      values,
    })
  }

  const topSentimentDiffs = sentimentDiffs.sort((a, b) => b.maxDiff - a.maxDiff).slice(0, 3)

  const maxRound = Math.max(
    ...branches.map((b) =>
      b.timelineEvents.length > 0 ? Math.max(...b.timelineEvents.map((e: any) => e.round)) : -1,
    ),
  )

  let divergenceRound = -1
  for (let r = 0; r <= maxRound; r++) {
    const roundContents = branches.map((b) => {
      const evs = b.timelineEvents.filter((e: any) => e.round === r)
      return evs.map((e: any) => e.content.slice(0, 10)).join("|")
    })

    let allSame = true
    for (let i = 1; i < roundContents.length; i++) {
      if (roundContents[i] !== roundContents[0]) {
        allSame = false
        break
      }
    }
    if (!allSame) {
      divergenceRound = r + 1
      break
    }
  }

  const bestBranchIdx = branches.reduce(
    (bestIdx, b, idx) => (b.overallScore > branches[bestIdx].overallScore ? idx : bestIdx),
    0,
  )

  return {
    dimensionDiffs,
    eventCounts,
    characterCounts,
    topSentimentDiffs,
    divergenceRound,
    bestBranchIdx,
    scoresList,
  }
}

export function useSimulationWorker() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map())
  const counterRef = useRef(0)
  const workerFailedRef = useRef(false)

  const ensureWorker = useCallback((): Worker | null => {
    if (workerFailedRef.current) return null
    if (workerRef.current) return workerRef.current

    workerFailedRef.current = true
    return null
    // v2 适配：无 Web Worker 通道，全部走主线程同步计算（见 sendRequest fallback）
  }, [])

  const sendRequest = useCallback(
    <T>(request: Omit<WorkerRequest, "id">, fallback: () => T): Promise<T> => {
      const worker = ensureWorker()
      const id = `req-${Date.now()}-${counterRef.current++}`

      if (!worker) {
        return Promise.resolve(fallback())
      }

      return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingRef.current.delete(id)
          try {
            worker.terminate()
          } catch {
          }
          workerRef.current = null
          workerFailedRef.current = true
          resolve(fallback())
        }, TIMEOUT_MS)

        pendingRef.current.set(id, {
          resolve: resolve as (value: any) => void,
          reject,
          timeoutId,
        })

        try {
          worker.postMessage({ ...request, id })
        } catch {
          clearTimeout(timeoutId)
          pendingRef.current.delete(id)
          workerFailedRef.current = true
          workerRef.current = null
          resolve(fallback())
        }
      })
    },
    [ensureWorker],
  )

  const calcClueRelations = useCallback(
    (clues: { id: string; content: string }[]): Promise<{ pairs: [string, string, number][] }> => {
      return sendRequest(
        { type: "calc-clue-relations", payload: { clues } },
        () => fallbackCalcClueRelations(clues),
      )
    },
    [sendRequest],
  )

  const calcBoardLayout = useCallback(
    (
      cards: { id: string; x: number; y: number; width: number }[],
      connections: { fromCardId: string; toCardId: string }[],
    ): Promise<{ id: string; x: number; y: number }[]> => {
      return sendRequest(
        { type: "calc-board-layout", payload: { cards, connections } },
        () => fallbackCalcBoardLayout(cards, connections),
      )
    },
    [sendRequest],
  )

  const calcBranchDiff = useCallback(
    (branchA: any, branchB: any): Promise<any> => {
      return sendRequest(
        { type: "calc-branch-diff", payload: { branchA, branchB } },
        () => fallbackCalcBranchDiff(branchA, branchB),
      )
    },
    [sendRequest],
  )

  const terminate = useCallback(() => {
    if (workerRef.current) {
      try {
        workerRef.current.terminate()
      } catch {
      }
      workerRef.current = null
    }
    for (const [, pending] of pendingRef.current) {
      clearTimeout(pending.timeoutId)
    }
    pendingRef.current.clear()
  }, [])

  useEffect(() => {
    return () => {
      terminate()
    }
  }, [terminate])

  return {
    calcClueRelations,
    calcBoardLayout,
    calcBranchDiff,
    terminate,
  }
}
