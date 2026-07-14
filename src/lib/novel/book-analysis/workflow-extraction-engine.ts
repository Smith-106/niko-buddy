/**
 * 基于 Workflow 的角色提取引擎（并行版本）
 * 使用 Claude Code Workflow 并行处理多个章节
 */

import type { LlmConfig } from "@/stores/wiki-store"
import type { ExtractedCharacter, BookAnalysisMetadata } from "./types"
import { readFile } from "@/commands/fs"
import { joinPath } from "@/lib/path-utils"
import { logger } from "@/lib/utils"

export interface WorkflowExtractionInput {
  bookPath: string
  selectedChapterIds: string[]
  metadata: BookAnalysisMetadata
  llmConfig: LlmConfig
  onProgress?: (progress: {
    stage: string
    stageLabel: string
    completed: number
    total: number
    percentage: number
    currentItem?: string
  }) => void
  signal?: AbortSignal
}

export interface WorkflowExtractionResult {
  success: boolean
  characters: ExtractedCharacter[]
  /**
   * ISS-20260712-MAINT-2: 当 Workflow 后端未实现时, success=false 且
   * notImplemented=true。区别于"提取执行了但无角色"(success=false, notImplemented
   * 缺省)——调用方可据此区分"功能未落地"与"执行后空结果"。
   */
  notImplemented?: boolean
}

/**
 * 使用 Workflow 并行提取角色（推荐方式）
 */
export async function extractCharactersWithWorkflow(
  input: WorkflowExtractionInput
): Promise<WorkflowExtractionResult> {
  const {
    bookPath,
    selectedChapterIds,
    onProgress,
    signal,
  } = input

  try {
    // 1. 加载章节内容
    onProgress?.({
      stage: "loading",
      stageLabel: "加载章节内容",
      completed: 0,
      total: selectedChapterIds.length,
      percentage: 0,
    })

    const chaptersDir = joinPath(bookPath, "chapters")
    const chapters = []

    for (let i = 0; i < selectedChapterIds.length; i++) {
      if (signal?.aborted) {
        throw new Error("用户取消分析")
      }

      const chapterId = selectedChapterIds[i]
      const chapterPath = joinPath(chaptersDir, `${chapterId}.txt`)

      try {
        const content = await readFile(chapterPath)

        // 从 ID 推断章节信息
        const chapterOrder = i + 1
        const chapterTitle = `第${chapterOrder}章`

        if (content) {
          chapters.push({
            id: chapterId,
            title: chapterTitle,
            content: content.substring(0, 10000), // 限制长度避免 token 过多
            order: chapterOrder,
          })
        }
      } catch (err) {
        logger.error("Workflow Extraction", `加载章节 ${chapterId} 失败`, { error: err instanceof Error ? err.message : String(err) })
      }

      onProgress?.({
        stage: "loading",
        stageLabel: "加载章节内容",
        completed: i + 1,
        total: selectedChapterIds.length,
        percentage: ((i + 1) / selectedChapterIds.length) * 20, // 占20%进度
        currentItem: `第${i + 1}章`,
      })
    }

    if (chapters.length === 0) {
      return {
        success: false,
        characters: [],
      }
    }

    // 2. 调用 Workflow（这里暂时用注释，因为 Workflow 工具在前端不可用）
    // 实际应该通过 Tauri 命令调用后端，后端再调用 Workflow
    onProgress?.({
      stage: "workflow",
      stageLabel: "Workflow 并行分析",
      completed: 0,
      total: 100,
      percentage: 20,
      currentItem: "启动 Workflow...",
    })

    // TODO: 实际项目中应该：
    // const result = await invoke("run_workflow", {
    //   scriptPath: ".claude/workflows/book-analysis-parallel.js",
    //   args: {
    //     chapters,
    //     bookMetadata: {
    //       title: input.metadata.title,
    //       author: input.metadata.author,
    //     },
    //     outputDir: bookPath,
    //   }
    // })

    // 暂时返回未实现状态——Workflow 工具在前端不可用, 实际实现需经 Tauri
    // 命令调后端 Workflow (见上方 TODO)。返回 success:false 明确告知调用方
    // 功能未落地, 避免 success:true + 空 characters 误导(以为提取成功实则空)。
    // isWorkflowSupported() 返回 false 也印证此模块当前不可用。
    onProgress?.({
      stage: "workflow",
      stageLabel: "Workflow 未实现(跳过)",
      completed: 100,
      total: 100,
      percentage: 100,
      currentItem: "功能未落地",
    })

    return {
      success: false,
      characters: [],
      notImplemented: true,
    }
  } catch (error) {
    logger.error("Workflow Extraction", "Workflow 提取失败", { error: error instanceof Error ? error.message : String(error) })
    return {
      success: false,
      characters: [],
    }
  }
}

/**
 * 检测是否支持 Workflow
 * 在实际项目中，应该检查是否在 Claude Code 环境中
 */
export function isWorkflowSupported(): boolean {
  // TODO: 实际检测逻辑
  // 可以尝试调用一个测试命令来确认
  return false // 暂时返回 false，等后端支持后改为 true
}
