// Orphan tmp cleanup (first-echelon hygiene).
// Moves stale maestro channel pointers + atomic-write orphan temps (*.tmp,
// .*.tmp, *.temp, *.bak) out of the repo into hub .workflow/backups/.
// Never touches source files, node_modules, target, or .git.
import { promises as fs } from "node:fs"
import path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..")
const HUB = path.resolve(REPO, "..")
const BACKUP_ROOT = path.join(HUB, ".workflow", "backups", `tmp-archive-${new Date().toISOString().replace(/[:.]/g, "-")}`)

const SKIP_DIRS = new Set(["node_modules", "target", ".git", "dist", ".turbo"])
const ORPHAN_FILE = /(^|\.)tmp$|\.temp$|\.bak$|~$|^\.[^/]+\.\d+\.tmp$/
const STALE_MS = 7 * 24 * 60 * 60 * 1000

async function walk(dir, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      await walk(path.join(dir, e.name), out)
    } else if (e.isFile() && ORPHAN_FILE.test(e.name)) {
      out.push(path.join(dir, e.name))
    }
  }
}

const moved = []
async function archive(full) {
  const rel = path.relative(REPO, full)
  const dest = path.join(BACKUP_ROOT, rel)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.rename(full, dest)
  moved.push(rel)
}

// 1. stale channel pointers
const channelsDir = path.join(REPO, ".workflow", "tmp", "channels")
try {
  const now = Date.now()
  for (const f of await fs.readdir(channelsDir)) {
    const full = path.join(channelsDir, f)
    const st = await fs.stat(full)
    if (st.isFile() && now - st.mtimeMs > STALE_MS) await archive(full)
  }
} catch (err) {
  if (err.code !== "ENOENT") throw err
}

// 2. repo-wide orphan temps
const orphans = []
await walk(REPO, orphans)
for (const f of orphans) await archive(f)

console.log(`backup_root=${BACKUP_ROOT}`)
console.log(`moved=${moved.length}`)
for (const m of moved) console.log(`  ${m}`)
if (moved.length === 0) console.log("clean: no orphan tmp fragments found")
