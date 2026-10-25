import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const viewPath = path.join(here, "../src/components/novel/world-library-view.tsx");
const code = fs.readFileSync(viewPath, "utf8");

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// 铁律2：反文本墙 —— 禁止把实体数组拍扁（任意变量名 + 任意引号都不许绕过）
if (code.includes('.join("、")') || code.includes(".join('、')") || code.includes(".join(`、`)")) {
  fail("仍残留 .join(\"、\") 纯文本墙，必须用标签云");
}

// 铁律2：必须有搜索 + 折叠 + Badge 载体（按 testid 判定，不认嘴炮）
for (const marker of ["world-library-search", "world-library-toggle-", "world-library-badge-"]) {
  if (!code.includes(marker)) fail(`缺失必需标记 ${marker}（搜索/折叠/Badge 三件套缺一不可）`);
}
if (!code.includes("slice(0, 15)")) fail("缺失前15折叠逻辑 slice(0, 15)");

// 铁律1：账本单件流 —— 本 goal 只闭环 worldLibrary 一页，其余保持 pending 不算失败，
// 但本页必须是 done，否则判定 5% 冒充 100%
const ledgerPath = path.join(here, "../../.workflow/ui-ledger.json");
try {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  const item = ledger.items.find((t) => t.id === "worldLibrary");
  if (!item || item.status !== "done") fail("账本 worldLibrary 未标记 done，不许结案");
} catch (e) {
  fail(`账本读取失败: ${e.message}`);
}

console.log("PASS: world-library 反文本墙 + 搜索折叠 + 账本单页闭环全满足");
process.exit(0);
