// 探针1：全仓前端代码特征安检（只读扫描，零依赖，node直跑）
// 扫 QMAI/src 下全部 tsx（不含 *.spec.*），输出 .workflow/ui-audit-report.json
// 六类：textwall-join / button-a11y / empty-catch / hardcoded-color / unguarded-map / icon-button
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src");
const OUT = path.join(here, "..", "..", ".workflow", "ui-audit-report.json");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (e.name.endsWith(".tsx") && !e.name.endsWith(".spec.tsx") && !e.name.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const hits = { "textwall-join": [], "button-a11y": [], "empty-catch": [], "hardcoded-color": [], "unguarded-map": [] };
const rel = (p) => path.relative(path.join(here, ".."), p).replace(/\\/g, "/");

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split("\n");
  const tag = rel(f);
  // 1) 文本墙 join：顿号/逗号拼接
  for (const m of src.matchAll(/\.join\(\s*["'`](、|,|，|;|；)["'`]\s*\)/g)) {
    const ln = src.slice(0, m.index).split("\n").length;
    hits["textwall-join"].push(`${tag}:${ln} join(${(m[1])})`);
  }
  // 2) 按钮无障碍：<button> 无 aria-label/title，且内容疑似纯图标
  for (const m of src.matchAll(/<button\b([\s\S]*?)>/g)) {
    const attrs = m[1];
    if (/aria-label|aria-labelledby|title=/.test(attrs)) continue;
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const inner = after.slice(0, after.indexOf("</button>") > 0 ? after.indexOf("</button>") : 400);
    const hasText = /[\u4e00-\u9fa5]{2,}|>[A-Za-z\u4e00-\u9fa5][^<]{1,30}</.test(inner);
    if (!hasText) {
      const ln = src.slice(0, m.index).split("\n").length;
      hits["button-a11y"].push(`${tag}:${ln} <button> 无文本标签`);
    }
  }
  // 3) 静默吞错：空 catch
  for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) {
    const ln = src.slice(0, m.index).split("\n").length;
    hits["empty-catch"].push(`${tag}:${ln} 空catch`);
  }
  // 4) 硬编码色值
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*)/.test(ln)) return;
    for (const m of ln.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\brgba?\(/g)) {
      hits["hardcoded-color"].push(`${tag}:${i + 1} ${m[0]}`);
      break; // 每行只记一次
    }
  });
  // 5) 无保护 map：非 ?.map 的直接 .map 调用（需人工复核，属嫌疑非定罪）
  for (const m of src.matchAll(/(?<!\?)\.(map)\s*\(/g)) {
    const ln = src.slice(0, m.index).split("\n").length;
    hits["unguarded-map"].push(`${tag}:${ln} .map(`);
  }
}

const summary = Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, v.length]));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ scanned: files.length, summary, hits }, null, 1), "utf8");
console.log(`scanned=${files.length} files -> ${OUT}`);
console.log(JSON.stringify(summary, null, 1));
for (const [k, v] of Object.entries(hits)) {
  console.log(`--- ${k} (top 15 / total ${v.length}) ---`);
  v.slice(0, 15).forEach((h) => console.log("  " + h));
}
