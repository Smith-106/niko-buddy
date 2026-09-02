// 浏览器/Tauri-webview 环境 node:url shim（Vite 条件 alias，见 vite.config.ts）。
// fileURLToPath 在 webview（tauri:// 协议）下本就不可用——抛错由调用方 try/catch 降级。
export function fileURLToPath(): never {
  throw new Error("node:url unavailable in browser (shim)")
}
