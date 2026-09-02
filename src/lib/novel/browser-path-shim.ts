// 浏览器/Tauri-webview 环境 node:path shim（Vite 条件 alias，见 vite.config.ts）。
// 纯字符串拼接实现（Windows 主力平台）；保证模块求值不崩。
export function resolve(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/")
}
export function dirname(p: string): string {
  const i = p.lastIndexOf("/")
  return i <= 0 ? "." : p.slice(0, i)
}
export function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/")
}
export function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i < 0 ? p : p.slice(i + 1)
}
