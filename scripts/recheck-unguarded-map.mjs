// S3-7 recon tooling: classify unguarded-map hits by guard signals in context.
// SAFE-INIT: receiver initialized as [] / Array.from / default param / ?? [] / || [] nearby
// SAFE-GUARD: arr && / length check / early-return / Array.isArray / ternary guard in window
// NEEDS-EYE: no signal found -> human review list
// STALE: line no longer contains .map(
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src");
const report = JSON.parse(fs.readFileSync(path.join(here, "..", "..", ".workflow", "ui-audit-report.json"), "utf8"));
const hits = report.hits["unguarded-map"];

const out = { "SAFE-INIT": [], "SAFE-GUARD": [], "NEEDS-EYE": [], STALE: [] };
for (const h of hits) {
  const m = h.match(/^(.*):(\d+) /);
  if (!m) { out.STALE.push(h); continue; }
  const [, rel, lnStr] = m;
  const fp = path.join(SRC, rel.replace(/^src\//, ""));
  if (!fs.existsSync(fp)) { out.STALE.push(h + " #nofile"); continue; }
  const lines = fs.readFileSync(fp, "utf8").split("\n");
  const ln = parseInt(lnStr, 10);
  // relocate: search +-6 lines for .map(
  let hit = -1;
  for (let l = Math.max(0, ln - 7); l < Math.min(lines.length, ln + 6); l++) {
    if (/(?<!\?)\.map\s*\(/.test(lines[l])) { hit = l; break; }
  }
  if (hit < 0) { out.STALE.push(`${rel}:${ln}`); continue; }
  const line = lines[hit];
  const rm = line.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)\.map\s*\(/);
  if (!rm) { out["NEEDS-EYE"].push(`${rel}:${hit + 1} recv=? :: ${line.trim().slice(0, 90)}`); continue; }
  const recv = rm[1];
  const base = recv.split(/[.[]/)[0].replace(/[^A-Za-z_$\w]/g, "");
  if (!base) { out["NEEDS-EYE"].push(`${rel}:${hit + 1} recv=${recv}`); continue; }
  const win = lines.slice(Math.max(0, hit - 40), hit + 1).join("\n");
  const key = `${rel}:${hit + 1} recv=${recv}`;
  const initRe = new RegExp(`(useState[^;]*\\(\\s*\\[\\s*\\]|\\b${base}\\s*=[^;]*\\[\\s*\\]|\\b${base}\\s*\\?\\?\\s*\\[|\\b${base}\\s*\\|\\|\\s*\\[|Array\\.from|\\b${base}:[^=]*=\\s*\\[|\\(${base}:[^)]*=\\s*\\[)`);
  if (initRe.test(win)) { out["SAFE-INIT"].push(key); continue; }
  const guardRe = new RegExp(`(${base}\\s*&&|${base}\\.length|${base}\\?\\.|Array\\.isArray\\(${base}\\)|if\\s*\\([^)]*${base}[^)]*\\)\\s*return|${base}\\s*\\?\\s*[^:]+:|\\b${base} \\|\\| )`);
  if (guardRe.test(win)) { out["SAFE-GUARD"].push(key); continue; }
  out["NEEDS-EYE"].push(`${key} :: ${line.trim().slice(0, 90)}`);
}
for (const k of Object.keys(out)) console.log(k, out[k].length);
fs.writeFileSync(path.join(here, "unguarded-map-recheck.json"), JSON.stringify(out, null, 1));
console.log("--- NEEDS-EYE (first 60) ---");
for (const s of out["NEEDS-EYE"].slice(0, 60)) console.log(" ", s);
