// #4 验收：推演遥测进热力图（静态断言，exit 0 才许结案）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const read = (p) => fs.readFileSync(path.join(here, p), "utf8");

// 1) 遥测桥：view 层上报两条 stage_metrics（引擎零改动）
const view = read("../src/components/novel/story-simulation/story-simulation-view.tsx");
for (const s of ['stage: "simulation_agent_run"', 'stage: "simulation_report"', "appendStageMetric(projectPath"]) {
  if (!view.includes(s)) fail(`推演视图缺遥测标记：${s}`);
}

// 2) 标签字典：热力图认识推演阶段
const panel = read("../src/components/novel/work-heatmap-panel.tsx");
for (const s of ["simulation_agent_run", "simulation_report"]) {
  if (!panel.includes(s)) fail(`STAGE_PLAIN 缺推演标签：${s}`);
}

// 3) 泳道提权：simulation 进主链（plan→simulation→draft），退出支撑组
const mod = read("../src/components/novel/module-heatmap-view.tsx");
const main = mod.match(/const MAIN_LANES = \[([\s\S]*?)\]/);
const sup = mod.match(/const SUPPORT_LANES = \[([\s\S]*?)\]/);
if (!main || !sup) fail("找不到泳道定义");
if (!/"simulation"/.test(main[1])) fail("simulation 未进 MAIN_LANES");
if (/"simulation"/.test(sup[1])) fail("simulation 仍在 SUPPORT_LANES");
const order = [...main[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (!(order.indexOf("plan") < order.indexOf("simulation") && order.indexOf("simulation") < order.indexOf("draft"))) {
  fail("主链顺序必须 plan → simulation → draft");
}
if (!mod.includes("SUPPORT_LANES.some((l) => activeLanes.has(l))")) fail("缺按需自动展开（支撑泳道有命中即展开）");

console.log("PASS: 推演遥测桥 + 标签 + 主链提权 + 按需展开全满足");
