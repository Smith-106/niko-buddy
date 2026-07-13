import type { LlmConfig } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { streamChat, combineAbortSignals, DEFAULT_LLM_REQUEST_TIMEOUT_MS } from "@/lib/llm-client"

export interface PreviousChapterAnalysis {
  chapterNumber: number
  summary: string
  keyPoints: string[]
  ending: string
  characterStates: string[]
  plotProgress: string
}

/**
 * 读取并分析前几章的完整内容
 */
export async function analyzePreviousChapters(
  projectPath: string,
  currentChapterNumber: number,
  llmConfig: LlmConfig,
  analysisCount: number = 3,
  signal?: AbortSignal,
): Promise<string> {
  if (currentChapterNumber <= 1) return ""

  // 读取前N章的完整内容
  // PERF (odyssey-review): chapters are independent — parallelize searchWiki +
  // readFile per chapter instead of serial await-in-loop (N+1 IPC round-trips
  // → 1 batch). Per-chapter try/catch preserved (one read failure must not abort
  // the others). Order preserved via index mapping.
  const startChapter = Math.max(1, currentChapterNumber - analysisCount)
  const chapters = await Promise.all(
    Array.from({ length: currentChapterNumber - startChapter }, async (_, offset) => {
      const i = startChapter + offset
      try {
        const results = await searchWiki(projectPath, `chapter_number:${i}`)
        if (results.length > 0) {
          const content = await readFile(results[0].path)
          const bodyStart = content.indexOf("---", 4)
          const body = bodyStart >= 0 ? content.slice(bodyStart + 3).trim() : content
          return { number: i, content: body }
        }
      } catch {
        // 忽略读取失败的章节
      }
      return null
    }),
  )
  const previousChapters = chapters.filter((c): c is { number: number; content: string } => c !== null)

  if (previousChapters.length === 0) return ""

  // 构建分析prompt
  const analysisPrompt = buildPreviousChaptersAnalysisPrompt(previousChapters, currentChapterNumber)

  // 调用LLM分析
  let analysis = ""

  await streamChat(
    llmConfig,
    [{ role: "user", content: analysisPrompt }],
    {
      onToken: (token) => { analysis += token },
      onDone: () => {},
      onError: (err) => { console.error("[previous-chapters] LLM error:", err instanceof Error ? err.message : String(err)) },
    },
    combineAbortSignals(signal, AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS)),
  )

  return analysis.trim()
}

function buildPreviousChaptersAnalysisPrompt(
  chapters: Array<{ number: number; content: string }>,
  currentChapterNumber: number,
): string {
  const chaptersText = chapters.map(ch =>
    `## 第${ch.number}章完整正文\n\n${ch.content}`
  ).join("\n\n---\n\n")

  return `你是小说前情分析专家。请仔细阅读并分析以下章节的完整正文，为第${currentChapterNumber}章的写作提供准确的前情上下文。

**分析要求**：
1. **逐章摘要**：用2-3句话总结每一章的核心剧情和关键事件
2. **关键节点提取**：列出重要的剧情转折、冲突、决策和伏笔
3. **最近一章详细分析**（第${currentChapterNumber - 1}章）：
   - 章节结尾：最后发生了什么？人物在做什么？场景在哪里？
   - 人物状态：每个出场人物的当前状态、情绪、处境
   - 剧情推进：本章推进了什么主线/支线？
   - 未解伏笔：有哪些伏笔被提及但未回收？
4. **连贯性要点**：第${currentChapterNumber}章开头必须衔接什么？

**注意**：
- 必须基于实际正文内容，不要脑补
- 保留细节（人物对话、动作、场景描述）
- 关注逻辑链条：因果关系、时间顺序、空间位置

---

${chaptersText}

---

请按照上述4点要求输出分析结果。`
}
