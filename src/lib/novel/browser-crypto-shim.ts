// 浏览器/Tauri-webview 环境 node:crypto shim（Vite 条件 alias，见 vite.config.ts）。
// 仅当代码路径在浏览器实际触碰 node:crypto 时抛错/降级。
// 保证模块求值不崩（Vite 外部化 node:* 会在浏览器抛 SyntaxError）。
export const createHash = (_alg?: string): never => {
  throw new Error("node:crypto unavailable in browser (shim)")
}
