import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "@/components/error-boundary";
import { ToastProvider } from "@/lib/toast";
import "./index.css";
import "@/i18n";
import { warmClaudeCliTimeouts } from "@/lib/claude-cli-transport";
import { installStateBridge } from "@/lib/mcp/state-bridge";
import { startModuleHeatFlushLoop, useModuleHeatStore } from "@/stores/module-heat-store";
import { useWikiStore } from "@/stores/wiki-store";

// C-101 (GRL-008): pull configurable CLI transport timeouts from app-state at
// startup. Non-blocking — defaults remain in effect until this resolves.
void warmClaudeCliTimeouts();

// MCP 状态桥（方案 d23eb1df）：Rust 侧 MCP 服务端读 WebView 设置时经此往返。
// 同样非阻塞——桥装不上只意味着 settings.* 工具会报超时，不应拖住应用启动。
void installStateBridge().catch((error) => {
  console.error("[mcp-state-bridge] 安装失败", error);
});

// TASK-006: 运行热力 sink 必须在启动时安装（幂等、零 IO）。只装在热力图视图里时，
// 未打开该页 sink 恒为 null，campaign-runner / incubator / director 等埋点全是 no-op。
useModuleHeatStore.getState().install();

// TASK-006: 落盘同样脱离视图——热力视图不挂载时也要按 shouldFlushHeat 的窗口写快照。
// 节流判定复用 store 里的纯函数，这里只提供「app 级心跳 + 现取项目路径」。
// 每个 tick 内部先 hydrate 再判定落盘（B5）：快照是整文件覆盖写，没回填就写会抹掉上次会话窗口。
const stopModuleHeatFlushLoop = startModuleHeatFlushLoop(
  () => useWikiStore.getState().project?.path ?? null,
);

/** 退出前补一次落盘（B8）：轮询窗口（≤15s）内最后一批命中不必留到下次启动。 */
function flushModuleHeatOnExit(): void {
  const projectPath = useWikiStore.getState().project?.path ?? null;
  if (!projectPath) return;
  // flush 自身保证「先回填再写」且单飞（B5/B14），与轮询并发时复用同一次在飞写盘。
  void useModuleHeatStore.getState().flush(projectPath);
}

// pagehide 覆盖关闭窗口/切页/移动端回收，beforeunload 覆盖桌面 Tauri 关闭路径；两者都幂等。
window.addEventListener("pagehide", flushModuleHeatOnExit);
window.addEventListener("beforeunload", flushModuleHeatOnExit);

// HMR 热替换时先停心跳，避免多份定时器叠加写同一份快照。
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopModuleHeatFlushLoop());
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
