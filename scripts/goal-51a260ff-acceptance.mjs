// Goal 51a260ff 确定性验收（只读）：用户 2026-10-28 裁决 1-4 落地核验。
// 用法：node QMAI/scripts/goal-51a260ff-acceptance.mjs   退出码 0 = 全部通过。
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

const QMAI = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const HUB = resolve(QMAI, "..")
const BOOK = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const STAGE = join(HUB, ".workflow/harvest-staging")
const DRAFTS = join(STAGE, "l9-s3-drafts")
const failures = []
const pass = []
const check = (name, cond, detail = "") => (cond ? pass : failures).push(`${name}${detail ? ` (${detail})` : ""}`)
const norm = (s) => s.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
const md5 = (s) => createHash("md5").update(s).digest("hex")
const read = (p) => norm(readFileSync(p, "utf8"))

// 1/2：ch2、ch36 采用 S3 最终稿落盘，wiki 与 QM 一致，衔接锚点在位
const chapters = [
  { n: "002", final: "ch002-s3-final.md", must: ["第十一条", "五点四十", "朝车门走去"], head: "# 第2章" },
  { n: "036", final: "ch036-s3-final.md", must: ["两小时零七分", "容器"], head: "# 第36章", firstLine: "「第二道锁不是锁。是容器。」" },
]
for (const c of chapters) {
  const f = `chapter-${c.n}.md`
  const wikiP = join(BOOK, "wiki/chapters", f)
  const qmP = join(BOOK, "QM/chapters", f)
  const finalP = join(DRAFTS, c.final)
  if (![wikiP, qmP, finalP].every(existsSync)) { check(`${f} files exist`, false); continue }
  const wiki = read(wikiP)
  const qm = read(qmP)
  check(`${f} wiki==QM`, md5(wiki) === md5(qm))
  const fm = wiki.match(/^---\n[\s\S]*?\n---\n/)
  check(`${f} frontmatter kept`, !!fm && /chapter_status: final/.test(fm[0]) && new RegExp(`chapter_number: '${Number(c.n)}'`).test(fm[0]))
  const body = fm ? wiki.slice(fm[0].length).trim() : ""
  check(`${f} body == S3 final draft`, body === read(finalP).trim())
  check(`${f} H1`, body.startsWith(c.head))
  for (const w of c.must) check(`${f} seam anchor ${w}`, body.includes(w))
  if (c.firstLine) check(`${f} opens on ch35 ending`, body.split("\n").filter(Boolean)[1] === c.firstLine)
  check(`${f} no 三特钟 typo`, !body.includes("三特钟"))
  check(`${f} no key leak`, !/Bearer [A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}/.test(wiki))
  check(`${f} pre-land backup`, existsSync(join(DRAFTS, "backup-pre-land-20261028", f)))
}

// S3 产物
const s3 = JSON.parse(readFileSync(join(STAGE, "quality-gate-97-l9-s3-run.json"), "utf8"))
for (const k of ["ch2", "ch36"]) {
  const a = (s3.arms || {})[k] || {}
  check(`S3 ${k} overall>=9 sealPass`, a.overall >= 9 && a.sealPass === true, `overall=${a.overall}`)
}
check("S3 model muse", s3.model === "muse-spark-1.3-contributor")

// 3：sub2 已从 Pi 配置弃用
const agent = join(homedir(), ".pi/agent")
const models = JSON.parse(readFileSync(join(agent, "models.json"), "utf8"))
const settingsRaw = readFileSync(join(agent, "settings.json"), "utf8")
const settings = JSON.parse(settingsRaw)
check("sub2 provider removed", !Object.keys(models.providers || {}).some((k) => /^sub2/i.test(k)))
check("sub2 absent from settings", !/sub2/i.test(settingsRaw))
check("default provider not sub2", !/^sub2/i.test(String(settings.defaultProvider || "")))
check("sub2 deprecate backup", existsSync(join(STAGE, "sub2-deprecate-20261028/models.json.bak")))

// 仓库同步
const git = (...a) => execFileSync("git", ["-C", QMAI, ...a], { encoding: "utf8" }).trim()
check("QMAI worktree clean", git("status", "--porcelain") === "")
const head = git("rev-parse", "HEAD")
const smith = git("rev-parse", "smith/release/v2.22.2")
check("HEAD==smith", head === smith, `${head.slice(0, 8)} vs ${smith.slice(0, 8)}`)

for (const p of pass) console.log("[OK]", p)
for (const f of failures) console.log("[FAIL]", f)
console.log(failures.length ? `GOAL_51A260FF_ACCEPTANCE_FAIL ${failures.length}` : `GOAL_51A260FF_ACCEPTANCE_OK ${pass.length}/${pass.length}`)
process.exit(failures.length ? 1 : 0)
