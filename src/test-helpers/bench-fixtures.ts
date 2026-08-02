/**
 * Benchmark fixture generators for QMAI performance testing.
 *
 * Generates synthetic Chinese long-text documents, fake embeddings, and
 * preset query sets used across multiple bench files.
 *
 * Run: npx vitest run src/test-helpers/*.bench.ts src/lib/*.bench.ts src/lib/novel/*.bench.ts
 */

// ---------------------------------------------------------------------------
// Scale constants
// ---------------------------------------------------------------------------

export const SMALL = 100
export const MEDIUM = 1000
export const LARGE = 10000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchDocument {
  id: string
  title: string
  content: string
}

export interface BenchQuery {
  text: string
  type: "zh" | "en" | "mixed"
}

// ---------------------------------------------------------------------------
// Chinese text fragments for synthetic document generation
// ---------------------------------------------------------------------------

const ZH_FRAGMENTS = [
  "默会知识是指那些无法轻易用语言表达的知识，它们深深嵌入我们的行动与实践之中。波兰尼认为，我们所知远比我们所能言说的要多。",
  "在复杂的软件系统中，状态管理是最容易出错的部分之一。单向数据流和不可变状态模式能够显著降低认知负担。",
  "大语言模型通过海量文本训练获得了广泛的知识，但在具体领域的应用中仍然需要检索增强生成来提升准确性。",
  "向量数据库通过近似最近邻搜索实现高效的语义检索，常用的索引结构包括 HNSW、IVF 和 PQ 等。",
  "注意力机制允许模型在处理序列数据时动态地关注不同位置的信息，从而捕获长距离依赖关系。",
  "知识图谱以结构化的方式存储实体和关系，支持多跳推理和复杂查询，是企业知识管理的重要基础设施。",
  "分布式系统中的一致性问题需要通过共识算法来解决，Raft 和 Paxos 是两种经典的解决方案。",
  "微服务架构将单体应用拆分为独立部署的服务，每个服务负责特定的业务领域，通过 API 网关统一入口。",
  "代码重构是在不改变外部行为的前提下改善代码内部结构的过程，测试覆盖是安全重构的前提条件。",
  "自然语言处理中的分词是中文文本处理的基础步骤，基于词典的方法和基于统计的方法各有优劣。",
  "深度学习模型训练过程中，学习率调度策略对最终性能有重要影响，常用的有余弦退火和阶梯衰减等方法。",
  "全文检索引擎通过倒排索引实现关键词匹配，BM25 是经典的文本相关性评分函数。",
  "在 Tauri 桌面应用框架中，前端与 Rust 后端通过 IPC 通道通信，序列化开销是需要关注的性能因素。",
  "函数式编程强调纯函数和不可变数据，这使得代码更容易测试和推理，适合构建可靠的并发系统。",
  "Transformer 架构通过自注意力机制取代了传统的循环结构，大幅提升了序列建模的并行度和效果。",
]

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generate `count` synthetic documents with Chinese long-text content
 * (500-2000 chars each). Deterministic given the same count.
 */
export function generateDocuments(count: number): BenchDocument[] {
  const docs: BenchDocument[] = []
  for (let i = 0; i < count; i++) {
    const fragCount = 3 + (i % 5) // 3-7 fragments per doc -> ~500-2000 chars
    const parts: string[] = []
    for (let f = 0; f < fragCount; f++) {
      const pool = ZH_FRAGMENTS
      parts.push(pool[(i * 3 + f * 7) % pool.length])
    }
    docs.push({
      id: `doc-${i}`,
      title: `${ZH_FRAGMENTS[i % ZH_FRAGMENTS.length].slice(0, 10)}-${i}`,
      content: parts.join("\n\n"),
    })
  }
  return docs
}

/**
 * Generate `count` fake embedding vectors of dimension `dim`.
 * Uses deterministic pseudo-random values so results are reproducible.
 */
export function generateEmbeddings(
  count: number,
  dim: number = 384,
): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < count; i++) {
    const vec = new Float32Array(dim)
    for (let d = 0; d < dim; d++) {
      // Simple deterministic hash-like function
      const x = Math.sin(i * 12.9898 + d * 78.233) * 43758.5453
      vec[d] = (x - Math.floor(x)) * 2 - 1
    }
    // Normalize to unit vector
    let norm = 0
    for (let d = 0; d < dim; d++) norm += vec[d] * vec[d]
    const invNorm = 1 / Math.sqrt(norm)
    for (let d = 0; d < dim; d++) vec[d] *= invNorm
    out.push(vec)
  }
  return out
}

/**
 * Return a preset set of 20 benchmark queries covering Chinese, English,
 * and mixed-language patterns.
 */
export function getQuerySet(): BenchQuery[] {
  return [
    { text: "默会知识", type: "zh" },
    { text: "向量检索", type: "zh" },
    { text: "注意力机制", type: "zh" },
    { text: "知识图谱推理", type: "zh" },
    { text: "分布式一致性", type: "zh" },
    { text: "代码重构策略", type: "zh" },
    { text: "深度学习训练", type: "zh" },
    { text: "全文搜索引擎", type: "zh" },
    { text: "自然语言分词", type: "zh" },
    { text: "函数式编程范式", type: "zh" },
    { text: "retrieval augmented generation", type: "en" },
    { text: "vector embedding search", type: "en" },
    { text: "transformer architecture", type: "en" },
    { text: "Rust ownership model", type: "en" },
    { text: "microservice decomposition", type: "en" },
    { text: "Tauri IPC 通信", type: "mixed" },
    { text: "HNSW 近似搜索", type: "mixed" },
    { text: "BM25 相关性评分", type: "mixed" },
    { text: "Raft 共识算法实现", type: "mixed" },
    { text: "Transformer 自注意力 self-attention", type: "mixed" },
  ]
}
