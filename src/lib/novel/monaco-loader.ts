import { loader } from "@monaco-editor/react"

/**
 * 配置 Monaco 在 Tauri webview 下加载（R4 缓解）。
 *
 * - 通过 @monaco-editor/react 的 loader 指定 monaco 的 vs base path；默认走 CDN
 *   (jsdelivr)，Tauri CSP 已放行 connect-src https: 与 worker-src（见 tauri.conf.json）。
 * - 兜底设置 self.MonacoEnvironment.getWorkerUrl，确保 webview 内能加载 editor worker。
 *
 * RPC-2 / TASK-001。建议在应用入口（main.tsx）调用一次；MonacoDiffEditor 挂载时也会
 * 通过 useEffect 调一次（幂等，重复调用无副作用）。
 */
export function configureMonaco(): void {
  const globalScope = self as unknown as {
    MonacoEnvironment?: { getWorkerUrl?: () => string }
  }
  if (!globalScope.MonacoEnvironment) {
    globalScope.MonacoEnvironment = {
      getWorkerUrl: () =>
        "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/base/worker/workerMain.js",
    }
  }

  // 指向 CDN 上的 monaco "vs" 资源目录；如需完全离线，可改为本地 resourceDir 路径。
  loader.config({
    paths: {
      vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs",
    },
  })
}
