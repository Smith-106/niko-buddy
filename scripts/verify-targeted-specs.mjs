// #4 配套：以 QMAI 为 cwd 跑 4 个目标 spec。
// 背景：`npm --prefix QMAI exec vitest` 不切换 cwd，vitest 在工作区根解析会误杀
// niko-hub-unified-export-center 的外包 spec；`cd QMAI;` 又依赖具体 shell 语法。
// 本脚本用 node 显式指定 cwd + 本地 vitest 二进制，全平台行为一致。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const qmai = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntry = path.join(qmai, "node_modules", "vitest", "vitest.mjs");
if (!fs.existsSync(vitestEntry)) {
  console.error(`FAIL: 找不到本地 vitest 入口：${vitestEntry}`);
  process.exit(1);
}
const files = [
  "src/components/novel/work-heatmap-panel.spec.tsx",
  "src/components/novel/module-heatmap-view.spec.tsx",
  "src/lib/novel/work-heatmap-projection.spec.ts",
  "src/lib/novel/novel-session-status.spec.ts",
];
try {
  execFileSync(process.execPath, [vitestEntry, "run", ...files], { cwd: qmai, stdio: "inherit" });
  console.log("PASS: 4 个目标 spec 全绿（cwd=QMAI，无外包污染）");
} catch {
  console.error("FAIL: 目标 spec 未全绿");
  process.exit(1);
}
