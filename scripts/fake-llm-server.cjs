// 本地 fake-LLM：OpenAI 兼容 /v1/chat/completions SSE 流式端点
// 供 QMAI custom provider 指向 localhost:8787 跑通真实 HTTP+SSE transport 链路
const http = require("http")

const PORT = 8787
// 章节生成的确定性正文（含 frontmatter，模拟真实章节产出）
const CHAPTER_BODY = [
  "第二章 雾中的回声",
  "",
  "林深推开吱呀作响的木门，潮湿的空气扑面而来。",
  "屋外雾气浓重，远处的灯塔只剩一点昏黄的光。",
  "他握紧口袋里的黄铜钥匙——那是昨夜在古井边捡到的，",
  "钥匙柄上刻着一行小字：唯有回声知晓归途。",
  "",
  "街角的报童正在叫卖晨报，头条是码头昨夜失踪的第三个人。",
  "林深低头快步走过，心里却清楚，那三个人都与那口古井有关。",
].join("\n")

function sseChunk(content, finish = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
  })}\n\n`
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && /\/(chat\/completions|v1\/chat\/completions)/.test(req.url)) {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      })
      // 分片流式吐出正文（模拟真实流式生成）
      const pieces = CHAPTER_BODY.match(/.{1,40}/gs) || [CHAPTER_BODY]
      let i = 0
      const timer = setInterval(() => {
        if (i < pieces.length) {
          res.write(sseChunk(pieces[i]))
          i++
          return
        }
        clearInterval(timer)
        res.write(sseChunk(null, "stop"))
        res.write("data: [DONE]\n\n")
        res.end()
      }, 30)
    })
    return
  }
  // 健康检查/模型列表
  if (req.method === "GET" && /\/(models|v1\/models)/.test(req.url)) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model-1", object: "model" }] }))
    return
  }
  res.writeHead(404).end("not found")
})

server.listen(PORT, "127.0.0.1", () => console.log(`fake-llm listening http://127.0.0.1:${PORT}`))
