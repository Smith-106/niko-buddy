#!/usr/bin/env node
/**
 * M1: Seed wiki/outlines (+ optional entities) from project-root FILLED outlines / QM pages.
 * Makes buildContextPack's wiki/outlines path work without hand-building a full wiki.
 *
 * Usage:
 *   node scripts/seed-project-wiki-from-filled.mjs --project "E:/写作/8人" [--force]
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"
import { join, resolve, basename } from "node:path"

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const force = process.argv.includes("--force")
const project = resolve(arg("--project", ""))
if (!project || !existsSync(project)) {
  console.error("Usage: node scripts/seed-project-wiki-from-filled.mjs --project <path> [--force]")
  process.exit(1)
}

const outlinesDir = join(project, "wiki", "outlines")
const entitiesDir = join(project, "wiki", "entities")
mkdirSync(outlinesDir, { recursive: true })
mkdirSync(entitiesDir, { recursive: true })

const rootFiles = readdirSync(project)
const filled = rootFiles.filter((n) => /^Chapter-\d+-Outline-FILLED\.md$/i.test(n))
const seeded = []

for (const name of filled) {
  const m = name.match(/Chapter-(\d+)-Outline-FILLED\.md/i)
  const n = m ? Number(m[1]) : 0
  if (!n) continue
  const src = join(project, name)
  const body = readFileSync(src, "utf8")
  const destName = `chapter-${n}-outline.md`
  const dest = join(outlinesDir, destName)
  if (existsSync(dest) && !force) {
    seeded.push({ chapter: n, dest: destName, action: "skip-exists" })
    continue
  }
  const front = [
    "---",
    `chapter_number: ${n}`,
    "outline_type: chapter-outline",
    `source: ${name}`,
    "seeded_by: seed-project-wiki-from-filled",
    "---",
    "",
  ].join("\n")
  writeFileSync(dest, front + body, "utf8")
  seeded.push({ chapter: n, dest: destName, action: "wrote", chars: body.length })
}

// QM entity pages → wiki/entities
const qm = join(project, "QM")
if (existsSync(qm)) {
  for (const name of readdirSync(qm).filter((n) => n.endsWith(".md"))) {
    const dest = join(entitiesDir, name)
    if (existsSync(dest) && !force) {
      seeded.push({ entity: name, action: "skip-exists" })
      continue
    }
    copyFileSync(join(qm, name), dest)
    seeded.push({ entity: name, action: "copied" })
  }
}

// index stub so search has something
const indexPath = join(project, "wiki", "README.md")
if (!existsSync(indexPath) || force) {
  writeFileSync(
    indexPath,
    [
      "# Wiki (seeded)",
      "",
      "Auto-seeded from project-root `Chapter-N-Outline-FILLED.md` and `QM/`.",
      "Purpose: feed `buildContextPack` outline + entity loaders (M1).",
      "",
      `Outlines: ${filled.length}`,
      "",
    ].join("\n"),
    "utf8",
  )
}

console.log(
  JSON.stringify(
    {
      ok: true,
      project,
      outlinesDir,
      seeded,
    },
    null,
    2,
  ),
)
