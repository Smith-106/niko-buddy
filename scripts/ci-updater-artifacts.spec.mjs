import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// CI updater-artifact regression guard (run-fe6288c0ce65, single-piece correction).
//
// Why this exists: workflow_dispatch produced the Windows NSIS installer without an
// updater signature. Root cause is producer-side, not uploader-side — the artifact
// upload step already globs *.exe.sig, the signing secrets are already wired into
// the unguarded "Build Tauri app" step, but bundle.createUpdaterArtifacts defaults
// to false and the base tauri.conf.json must keep it unset so key-less local
// `tauri build` / build:portable keep working. The correction therefore opts in
// through one explicit JSON config overlay referenced by the CI command only.
//
// Everything below is pure source-text inspection (readFileSync): build.yml, the
// config overlays and the release preparation script are never imported, evaluated
// or executed. No network, no signing, no filesystem writes. Every read happens
// inside it() bodies (via a null-returning reader) so a missing file is an
// assertion failure instead of a module-load crash.
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const BUILD_WORKFLOW = ".github/workflows/build.yml"
const BASE_CONFIG = "src-tauri/tauri.conf.json"
const CI_OVERLAY = "src-tauri/tauri.ci.conf.json"
const PLATFORM_OVERLAYS = [
  "src-tauri/tauri.windows.conf.json",
  "src-tauri/tauri.linux.conf.json",
  "src-tauri/tauri.macos.conf.json",
]

const CI_BUILD_COMMAND =
  "        run: npx tauri build ${{ matrix.tauri_args }} --config src-tauri/tauri.ci.conf.json"
const LEGACY_BUILD_COMMAND =
  "        run: npx tauri build ${{ matrix.tauri_args }}"

const readSourceIfExists = (relativePath) => {
  try {
    return readFileSync(resolve(repoRoot, relativePath), "utf8")
  } catch (error) {
    if (error && error.code === "ENOENT") return null
    throw error
  }
}

// Parses a config source; a missing file becomes a named assertion failure and a
// present-but-invalid file stays a loud parse error (JSON.parse is deterministic).
const parseConfig = (source, relativePath) => {
  expect(source, `${relativePath} must exist`).not.toBeNull()
  return JSON.parse(source ?? "null")
}

const countExactLines = (lines, expected) =>
  lines.filter((line) => line === expected).length

// Slices one `- name: <step>` block out of the workflow source up to the next step
// header. Static text only; nothing is executed.
const extractStepBlock = (lines, stepName) => {
  const startIndex = lines.findIndex((line) => line === `      - name: ${stepName}`)
  if (startIndex === -1) return null
  const remainder = lines.slice(startIndex + 1)
  const endOffset = remainder.findIndex((line) => line.startsWith("      - name: "))
  return (endOffset === -1 ? remainder : remainder.slice(0, endOffset)).join("\n")
}

const readWorkflowLines = () => {
  const source = readSourceIfExists(BUILD_WORKFLOW)
  expect(source, `${BUILD_WORKFLOW} must exist`).not.toBeNull()
  return (source ?? "").split("\n")
}

describe("CI updater artifact production on workflow_dispatch", () => {
  it("leaves the base Tauri config free of createUpdaterArtifacts (key-less local builds)", () => {
    const base = parseConfig(readSourceIfExists(BASE_CONFIG), BASE_CONFIG)

    expect(base?.bundle).toBeTypeOf("object")
    expect("createUpdaterArtifacts" in base.bundle).toBe(false)
    expect(base.bundle.createUpdaterArtifacts).toBeUndefined()
  })

  it.each(PLATFORM_OVERLAYS)(
    "keeps the platform overlay %s free of createUpdaterArtifacts",
    (relativePath) => {
      const overlay = parseConfig(readSourceIfExists(relativePath), relativePath)

      expect(overlay?.bundle).toBeTypeOf("object")
      expect("createUpdaterArtifacts" in overlay.bundle).toBe(false)
      expect(overlay.bundle.createUpdaterArtifacts).toBeUndefined()
    },
  )

  it("enables exactly one updater-artifact flag through the CI overlay", () => {
    const overlaySource = readSourceIfExists(CI_OVERLAY)
    const overlay = parseConfig(overlaySource, CI_OVERLAY)

    // Whole-object strict equality is the sole-flag proof: no extra leaf key
    // ($schema / version / targets / build / plugins ...) can exist, and strict
    // boolean true is required (1 or "true" would fail).
    expect(overlay).toStrictEqual({ bundle: { createUpdaterArtifacts: true } })
    expect(Object.keys(overlay)).toStrictEqual(["bundle"])
    expect(overlay.bundle.createUpdaterArtifacts).toBe(true)
  })

  it("writes the CI overlay as canonical JSON (2-space indent, trailing LF)", () => {
    const overlaySource = readSourceIfExists(CI_OVERLAY)
    const overlay = parseConfig(overlaySource, CI_OVERLAY)

    expect(overlaySource).not.toBeNull()
    expect(overlaySource?.endsWith("\n")).toBe(true)
    expect(overlaySource?.endsWith("\n\n")).toBe(false)
    expect(overlaySource).toBe(`${JSON.stringify(overlay, null, 2)}\n`)
  })

  it("opts the existing Build Tauri app command into the CI overlay, once", () => {
    const lines = readWorkflowLines()

    expect(
      countExactLines(lines, CI_BUILD_COMMAND),
      `build.yml must carry exactly one '${CI_BUILD_COMMAND.trim()}'`,
    ).toBe(1)
    expect(
      countExactLines(lines, LEGACY_BUILD_COMMAND),
      "build.yml must no longer carry the overlay-less build command",
    ).toBe(0)
    expect(lines.filter((line) => line.startsWith("        run: npx tauri build "))).toHaveLength(1)
    expect(lines.filter((line) => line.includes("--config "))).toHaveLength(1)
  })

  it("keeps the three signing secrets as placeholders on the Build Tauri app step", () => {
    const lines = readWorkflowLines()
    const block = extractStepBlock(lines, "Build Tauri app")

    expect(block, "Build Tauri app step must exist").not.toBeNull()
    expect(block).toContain("        env:")
    expect(block).toContain("          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}")
    expect(block).toContain(
      "          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    )
    expect(block).toContain(
      "          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    )
    // Placeholders only: exactly three secret references, and every signing-key
    // line is the verbatim placeholder form, so no literal value can hide there.
    expect(block?.match(/secrets\./g) ?? []).toHaveLength(3)
    const signingKeyLines = (block ?? "")
      .split("\n")
      .filter((line) => line.includes("TAURI_SIGNING_PRIVATE_KEY"))
    expect(signingKeyLines).toStrictEqual([
      "          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
      "          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    ])
  })

  it("keeps every push-only release guard and the ci-gate dependency intact", () => {
    const lines = readWorkflowLines()

    const pushOnlyGuards = [
      ["        if: github.event_name == 'push'", 2],
      ["        if: github.event_name == 'push' && matrix.label == 'windows-x64'", 3],
      ["        if: github.event_name == 'push' && runner.os == 'macOS'", 1],
      ["        if: github.event_name == 'push' && matrix.label == 'linux-x64'", 1],
    ]

    for (const [guard, expected] of pushOnlyGuards) {
      expect(countExactLines(lines, guard), guard).toBe(expected)
    }
    // Seven push-only guarded steps in total: nothing on workflow_dispatch can
    // reach the Release / manifest / portable / attach surfaces.
    expect(
      pushOnlyGuards.reduce((total, [, expected]) => total + expected, 0),
    ).toBe(7)

    expect(countExactLines(lines, "    needs: ci-gate")).toBe(1)
  })

  it("keeps the workflow_dispatch artifact upload step, name and globs intact", () => {
    const lines = readWorkflowLines()
    const block = extractStepBlock(lines, "Upload bundles as workflow artifacts")

    expect(block, "Upload bundles as workflow artifacts step must exist").not.toBeNull()
    expect(countExactLines(lines, "        if: github.event_name == 'workflow_dispatch'")).toBe(1)
    expect(block).toContain("        uses: actions/upload-artifact@v6")
    expect(block).toContain("          name: niko-buddy-${{ matrix.label }}")
    expect(block).toContain("          path: ${{ matrix.artifact_globs }}")
    expect(block).toContain("          if-no-files-found: warn")
    expect(block).toContain("          retention-days: 14")
    expect(lines).toContain(
      "              src-tauri/target/**/release/bundle/nsis/*.exe.sig",
    )
    expect(lines).toContain(
      "              src-tauri/target/**/release/bundle/nsis/*.exe",
    )
  })

  it("carries no key material into the workflow source", () => {
    const workflow = readWorkflowLines().join("\n")

    // No base64/hex-looking blob long enough to be a key or signature body.
    expect(workflow).not.toMatch(/[A-Za-z0-9+/]{60,}/)
    expect(workflow).not.toMatch(/TAURI_SIGNING_PRIVATE_KEY\s*=\s*\S/)
  })
})
