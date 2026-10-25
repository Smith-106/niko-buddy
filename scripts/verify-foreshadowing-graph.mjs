// #3 验收：伏笔置顶 + 图谱/灵魂提权（静态断言，exit 0 才许结案）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

// 1) 主控 context Tab 内：伏笔块必须在目录块之前（终结“伏笔被目录吃掉”）
const mc = fs.readFileSync(path.join(here, "../src/components/novel/main-control-view.tsx"), "utf8");
const fi = mc.indexOf("main-control-foreshadowing");
const di = mc.indexOf("main-control-chapter-directory");
if (fi === -1) fail("main-control-view 缺 main-control-foreshadowing 块");
if (di === -1) fail("main-control-view 缺 main-control-chapter-directory 块");
if (!(fi < di)) fail("伏笔块仍排在目录块之后：foreshadowing 必须在 chapter-directory 之前");

// 2) 侧栏：graph/soul 必须在默认展开的 ma 组（终结“折叠藏图谱”）
const nav = fs.readFileSync(path.join(here, "../src/components/layout/nav-items.ts"), "utf8");
for (const v of ["graph", "soul"]) {
  const m = nav.match(new RegExp(`\\{\\s*view:\\s*"${v}"[^}]*?group:\\s*"([^"]+)"`));
  if (!m) fail(`nav-items 缺 ${v} 条目`);
  if (m[1] !== "ma") fail(`${v} 仍在 ${m[1]} 组（默认折叠），必须提权到 ma 组`);
}

console.log("PASS: 伏笔置顶 + 图谱/灵魂提权全满足");
