/**
 * AI 会话绑定
 *
 * 将一个 StoryFramework 绑定到目标章节数，把章节按"起承转合"节点
 * 分配，并把绑定信息 + 框架上下文注入到 AI 写作会话中。
 */

import { createDirectory, deleteFile, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { chunkFingerprint } from "@/lib/chunk-fingerprint"
import type {
  BindingStaleness,
  BranchCanonBinding,
  ChapterAllocation,
  FrameworkBinding,
  StoryFramework,
} from "./types"

const BINDING_FILE = ".qmai/simulations/bindings/active-binding.json"

function bindingFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${BINDING_FILE}`
}

/**
 * 将 targetChapterCount 分配到各节点：
 * baseChaptersPerNode = floor(target / nodeCount)，余数依次分配给前面的节点。
 */
function allocateChapters(
  nodes: StoryFramework["nodes"],
  targetChapterCount: number,
): ChapterAllocation[] {
  const sorted = [...nodes].sort((a, b) => a.index - b.index)
  if (sorted.length === 0) return []

  const base = Math.floor(targetChapterCount / sorted.length)
  const remainder = targetChapterCount % sorted.length

  const allocations: ChapterAllocation[] = []
  let cursor = 1
  for (let i = 0; i < sorted.length; i++) {
    const count = base + (i < remainder ? 1 : 0)
    const startChapter = cursor
    const endChapter = cursor + count - 1
    allocations.push({
      nodeIndex: sorted[i].index,
      nodeTitle: sorted[i].title,
      startChapter,
      endChapter,
    })
    cursor += Math.max(count, 0)
  }
  return allocations
}

/** 读取当前激活的框架绑定，不存在时返回 null。 */
export async function loadBinding(
  projectPath: string,
): Promise<FrameworkBinding | null> {
  try {
    const content = await readFile(bindingFilePath(projectPath))
    const parsed = JSON.parse(content) as FrameworkBinding
    if (!parsed || !parsed.frameworkId) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 保存绑定：根据框架节点与目标章节数生成章节分配，写入绑定文件。
 */
export async function saveBinding(
  projectPath: string,
  framework: StoryFramework,
  targetChapterCount: number,
): Promise<FrameworkBinding> {
  const chapterAllocation = allocateChapters(framework.nodes, targetChapterCount)
  const binding: FrameworkBinding = {
    frameworkId: framework.id,
    frameworkTitle: framework.title,
    targetChapterCount,
    chapterAllocation,
    boundAt: new Date().toISOString(),
  }

  // createDirectory 使用 create_dir_all，会递归创建 .qmai/simulations/bindings
  await createDirectory(
    `${normalizePath(projectPath)}/.qmai/simulations/bindings`,
  )
  await writeFileAtomic(bindingFilePath(projectPath), JSON.stringify(binding, null, 2))
  return binding
}

/** 清除当前激活的框架绑定。 */
export async function clearBinding(projectPath: string): Promise<void> {
  try {
    await deleteFile(bindingFilePath(projectPath))
  } catch {
    // 绑定文件可能不存在
  }
}

/**
 * 构建注入 AI 会话的上下文文本：
 * 框架标题 + 目标章节数 + 章节分配表（第X-Y章 → 起承转合节点）+ 要求。
 */
export function buildBindingContext(
  binding: FrameworkBinding,
  framework: StoryFramework,
): string {
  const lines: string[] = []
  lines.push("# 故事框架绑定")
  lines.push("")
  lines.push(`- 框架标题：${framework.title}`)
  lines.push(`- 目标章节数：${binding.targetChapterCount}`)
  lines.push("")
  lines.push("## 章节分配")
  for (const allocation of binding.chapterAllocation) {
    const node = framework.nodes.find((n) => n.index === allocation.nodeIndex)
    const phaseLabel = node ? `【${node.phase}】` : ""
    const range =
      allocation.endChapter < allocation.startChapter
        ? "无章节分配"
        : allocation.startChapter === allocation.endChapter
          ? `第${allocation.startChapter}章`
          : `第${allocation.startChapter}-${allocation.endChapter}章`
    lines.push(`- ${range} → ${phaseLabel}${allocation.nodeTitle}`)
  }
  lines.push("")
  lines.push("## 要求")
  lines.push("- 请严格遵循上述故事框架推进剧情，按章节分配在对应节点完成相应情节。")
  lines.push("- 保持各节点核心冲突与预期结果的连贯性。")
  return lines.join("\n")
}

// ============================================================================
// 64 号实施（63 号共识 §6 缺口 14）：分支正史绑定 + stale 半环
// ============================================================================

const BRANCH_CANON_FILE = ".qmai/simulations/bindings/branch-canon.json"

function branchCanonFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${BRANCH_CANON_FILE}`
}

/**
 * 计算框架确定性签名（内容级：id/title/premise/targetWords/sourceChapters/
 * nodes 全量序列化 + SHA-256）。同框架同签名；内容变更 → 签名变更。
 */
export function computeFrameworkSignature(framework: StoryFramework): string {
  const canonical = JSON.stringify({
    id: framework.id,
    title: framework.title,
    premise: framework.premise,
    targetWords: framework.targetWords,
    sourceChapters: framework.sourceChapters,
    nodes: framework.nodes.map((n) => ({
      index: n.index,
      phase: n.phase,
      title: n.title,
      coreConflict: n.coreConflict,
      involvedCharacters: n.involvedCharacters,
      goal: n.goal,
      causeFromPrev: n.causeFromPrev,
      expectedOutcome: n.expectedOutcome,
    })),
  })
  return chunkFingerprint(canonical)
}

/**
 * 生成分支正史绑定（纯函数；accept 动作的固化记录）。
 * Draft-first：仅在用户 accept 分支时调用，不自动产生。
 */
export function createBranchCanonBinding(
  framework: StoryFramework,
  branchId: string,
  opts: { acceptedAt?: string; canonStartChapter?: number } = {},
): BranchCanonBinding {
  return {
    branchId,
    frameworkId: framework.id,
    frameworkSignature: computeFrameworkSignature(framework),
    acceptedAt: opts.acceptedAt ?? new Date().toISOString(),
    ...(opts.canonStartChapter !== undefined ? { canonStartChapter: opts.canonStartChapter } : {}),
  }
}

/**
 * stale 半环检测（纯函数确定性）：
 * 1. 框架绑定 stale ⇔ 当前框架签名 ≠ 绑定记录的框架签名；
 * 2. 分支绑定 stale ⇔ 框架绑定 stale 或 分支绑定引用的签名 ≠ 当前签名。
 * 半环不闭环（无第二真源）：检测只读，绝不自动改写正式层。
 */
export function detectBindingStaleness(
  binding: FrameworkBinding | null,
  branchBindings: readonly BranchCanonBinding[],
  framework: StoryFramework,
): BindingStaleness {
  const reasons: string[] = []
  const currentSig = computeFrameworkSignature(framework)

  let frameworkBindingStale = false
  if (!binding) {
    frameworkBindingStale = true
    reasons.push("无激活框架绑定")
  } else if (binding.frameworkId !== framework.id) {
    frameworkBindingStale = true
    reasons.push(`框架 ID 不匹配：绑定 ${binding.frameworkId} vs 当前 ${framework.id}`)
  } else if (binding.boundAt && !binding.chapterAllocation.length) {
    // 空分配视为异常，不计 stale（由上层处理）
  }

  let branchBindingStale = false
  for (const b of branchBindings) {
    if (b.frameworkId !== framework.id) {
      branchBindingStale = true
      reasons.push(`分支绑定框架不匹配：${b.branchId}`)
    } else if (b.frameworkSignature !== currentSig) {
      branchBindingStale = true
      reasons.push(`框架签名变更（分支 ${b.branchId} 的引用 stale）`)
    }
  }

  return { frameworkBindingStale, branchBindingStale, reasons }
}

/**
 * 按半环结果修剪分支正史绑定（纯函数）：框架签名不匹配或框架 ID 不匹配的
 * 绑定被剔除（保留与被修剪绑定同框架的其余绑定）。返回修剪后的列表。
 */
export function pruneStaleBranchBindings(
  branchBindings: readonly BranchCanonBinding[],
  framework: StoryFramework,
): BranchCanonBinding[] {
  const currentSig = computeFrameworkSignature(framework)
  return branchBindings.filter(
    (b) => b.frameworkId === framework.id && b.frameworkSignature === currentSig,
  )
}

/** 读取分支正史绑定列表（缺失/损坏 → []）。 */
export async function loadBranchCanonBindings(
  projectPath: string,
): Promise<BranchCanonBinding[]> {
  try {
    const raw = await readFile(branchCanonFilePath(projectPath))
    const parsed = JSON.parse(raw) as BranchCanonBinding[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 保存分支正史绑定列表（原子写）。 */
export async function saveBranchCanonBindings(
  projectPath: string,
  bindings: readonly BranchCanonBinding[],
): Promise<void> {
  await createDirectory(`${normalizePath(projectPath)}/.qmai/simulations/bindings`)
  await writeFileAtomic(branchCanonFilePath(projectPath), JSON.stringify(bindings, null, 2))
}
