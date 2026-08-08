import http from "node:http"

const HOST = "127.0.0.1"
// Allow tests to pick a free port when 18080 is occupied by another service.
const PORT = Number(process.env.MOCK_STAGE2_PORT || process.env.PORT || 18080)
const MODEL = "mock-qmai"
const CHAPTER_TITLE_PREFIX = "# Chapter "

const MARKERS = {
  taskBrief: "[TASK_BRIEF_MARKER]",
  draft: "[DRAFT_STAGE_MARKER]",
  revision: "[REVISION_STAGE_MARKER]",
  expansion: "[EXPANSION_STAGE_MARKER]",
  finalPolish: "[FINAL_POLISH_STAGE_MARKER]",
  failGate: "[FAIL_GATE]",
  manualGate: "[MANUAL_GATE]",
  slow: "[SLOW]",
  resumeTest: "[RESUME_TEST]",
}

function textFromContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return ""
      if (block.type === "text" && typeof block.text === "string") return block.text
      return ""
    })
    .join("")
}

function collectPrompt(messages) {
  if (!Array.isArray(messages)) return ""
  return messages
    .map((message) => textFromContent(message?.content))
    .filter(Boolean)
    .join("\n\n")
}

function extractStageScopedPrompt(prompt) {
  const stageMarkers = [
    MARKERS.taskBrief,
    MARKERS.draft,
    MARKERS.revision,
    MARKERS.expansion,
    MARKERS.finalPolish,
  ]
  let matchedMarker = null
  let markerIndex = -1
  for (const marker of stageMarkers) {
    const currentIndex = prompt.lastIndexOf(marker)
    if (currentIndex > markerIndex) {
      matchedMarker = marker
      markerIndex = currentIndex
    }
  }

  if (!matchedMarker || markerIndex < 0) return prompt

  let scoped = prompt.slice(markerIndex + matchedMarker.length)
  const boundaries = [
    "写作任务书：",
    "原始初稿：",
    "当前过短正文：",
    "当前过长正文：",
    "待最终简单审查与去AI味正文：",
    "错误草稿",
  ]
  const boundaryIndexes = boundaries
    .map((boundary) => scoped.indexOf(boundary))
    .filter((index) => index >= 0)
  if (boundaryIndexes.length > 0) {
    scoped = scoped.slice(0, Math.min(...boundaryIndexes))
  }
  return scoped
}

function detectChapterNumber(prompt) {
  const prioritizedLinePatterns = [
    /^TARGET_CHAPTER_NUMBER\D*(\d+)/i,
    /^target chapter(?: number)?\D*(\d+)/i,
    /^目标章节\D*(\d+)/u,
    /^用户请求.*?第\s*(\d+)\s*章/u,
    /^"chapterNumber"\s*:\s*(\d+)/i,
    /^"chapterId"\s*:\s*"chapter-(\d+)"/i,
  ]
  const searchSources = [extractStageScopedPrompt(prompt), prompt]

  for (const source of searchSources) {
    const lines = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const line of lines) {
      for (const pattern of prioritizedLinePatterns) {
        const match = line.match(pattern)
        if (!match) continue
        const parsed = Number.parseInt(match[1] ?? "", 10)
        if (Number.isFinite(parsed)) {
          return parsed
        }
      }
    }
  }

  const patterns = [
    /"chapterId"\s*:\s*"chapter-(\d+)"/gi,
    /"chapterNumber"\s*:\s*(\d+)/gi,
    /chapter-(\d+)/gi,
    /#?\s*chapter\s+(\d+)\b/gi,
    /#?\s*第\s*(\d+)\s*章/gu,
    /chapter(?:\s+number|_number)?\s*[:=]?\s*(\d+)/gi,
  ]
  const candidates = []
  for (const source of searchSources) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const parsed = Number.parseInt(match[1] ?? "", 10)
        if (Number.isFinite(parsed)) {
          candidates.push({
            chapterNumber: parsed,
            index: match.index ?? -1,
            source,
          })
        }
      }
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (a.source === b.source) return a.index - b.index
      return searchSources.indexOf(a.source) - searchSources.indexOf(b.source)
    })
    return candidates[candidates.length - 1].chapterNumber
  }

  return 1
}

function chapterTitle(chapterNumber, suffix = "Cold Key") {
  return `${CHAPTER_TITLE_PREFIX}${chapterNumber} ${suffix}`
}

function repeatParagraphs(title, paragraphs, targetLength = 3200) {
  let body = `${title}\n\n`
  let index = 0
  while (body.length < targetLength) {
    body += `${paragraphs[index % paragraphs.length]}\n\n`
    index += 1
  }
  return body.trim()
}

function buildTaskBrief(chapterNumber, failing) {
  const leakNote = failing
    ? "5. Keep one deliberate gate failure: the protagonist states an unverified fact to test fix-loop."
    : "5. The protagonist may notice anomalies, but may not confirm the swapped family record yet."

  return [
    `TASK BRIEF FOR CHAPTER ${chapterNumber}`,
    "1. Must do: enter the old house and connect the strange noise with the old key clue.",
    "2. Must avoid: do not reveal the final truth or skip the investigation process.",
    "3. Character state: the protagonist stays cautious; Xiaoqing knows more but does not confess yet.",
    "4. Foreshadowing: keep the old key, torn record page, and footsteps outside active.",
    leakNote,
    "6. Ending hook: discover a second unfamiliar key and notice someone stopping outside to listen.",
  ].join("\n")
}

function buildChapter({ chapterNumber, leakingFact = false, polished = false }) {
  const title = chapterTitle(chapterNumber)
  const leakParagraph = leakingFact
    ? "He stared at the softened paper edge and said it out loud before he could stop himself: FORBIDDEN_FACT_LEAK the family register was swapped three years ago. The words landed like knowledge he should not already possess."
    : "He stared at the softened paper edge and felt the break between old and new ink, but he could not honestly turn that feeling into certainty."
  const polishLine = polished
    ? "Moisture crept under his sleeve while he pressed the key into his palm, as if he could pin the cold in place before it spread."
    : "Moisture slid under his sleeve while he pressed the key into his palm and forced his breathing back under control."

  const paragraphs = [
    "Rain tapped along the broken tiles in steady layers, and the old roofline caught enough light to look sharpened by the dark. The protagonist did not push the door at once. He leaned into the seam first and listened for proof that the movement inside belonged to more than the wind.",
    "Xiaoqing stayed half a step behind him. She did not urge him forward. She only touched the wet tip of her umbrella to the threshold, and the tiny click made the metal scrape from inside the room stand out all over again.",
    "When the door finally opened, damp dust rolled out in a low wave. The cabinet door inside was half open, the table had been shifted, and the floor carried the kind of shallow mark that meant someone else had searched here in a hurry.",
    polishLine,
    "The first thing he found was an old letter trapped at the bottom of a drawer. The final two lines were blurred by moisture, but one warning remained clear enough to feel intentional: do not trust the person who delivered the key.",
    "Xiaoqing glanced down, stopped on that sentence, and stepped back before she could cover the reaction. That tiny retreat told him more than any explanation would have. The house and the silence she carried were part of the same line of history.",
    leakParagraph,
    "Outside, the footsteps stopped as if someone had pressed against the wall to hear the rest. He folded the letter into his sleeve, reached deeper into the cabinet base, and found a second key with a colder weight and a cut pattern that did not belong to the old house.",
    "He did not announce the discovery. He only closed his hand around the unfamiliar key and saw the thin strip of light under the door dim, as though the listener outside had realized something important had already changed hands.",
    "He told Xiaoqing to step back into the corridor while he moved last. By the time he looked into the rain again, the shape beyond the yard was already retreating, and the dark behind the door felt less like an empty room than an answer that had refused to speak in time.",
  ]

  return repeatParagraphs(title, paragraphs)
}

function buildReviewResult(prompt) {
  if (prompt.includes("FORBIDDEN_FACT_LEAK")) {
    return JSON.stringify([
      {
        severity: "error",
        type: "consistency",
        message: "FORBIDDEN_FACT_LEAK: protagonist states an unverified truth and breaks knowledge boundaries.",
        evidence: "FORBIDDEN_FACT_LEAK the family register was swapped three years ago.",
        relatedMemory: "The protagonist can notice anomalies, but does not yet know the register was swapped.",
        suggestion: "Replace the direct conclusion with observation about altered paper and mismatched ink.",
      },
    ], null, 2)
  }

  return "[]"
}

function buildDimensionReviewResult(prompt) {
  const failing = prompt.includes("FORBIDDEN_FACT_LEAK")
  return JSON.stringify({
    score: failing ? 62 : 88,
    status: failing ? "medium" : "pass",
    summary: failing
      ? "This dimension found a knowledge-boundary breach that should be fixed before acceptance."
      : "This dimension did not find blocking issues.",
    issues: failing
      ? [
          {
            severity: "warning",
            type: "consistency",
            message: "The protagonist confirms the swapped register too early.",
            evidence: "FORBIDDEN_FACT_LEAK the family register was swapped three years ago.",
            relatedMemory: "The protagonist does not know the hidden truth yet.",
            suggestion: "Turn the line into suspicion grounded in visible clues.",
            impact: "Weakens continuity and suspense.",
            rewriteTarget: "FORBIDDEN_FACT_LEAK the family register was swapped three years ago.",
          },
        ]
      : [],
  }, null, 2)
}

function buildSnapshotPayload(prompt) {
  const chapterNumber = detectChapterNumber(prompt)
  return JSON.stringify({
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
    summary: "The protagonist searches the old house, links the strange noise to the old key, and leaves with a second unfamiliar key.",
    characters: ["Protagonist", "Xiaoqing"],
    characterAliases: {
      Protagonist: ["he"],
      Xiaoqing: ["she"],
    },
    locations: ["Old House", "Corridor"],
    organizations: [],
    items: ["Old Key", "Second Key", "Old Letter", "Family Register"],
    events: [
      "The protagonist and Xiaoqing enter the old house.",
      "The protagonist finds the old letter and signs of a rushed search.",
      "The protagonist takes the second unfamiliar key.",
    ],
    characterStateChanges: [
      "Protagonist: shifts from caution to active evidence-taking.",
      "Xiaoqing: shows visible hesitation when the letter is revealed.",
    ],
    relationshipChanges: [
      "The protagonist grows more certain that Xiaoqing is hiding part of the past.",
    ],
    knowledgeChanges: [
      "The protagonist knows the old-house clue is connected to the person who delivered the key.",
    ],
    foreshadowingChanges: [
      "新增伏笔: the second key has an unknown origin and damaged numbering.",
      "推进伏笔: the warning in the letter now echoes the missing family-register page.",
    ],
    newCanonFacts: [
      "The old house had already been searched before the protagonists arrived.",
    ],
    timelineEvents: [
      "On the same rainy night, shortly after the previous chapter, the protagonists enter the old house.",
    ],
    conflicts: [
      "The protagonist must choose between immediate pursuit and staying hidden.",
    ],
    endingHook: "A hidden listener leaves, and the second key becomes the next lead.",
    graphNodes: ["Protagonist", "Xiaoqing", "Old House", "Old Key", "Second Key", "Old Letter", "Family Register"],
    graphEdges: [
      "Protagonist->occurs_in->Old House",
      "Xiaoqing->occurs_in->Old House",
      "Protagonist->holds->Second Key",
      "Old Letter->reveals->Family Register",
      "Second Key->affects->Protagonist",
    ],
  }, null, 2)
}

function buildRefinePayload() {
  return JSON.stringify({
    chapterOutlines: [
      "## Volume One Chapter Outline",
      "- Chapter 1: the protagonist detects an abnormal clue in Qingshi Town.",
      "- Chapter 2: the protagonist clashes with the patrol office and forms a temporary alliance.",
      "- Chapter 3: a key supporting character arrives with a hidden identity linked to the old case.",
    ].join("\n"),
    characterBriefs: [
      "## Main Characters",
      "- Lin Yan: outwardly cold, inwardly stubborn, driven by the truth behind his father's disappearance.",
      "- Shen Zhiwei: a patrol-office clerk skilled at pattern gathering, torn between order and truth.",
    ].join("\n"),
    organizationsOutline: [
      "## Organizations",
      "- Patrol Office: maintains order, but its inner factions are visibly split.",
      "- Night Tide Society: a black-market network holding key information about the disappearance case.",
    ].join("\n"),
    powerSystem: [
      "## Power System",
      "- Residual Sense: reads leftover emotion at the cost of short-term memory disruption.",
      "- Recovery Rule: every use must be followed by a calm-rest ritual.",
    ].join("\n"),
    foreshadowingPlan: [
      "## Foreshadowing Plan",
      "- Thread A: the same surname appears multiple times in the missing-person list.",
      "- Thread B: missing pages in the Night Tide ledger are revealed to have been swapped by leadership.",
    ].join("\n"),
    locationsOutline: [
      "## Locations",
      "- Old Wharf: the main night-trade zone, rich in clues but high in risk.",
      "- North Mountain Relay Station: one of the old crime scenes tied to childhood memory.",
    ].join("\n"),
  }, null, 2)
}

function isSnapshotPrompt(prompt) {
  return prompt.includes('"chapterId"') && prompt.includes('"chapterNumber"') && prompt.includes('"graphEdges"')
}

function isReviewPrompt(prompt) {
  return prompt.includes('"relatedMemory"') && prompt.includes('"suggestion"') && prompt.includes('"severity"')
}

function isDimensionReviewPrompt(prompt) {
  return prompt.includes('"score"') && prompt.includes('"issues"') && prompt.includes('"rewriteTarget"')
}

function isRefinePrompt(prompt) {
  return prompt.includes("chapterOutlines") && prompt.includes("characterBriefs") && prompt.includes("powerSystem")
}

function classifyResponse(prompt) {
  if (isSnapshotPrompt(prompt)) return buildSnapshotPayload(prompt)
  if (isReviewPrompt(prompt)) return buildReviewResult(prompt)
  if (isDimensionReviewPrompt(prompt)) return buildDimensionReviewResult(prompt)
  if (isRefinePrompt(prompt)) return buildRefinePayload()

  const chapterNumber = detectChapterNumber(prompt)
  const stickyFailing = prompt.includes(MARKERS.manualGate)
  const failing = prompt.includes(MARKERS.failGate) || stickyFailing

  if (prompt.includes(MARKERS.taskBrief)) return buildTaskBrief(chapterNumber, failing)
  if (prompt.includes(MARKERS.revision)) {
    return buildChapter({ chapterNumber, leakingFact: stickyFailing, polished: true })
  }
  if (prompt.includes(MARKERS.expansion)) return buildChapter({ chapterNumber, leakingFact: false, polished: true })
  if (prompt.includes(MARKERS.finalPolish)) return buildChapter({ chapterNumber, leakingFact: false, polished: true })
  if (prompt.includes("FORBIDDEN_FACT_LEAK")) return buildChapter({ chapterNumber, leakingFact: false, polished: true })
  if (prompt.includes(MARKERS.draft)) return buildChapter({ chapterNumber, leakingFact: failing, polished: false })

  return buildChapter({ chapterNumber, leakingFact: failing, polished: false })
}

function writeChunk(res, text) {
  const payload = JSON.stringify({
    id: "mock-stage2-chatcmpl",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })
  res.write(`data: ${payload}\n\n`)
}

async function streamText(res, text, options = {}) {
  const chunkSize = 120
  const delayMs = typeof options.delayMs === "number" ? options.delayMs : 0
  for (let index = 0; index < text.length; index += chunkSize) {
    writeChunk(res, text.slice(index, index + chunkSize))
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  // Final chunk with usage — mimics OpenAI's final chunk carrying token usage.
  // ISS-20260719-002: lets extractOpenAiUsage capture input/output tokens so the
  // token data channel (LlmMetric inputTokens/outputTokens) can be end-to-end
  // exercised against this mock server. Token numbers are synthetic (mock), but
  // the wire format + extraction + flushMetrics pipeline is real.
  const usagePayload = JSON.stringify({
    id: "mock-stage2-chatcmpl",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 42,
      completion_tokens: Math.ceil(text.length / 4),
      total_tokens: 42 + Math.ceil(text.length / 4),
    },
  })
  res.write(`data: ${usagePayload}\n\n`)
  res.write("data: [DONE]\n\n")
  res.end()
}

function isSupportedChatPath(url) {
  return url === "/chat/completions" || url === "/v1/chat/completions"
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !isSupportedChatPath(req.url)) {
    res.statusCode = 404
    res.setHeader("content-type", "application/json; charset=utf-8")
    res.end(JSON.stringify({ error: "not found" }))
    return
  }

  const chunks = []
  req.on("data", (chunk) => chunks.push(chunk))
  req.on("end", () => {
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      body = {}
    }

    const prompt = collectPrompt(body.messages)
    const content = classifyResponse(prompt)
    const slowMode = prompt.includes(MARKERS.slow) || prompt.includes(MARKERS.resumeTest)

    res.statusCode = 200
    res.setHeader("content-type", "text/event-stream; charset=utf-8")
    res.setHeader("cache-control", "no-cache")
    res.setHeader("connection", "keep-alive")
    void streamText(res, content, { delayMs: slowMode ? 300 : 0 })
  })
})

server.listen(PORT, HOST, () => {
  console.log(`mock stage2 llm server listening on http://${HOST}:${PORT}`)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
