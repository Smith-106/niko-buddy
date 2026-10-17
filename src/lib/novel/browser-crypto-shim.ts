// 浏览器/Tauri-webview 环境 node:crypto shim（Vite 条件 alias，见 vite.config.ts）。
// 仅当代码路径在浏览器实际触碰 node:crypto 时抛错/降级。
// 保证模块求值不崩（Vite 外部化 node:* 会在浏览器抛 SyntaxError）。
export const createHash = (_alg?: string): never => {
  throw new Error("node:crypto unavailable in browser (shim)")
}
// randomUUID 有 Web Crypto 等价实现，安全可补（Node 文档确认其即 CSPRNG UUIDv4）。
// 非安全上下文（crypto.randomUUID 不可用）时降级为 getRandomValues/Math.random 拼 RFC4122 v4，
// 保证调用方永不崩（ inspiration-entry 在运行时调用，不是启动路径，但同样 fail-open ）。
export function randomUUID(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  const rand = c?.getRandomValues
    ? () => c.getRandomValues(new Uint8Array(1))[0]
    : () => Math.floor(Math.random() * 256)
  const b = Array.from({ length: 16 }, rand)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
