// 浏览器/Tauri-webview 环境 node:fs shim（Vite 条件 alias，见 vite.config.ts）。
// 仅当代码路径在浏览器实际触碰 FS 时抛错/降级——生产主路径零 fs（内嵌种子），
// 此 shim 保证模块求值不崩（Vite 外部化 node:* 会在浏览器抛 SyntaxError）。
export const readFileSync = (): never => {
  throw new Error("node:fs unavailable in browser (shim)")
}
export const existsSync = (): boolean => false
export const readdirSync = (): never[] => []
export const writeFileSync = (): never => {
  throw new Error("node:fs unavailable in browser (shim)")
}
export const mkdirSync = (): never => {
  throw new Error("node:fs unavailable in browser (shim)")
}
export const rmSync = (): never => {
  throw new Error("node:fs unavailable in browser (shim)")
}
