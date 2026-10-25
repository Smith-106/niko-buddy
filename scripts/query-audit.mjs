// 按需查询审计报告：只打印命中的 file:line 行，绝不把 57KB 全量倒进上下文。
// 用法：node QMAI/scripts/query-audit.mjs rule=textwall-join [severity=HIGH] [limit=20]
//       node QMAI/scripts/query-audit.mjs file=graph-view
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=").map(String)));
const here = path.dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(fs.readFileSync(path.join(here, "../../.workflow/ui-audit-report.json"), "utf8"));

let out = report.findings;
if (args.rule) out = out.filter((f) => f.rule === args.rule);
if (args.severity) out = out.filter((f) => f.severity === args.severity.toUpperCase());
if (args.file) out = out.filter((f) => f.file.includes(args.file));
const limit = Math.min(parseInt(args.limit || "30", 10) || 30, 100);
console.log(`matched=${out.length} (showing ${Math.min(limit, out.length)}) rules=${Object.keys(report.counts).join(",")}`);
for (const f of out.slice(0, limit)) console.log(`${f.severity} ${f.rule} ${f.file}:${f.line} :: ${f.snippet}`);
