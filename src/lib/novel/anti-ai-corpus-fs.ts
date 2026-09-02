// 反 AI 候选池的 FS 扫描路径（隔离 node:fs/path/url——浏览器/Tauri-webview 不可用）。
// 仅 Node 环境（测试/本地工具）import 本模块；生产主路径走内嵌种子（零 fs）。
// 浏览器 bundle 不静态可达本模块（pool 模块动态 import），避免 Vite 外部化崩溃。
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { CorpusSample } from "./anti-ai-candidate-pool"

/**
 * 语料根目录惰性解析 (相对项目根 niko-hub)。
 * webview (tauri://) 下 import.meta.url 非 file:// → fileURLToPath 抛
 * ERR_INVALID_URL；原模块级求值会使整模块加载失败，现收敛到函数内 try/catch。
 * 仅 FS 扫描路径需要；内嵌种子路径不依赖此值。
 */
export function resolveDefaultCorpusRoot(): string | null {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/p0/corpus")
  } catch {
    return null // webview：无文件系统语义，FS 路径不可达
  }
}

/**
 * 从语料目录加载某层 (human/ai/gold) 的样本。
 * 每批格式: {layer}/batch-{id}/{genre}-NNN.txt
 */
export function loadCorpusLayer(
  corpusRoot: string,
  layer: "human" | "ai" | "gold",
  batchIds: string | string[],
): CorpusSample[] {
  const ids = Array.isArray(batchIds) ? batchIds : [batchIds]
  const samples: CorpusSample[] = []
  for (const batchId of ids) {
    const layerDir = resolve(corpusRoot, layer, `batch-${batchId}`)
    if (!existsSync(layerDir)) {
      console.warn(`[anti-ai-candidate-pool] 语料层目录不存在: ${layerDir}`)
      continue
    }

    const files = readdirSync(layerDir).filter((f) => f.endsWith(".txt") || f.endsWith(".json"))

    for (const file of files) {
      const filePath = resolve(layerDir, file)
      try {
        const text = readFileSync(filePath, "utf-8")
        // 跳过 JSON 金标准 (structure-only, 不能用作文本分析)
        if (file.endsWith(".json")) continue
        // 提取 genre 从文件名: {genre}-NNN.txt
        const genreMatch = file.match(/^([a-z]+)-\d+/)
        const genre = genreMatch ? genreMatch[1] : "unknown"
        // 粗略字数
        const words = text.replace(/\s+/g, "").length

        samples.push({
          file,
          genre,
          layer,
          text,
          words,
          source: "synthetic-degraded",
          batchId,
        })
      } catch {
        console.warn(`[anti-ai-candidate-pool] 读取失败: ${filePath}`)
      }
    }
  }
  return samples
}
