#!/usr/bin/env node
// F-005 真机冒烟用本机 HTTP 端点（真实网络往返；不依赖任何外部服务）。
//
//   node scripts/smoke-f005-endpoint.mjs <port> <logPath>
//
// 行为：
//   - 普通路径：读取完整请求体，回 `{"jsonrpc":"2.0","result":{"echo":<len>}}`
//   - `/big`  ：回 5MB 响应体，用于验证远端响应超限拒绝（MAX_RESPONSE_BYTES = 4MB）
//   - 每次请求向 <logPath> 追加一行 JSONL：method / path / authorization 是否存在 /
//     content-type / accept / 请求体字节数 / 响应字节数
import { createServer } from "node:http"
import { appendFileSync, writeFileSync } from "node:fs"

const port = Number(process.argv[2] ?? 8791)
const logPath = process.argv[3] ?? "smoke-f005-endpoint.jsonl"
const BIG = 5 * 1024 * 1024

writeFileSync(logPath, "")

const server = createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const body = Buffer.concat(chunks)
    const big = (req.url ?? "").includes("big")
    const payload = big
      ? JSON.stringify({ jsonrpc: "2.0", result: { filler: "x".repeat(BIG) } })
      : JSON.stringify({ jsonrpc: "2.0", result: { echo: body.length } })

    appendFileSync(
      logPath,
      JSON.stringify({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization ?? null,
        contentType: req.headers["content-type"] ?? null,
        accept: req.headers.accept ?? null,
        bodyBytes: body.length,
        bodyPreview: body.toString("utf8").slice(0, 120),
        responseBytes: Buffer.byteLength(payload),
      }) + "\n",
    )

    res.writeHead(200, { "content-type": "application/json" })
    res.end(payload)
  })
})

server.listen(port, "127.0.0.1", () => {
  console.log(`f005 smoke endpoint listening on http://127.0.0.1:${port} (log: ${logPath})`)
})
