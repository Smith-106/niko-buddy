/**
 * Token 计量：按字符脚本分类的校准估算 + 可选的 provider 原生精确计数。
 *
 * ## 为什么不是 BPE
 *
 * 真正的 BPE tokenizer 需要厂商 vocab 文件（cl100k_base 约 1.6MB，且各模型不同），
 * 项目约束禁止新增依赖，因此本地路径是**按字符脚本分类的校准估算**，不是 BPE。
 * 需要精确值时用 `countTokensExact()` 走 provider 自己的 tokenizer（服务端真值，
 * 零依赖），代价是一次额外 HTTP 往返，不适合放进每次请求的热路径。
 *
 * ## 旧实现的问题
 *
 * 原先一律 `Math.ceil(content.length / 3)`。对英文大致合理（约 4 字符/token），
 * 对中文严重低估：cl100k 系 tokenizer 处理中文约 1 字符/token，于是
 * 「13 个汉字的句子」被估成 5 token 而实际约 13 token —— **低估约 2.6 倍**。
 * 预算按低估值放行，实际发送量可达预算的 2 倍以上，撞上游 400。
 *
 * ## 校准口径
 *
 * 以 cl100k_base / Claude / Gemini 的共同行为为基准，取**偏保守（宁高勿低）**：
 *   汉字/假名/谚文（CJK）  1.0 token/字符
 *   ASCII 字母与数字        0.25 token/字符（4 字符/token）
 *   其余符号/标点/emoji     0.5 token/字符
 *   每条消息固定开销        4 token（role、分隔符、消息边界）
 *
 * 偏保守是刻意的：低估会让请求被上游拒绝（硬失败），高估只是少用一点上下文
 * （软损失）。两者的代价不对称，所以宁可高估。
 */

/** 每条消息的固定结构开销（role 标记、分隔符、消息边界）。 */
export const PER_MESSAGE_TOKEN_OVERHEAD = 4

/**
 * CJK 字符判定：汉字（含扩展 A/兼容区）、平假名、片假名、谚文、全角标点。
 *
 * 覆盖范围说明：
 *   U+3400–U+4DBF   CJK 扩展 A
 *   U+4E00–U+9FFF   CJK 基本区
 *   U+F900–U+FAFF   CJK 兼容汉字
 *   U+3040–U+30FF   平假名 + 片假名
 *   U+AC00–U+D7AF   谚文音节
 *   U+1100–U+11FF   谚文字母
 *   U+3000–U+303F   CJK 标点（含「」『』、。等）
 *   U+FF00–U+FFEF   全角字符
 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef)
  )
}

/** ASCII 字母、数字与常见空白（这些在 BPE 里通常能合并成较短序列）。 */
function isAsciiWordChar(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    cp === 0x20 || // 空格
    cp === 0x09 || // tab
    cp === 0x0a || // LF
    cp === 0x0d || // CR
    cp === 0x5f // underscore
  )
}

/**
 * 估算一段文本的 token 数。
 *
 * 空字符串返回 0；只含空白时返回最小值 1（多数 tokenizer 至少产出 1 个 token）。
 * 结果向上取整并至少为 1，避免「非空文本估成 0 token」导致预算失效。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0

  let cjk = 0
  let asciiWord = 0
  let other = 0

  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    if (isCjkCodePoint(cp)) cjk++
    else if (isAsciiWordChar(cp)) asciiWord++
    else other++
  }

  const raw = cjk * 1.0 + asciiWord * 0.25 + other * 0.5
  return Math.max(1, Math.ceil(raw))
}

/**
 * 估算单条聊天消息的 token 数（含内容、工具调用参数、推理内容与固定开销）。
 *
 * 工具调用参数按 JSON 字符串计——它们确实会进请求体，漏计会让多轮工具循环
 * 的预算失真。
 */
export function estimateMessageTokens(message: {
  content: unknown
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
  reasoning_content?: string
  name?: string
}): number {
  let total = PER_MESSAGE_TOKEN_OVERHEAD

  const content = message.content
  if (typeof content === "string") {
    total += estimateTokens(content)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: string; text?: string; dataBase64?: string }
      if (b?.type === "text" && typeof b.text === "string") {
        total += estimateTokens(b.text)
      } else if (b?.type === "image") {
        // 图像按 base64 长度折算会严重高估（图像 token 取决于分辨率而非字节数）。
        // 用一个中性常量，避免把预算全部吃掉。
        total += IMAGE_BLOCK_TOKEN_ESTIMATE
      }
    }
  }

  if (message.reasoning_content) total += estimateTokens(message.reasoning_content)

  if (message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      if (call?.function?.name) total += estimateTokens(call.function.name)
      if (call?.function?.arguments) total += estimateTokens(call.function.arguments)
      total += PER_MESSAGE_TOKEN_OVERHEAD
    }
  }

  return total
}

/**
 * 图像块的估算 token 数。
 *
 * 实际值取决于分辨率与厂商（Anthropic 约 (w×h)/750，OpenAI 低/高细节各有公式）。
 * 这里取一个中性偏低的常量：图像不该被当作主要预算消耗项，但也不能当 0。
 */
export const IMAGE_BLOCK_TOKEN_ESTIMATE = 800

/**
 * 估算消息数组的 token 总量。这是 `estimateChatMessagesTokens` 的替代实现，
 * 口径从「字符数 / 3」改为按脚本分类校准。
 */
export function estimateMessagesTokens(
  messages: Array<{
    content: unknown
    tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
    reasoning_content?: string
    name?: string
  }>,
): number {
  let total = 0
  for (const message of messages) total += estimateMessageTokens(message)
  return total
}

/** 请求脚手架（工具定义等）的 token 估算。 */
export function estimateScaffoldTokens(scaffold: unknown): number {
  if (!scaffold) return 0
  try {
    return estimateTokens(JSON.stringify(scaffold))
  } catch {
    return 0
  }
}

/**
 * 把「token 预算」折算成等效字符预算。
 *
 * 用于复用既有的字符裁剪机制：先按真实文本的 tokens/char 比率换算，
 * 再交给字符裁剪器。比率取自待裁剪文本自身，而不是固定常量——同一份预算
 * 在纯中文与纯英文下对应的字符数相差数倍。
 *
 * @param messages 待裁剪的消息（用于取实际比率）
 * @param maxTokens token 预算
 * @returns 等效字符预算；文本为空时返回 maxTokens（无内容可裁）
 */
export function tokensToCharBudget(
  messages: Array<{ content: unknown; tool_calls?: unknown; reasoning_content?: string }>,
  maxTokens: number,
): number {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return 0

  let chars = 0
  for (const message of messages) {
    if (typeof message.content === "string") chars += message.content.length
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const b = block as { type?: string; text?: string }
        if (b?.type === "text" && typeof b.text === "string") chars += b.text.length
      }
    }
  }
  if (chars === 0) return maxTokens

  const tokens = estimateMessagesTokens(messages as never)
  if (tokens <= 0) return maxTokens

  const charsPerToken = chars / tokens
  return Math.max(1, Math.floor(maxTokens * charsPerToken))
}

/**
 * 精确 token 计数的请求构造（provider 自己的 tokenizer，零依赖）。
 *
 * 与本地估算的区别：这是**真值**，但要多一次 HTTP 往返，所以不放进每次请求的
 * 热路径，只作为 opt-in 工具供需要精确预算的场景调用。
 *
 * 目前提供 Anthropic 与 Gemini 两家——它们有公开的计数端点。
 * OpenAI 没有计数端点，只能靠本地估算或自行引入 vocab。
 */
export interface CountTokensRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** Anthropic 的 messages 计数端点。 */
export function buildAnthropicCountTokensRequest(params: {
  baseUrl: string
  apiKey: string
  model: string
  text: string
}): CountTokensRequest {
  const base = params.baseUrl.replace(/\/+$/, "")
  return {
    url: `${base}/v1/messages/count_tokens`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": params.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: params.model,
      messages: [{ role: "user", content: params.text }],
    },
  }
}

/** Gemini 的 countTokens 端点。 */
export function buildGoogleCountTokensRequest(params: {
  baseUrl: string
  apiKey: string
  model: string
  text: string
}): CountTokensRequest {
  const base = params.baseUrl.replace(/\/+$/, "")
  const model = encodeURIComponent(params.model)
  return {
    url: `${base}/v1beta/models/${model}:countTokens`,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": params.apiKey,
    },
    body: {
      contents: [{ parts: [{ text: params.text }] }],
    },
  }
}

/**
 * 解析计数端点的响应。
 *
 * Anthropic 回 `{ input_tokens }`；Gemini 回 `{ totalTokens }`。
 * 两者都拿不到时返回 null，由调用方回退到本地估算。
 */
export function parseCountTokensResponse(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as { input_tokens?: unknown; totalTokens?: unknown }
  if (typeof p.input_tokens === "number" && Number.isFinite(p.input_tokens)) {
    return p.input_tokens
  }
  if (typeof p.totalTokens === "number" && Number.isFinite(p.totalTokens)) {
    return p.totalTokens
  }
  return null
}
