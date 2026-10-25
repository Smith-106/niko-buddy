// S3-6 recon tooling: re-classify button-a11y probe hits with JSX-aware parsing.
// Classes: OK-LABEL (aria/title in full tag) / OK-TEXT (visible text or t() child)
//        / TRUE-POSITIVE (icon-only, no accessible name) / STALE (no <button> at line).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src");
const report = JSON.parse(fs.readFileSync(path.join(here, "..", "..", ".workflow", "ui-audit-report.json"), "utf8"));
const hits = report.hits["button-a11y"];

// find tag end respecting quotes and {} braces
function tagEnd(src, start) {
  let i = start, quote = null, depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === ">" && depth === 0) return i;
    i++;
  }
  return -1;
}

const out = { "OK-LABEL": [], "OK-TEXT": [], "TRUE-POSITIVE": [], STALE: [] };
for (const h of hits) {
  const m = h.match(/^(.*):(\d+) /);
  if (!m) { out.STALE.push(h + " #unparseable"); continue; }
  const [, rel, lnStr] = m;
  const fp = path.join(SRC, rel.replace(/^src\//, ""));
  if (!fs.existsSync(fp)) { out.STALE.push(h); continue; }
  const src = fs.readFileSync(fp, "utf8");
  const lines = src.split("\n");
  const ln = parseInt(lnStr, 10);
  // search <button within +-3 lines of reported line
  let idx = -1;
  for (let l = Math.max(0, ln - 4); l < Math.min(lines.length, ln + 3); l++) {
    const p = lines[l].indexOf("<button");
    if (p >= 0) { idx = src.split("\n").slice(0, l).join("\n").length + (l > 0 ? 1 : 0) + p; break; }
  }
  if (idx < 0) { out.STALE.push(h); continue; }
  const end = tagEnd(src, idx);
  if (end < 0) { out.STALE.push(h + " #notag"); continue; }
  const tag = src.slice(idx, end + 1);
  if (/aria-label|aria-labelledby|title=/.test(tag)) { out["OK-LABEL"].push(`${rel}:${ln}`); continue; }
  const after = src.slice(end + 1, end + 401);
  const closeAt = after.indexOf("</button>");
  const inner = closeAt > 0 ? after.slice(0, closeAt) : after;
  const noTags = inner.replace(/<[^>]*>/g, "");
  if (/\{t\(/.test(inner)) { out["OK-TEXT"].push(`${rel}:${ln} #t-call`); continue; }
  const stripped = noTags.replace(/\{[^}]*\}/g, "").trim();
  const hasText = /[\u4e00-\u9fa5]{2,}|[A-Za-z]{2,}/.test(stripped);
  if (hasText) { out["OK-TEXT"].push(`${rel}:${ln}`); continue; }
  if (/\{/.test(noTags)) { out["OK-TEXT"].push(`${rel}:${ln} #dynamic`); continue; }
  out["TRUE-POSITIVE"].push(`${rel}:${ln} :: ${inner.slice(0, 80).replace(/\s+/g, " ")}`);
}

for (const k of Object.keys(out)) console.log(k, out[k].length);
fs.writeFileSync(path.join(here, "button-a11y-recheck.json"), JSON.stringify(out, null, 1));
console.log("TRUE-POSITIVE list:");
for (const s of out["TRUE-POSITIVE"]) console.log(" ", s);
