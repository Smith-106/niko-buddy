import { describe, expect, it } from "vitest"
import { load } from "js-yaml"
import {
  checkUpdaterManifest,
  checkUploadedAssets,
  verifyMinisignSignature,
  windowsAssetNames,
} from "./verify-windows-release-assets.mjs"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// 发布构建回归检查（run-fe6288c0ce65）：只有产品 tag 构建使用签名密钥和 CI overlay。
// 仅静态检查 workflow 与配置，用合成数据检验校验规则；不联网、不签名、不执行构建。
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

const SIGNED_RELEASE_GUARD =
  "github.event_name == 'push' && github.ref_type == 'tag' && github.repository == 'Smith-106/niko-buddy'"
const MANUAL_BUILD_GUARD = "github.event_name == 'workflow_dispatch'"
const SIGNED_BUILD_COMMAND =
  "        run: npx tauri build ${{ matrix.tauri_args }} --config src-tauri/tauri.ci.conf.json"
const UNSIGNED_BUILD_COMMAND =
  "        run: npx tauri build --bundles nsis"

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

describe("CI updater artifact production and unsigned manual builds", () => {
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

  it("uses the CI overlay only for the signed build and leaves the manual build keyless", () => {
    const lines = readWorkflowLines()
    const signed = extractStepBlock(lines, "Build signed Tauri app")
    const unsigned = extractStepBlock(lines, "Build unsigned Tauri app")

    expect(signed).toContain(SIGNED_BUILD_COMMAND)
    expect(unsigned).toContain(UNSIGNED_BUILD_COMMAND)
    expect(unsigned).not.toMatch(/\benv:|secrets\.|TAURI_SIGNING_|--config\b/)
    for (const command of [SIGNED_BUILD_COMMAND, UNSIGNED_BUILD_COMMAND]) {
      expect(countExactLines(lines, command), command.trim()).toBe(1)
    }
    expect(lines.filter((line) => line.startsWith("        run: npx tauri build "))).toHaveLength(2)
    expect(lines.filter((line) => line.includes("--config "))).toHaveLength(1)
  })

  it("keeps the three signing env references as placeholders on the signed build only", () => {
    const lines = readWorkflowLines()
    const block = extractStepBlock(lines, "Build signed Tauri app")

    expect(block, "Build signed Tauri app step must exist").not.toBeNull()
    expect(block).toContain("        env:")
    // 签名块只两个 release 专用 secret（不出 GITHUB_TOKEN），映射标准 Tauri 签名环境。
    expect(block).not.toContain("GITHUB_TOKEN")
    expect(block).toContain(
      "          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.WINDOWS_RELEASE_TAURI_KEY }}",
    )
    expect(block).toContain(
      "          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.WINDOWS_RELEASE_TAURI_PASSWORD }}",
    )
    // Placeholders only: exactly two secret references, and every signing-key
    // line is the verbatim placeholder form, so no literal value can hide there.
    expect(block?.match(/secrets\./g) ?? []).toHaveLength(2)
    const signingKeyLines = (block ?? "")
      .split("\n")
      .filter((line) => line.includes("TAURI_SIGNING_PRIVATE_KEY"))
    expect(signingKeyLines).toStrictEqual([
      "          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.WINDOWS_RELEASE_TAURI_KEY }}",
      "          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.WINDOWS_RELEASE_TAURI_PASSWORD }}",
    ])
    expect(lines.filter((line) => line.includes("TAURI_SIGNING_PRIVATE_KEY"))).toStrictEqual(signingKeyLines)
  })

  it("carries no key material into the workflow source", () => {
    const workflow = readWorkflowLines().join("\n")

    // No base64/hex-looking blob long enough to be a key or signature body.
    expect(workflow).not.toMatch(/[A-Za-z0-9+/]{60,}/)
    expect(workflow).not.toMatch(/TAURI_SIGNING_PRIVATE_KEY\s*=\s*\S/)
  })
})

describe("release workflow — draft-only staging (YAML structure)", () => {
  const workflow = load(readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8"))
  const ci = load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"))
  const allText = readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8")
  const build = workflow.jobs.build
  const unsigned = workflow.jobs["build-unsigned"]
  const findBuildStep = (name) => build.steps.find((step) => step.name === name)
  const findUnsignedStep = (name) => unsigned.steps.find((step) => step.name === name)

  it("split job guards: signed tag-gated + signing environment; unsigned manual-only and secret-free", () => {
    expect(build.if).toBe(SIGNED_RELEASE_GUARD)
    expect(build.needs).toBe("ci-gate")
    expect(build.environment).toBe("windows-release-signing")
    expect(unsigned.if).toBe(MANUAL_BUILD_GUARD)
    expect(unsigned.needs).toBe("ci-gate")
    expect(unsigned).not.toHaveProperty("environment")
    // 整个 unsigned job 序列化后不带任何 secrets 引用或签名 env 覆盖。
    const serialized = JSON.stringify(unsigned)
    expect(serialized).not.toContain("secrets.")
    expect(serialized).not.toContain("TAURI_SIGNING_PRIVATE_KEY")
  })

  it("ci-gate delegates to ci.yml and ci.yml exposes workflow_call", () => {
    expect(workflow.jobs["ci-gate"].uses).toBe("./.github/workflows/ci.yml")
    expect(ci.on).toHaveProperty("workflow_call")
    expect(ci.permissions.contents).toBe("read")
    expect(build.needs).toBe("ci-gate")
  })

  it("checks the signed release version and commit before building", () => {
    expect(findBuildStep("Checkout")?.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    })
    const source = findBuildStep("Check signed release source")
    const setup = findBuildStep("Setup Node.js")
    const signedBuild = findBuildStep("Build signed Tauri app")
    expect(setup).toBeDefined()
    expect(build.steps.indexOf(source)).toBeGreaterThan(build.steps.indexOf(setup))
    expect(build.steps.indexOf(signedBuild)).toBeGreaterThan(build.steps.indexOf(source))
    expect(source).toMatchObject({ shell: "bash" })
    expect(source.run.trimEnd().split("\n")).toEqual([
      "set -euo pipefail",
      `version="$(node -p "require('./package.json').version")"`,
      String.raw`[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]`,
      'test "$GITHUB_REF_NAME" = "v$version"',
      'test "$(git rev-parse HEAD)" = "$(git rev-parse \"${GITHUB_SHA}^{commit}\")"',
      'test "$(git rev-parse HEAD)" = "$(git rev-parse "${GITHUB_REF}^{commit}")"',
      "git merge-base --is-ancestor HEAD refs/remotes/origin/master",
    ])
  })

  it("restricts every signed build and staging step to product tag pushes", () => {
    // tag 守卫上提到 job 级（build.if = SIGNED_RELEASE_GUARD，见 split-guards 断言）；
    // 步骤级只留 windows-x64 矩阵收窄。
    for (const name of [
      "Prepare Windows updater manifest",
      "Build Windows portable",
      "Verify Windows release files",
      "Stage verified release files",
    ]) {
      expect(findBuildStep(name)?.if, name).toBe(`matrix.label == 'windows-x64'`)
    }
  })

  it("uses runner environment variables in release scripts instead of interpolating GitHub context", () => {
    const manifest = findBuildStep("Prepare Windows updater manifest")
    expect(manifest?.run).toContain('url = "https://github.com/$($env:GITHUB_REPOSITORY)/releases/download/$($env:GITHUB_REF_NAME)/$assetName"')
    expect(manifest?.run).toMatch(/^\s+notes = \$notes$/m)
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.run) expect(step.run, step.name).not.toMatch(/\$\{\{[^}]*\bgithub\s*(?:\.|\[)/i)
      }
    }
  })

  it("builds and uploads only the unsigned NSIS installer on workflow_dispatch", () => {
    const unsignedBuild = findUnsignedStep("Build unsigned Tauri app")
    expect(unsignedBuild?.run).toBe("npx tauri build --bundles nsis")
    expect(findUnsignedStep("Upload bundles as workflow artifacts")).toMatchObject({
      uses: "actions/upload-artifact@v6",
      with: {
        name: "niko-buddy-windows-x64",
        path: "src-tauri/target/release/bundle/nsis/*.exe",
        "if-no-files-found": "error",
        "retention-days": 14,
      },
    })
    expect(findUnsignedStep("Upload bundles as workflow artifacts")).not.toHaveProperty("if")
  })

  it("binds an unpublished release to the remote tag before staging and after asset verification", () => {
    const job = workflow.jobs["stage-release-draft"]
    const createStep = job.steps.find((step) => step.name === "Create and verify unpublished release draft")
    expect(createStep).toBeTruthy()
    const run = createStep.run
    const lines = run.split("\n").map((line) => line.trim())
    const createIdx = lines.findIndex((line) => line.startsWith("gh release create "))
    const preflight = lines.findIndex((line) => line.includes("releases?per_page=100"))
    const rejectExisting = lines.findIndex((line) => line.includes("refusing to change it"))
    const verifyIdx = lines.findIndex((line) => line.startsWith("node scripts/verify-windows-release-assets.mjs release-assets "))
    expect(preflight).toBeGreaterThanOrEqual(0)
    expect(rejectExisting).toBeGreaterThan(preflight)
    expect(lines.indexOf("check_remote_tag")).toBeGreaterThan(rejectExisting)
    expect(createIdx).toBeGreaterThan(lines.indexOf("check_remote_tag"))
    expect(verifyIdx).toBeGreaterThan(createIdx)
    expect(lines.lastIndexOf("check_remote_tag")).toBeGreaterThan(verifyIdx)
    expect(createStep.env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
    expect(run).toContain('tag_sha="$(git rev-parse --verify "$GITHUB_REF")"')
    expect(run).toContain('test "$(git rev-parse --verify "${tag_sha}^{commit}")" = "$head_sha"')
    expect(run).toContain(`remote_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$GITHUB_REF_NAME" --jq '.object.sha')" || return 1`)
    expect(run).toContain('[[ "$remote_sha" != "$tag_sha" ]]')
    expect(run).not.toContain('git ls-remote')
  })

  it("release draft job is tag-push-only, needs build, writes no assets directly", () => {
    const job = workflow.jobs["stage-release-draft"]
    expect(job.needs).toBe("build")
    expect(job.if).toBe(SIGNED_RELEASE_GUARD)
    expect(job.permissions.contents).toBe("write")
    expect(allText).toContain('--verify-tag --target "$head_sha" --draft --latest=false')
    expect(allText).not.toMatch(/gh release (upload|edit|delete)/)
    expect(allText).not.toContain("--clobber")
  })
})

describe("windowsAssetNames / checkUpdaterManifest / checkUploadedAssets", () => {
  const files = windowsAssetNames("2.28.1")
  it("names the four release files", () => {
    expect(files).toEqual([
      "niko-buddy_2.28.1_windows_X64.exe",
      "niko-buddy_2.28.1_windows_X64.exe.sig",
      "niko-buddy_2.28.1_windows_X64_portable.exe",
      "latest.json",
    ])
  })
  const manifest = {
    version: "2.28.1",
    notes: "Niko Buddy release notes",
    pub_date: "2026-11-22T10:20:30.123Z",
    platforms: { "windows-x86_64": { signature: "SIG", url: "https://github.com/Org/repo/releases/download/v2.28.1/niko-buddy_2.28.1_windows_X64.exe" } },
  }
  const checkManifest = (candidate) => checkUpdaterManifest(candidate, "SIG", "Org/repo", "v2.28.1", "2.28.1")
  it("accepts a consistent manifest and rejects mismatches", () => {
    expect(() => checkManifest(manifest)).not.toThrow()
    expect(() => checkManifest({ ...manifest, pub_date: "2026-11-22T10:20:30Z" })).not.toThrow()
    expect(() => checkManifest({ ...manifest, version: "9.9.9" })).toThrow()
    expect(() => checkUpdaterManifest(manifest, "OTHER", "Org/repo", "v2.28.1", "2.28.1")).toThrow()
    expect(() => checkUpdaterManifest(manifest, "SIG", "Org/repo", "v9.9.9", "2.28.1")).toThrow()
    expect(() => checkManifest({
      ...manifest,
      platforms: { "windows-x86_64": { signature: "SIG", url: "https://github.com/Org/repo/releases/download/v9.9.9/wrong.exe" } },
    })).toThrow("Unexpected updater URL")
  })
  it.each([undefined, " \t\n", 42])("rejects invalid manifest notes (%j)", (notes) => {
    expect(() => checkManifest({ ...manifest, notes })).toThrow("Updater notes must be a nonempty string")
  })
  it.each([
    undefined,
    "2026-11-22",
    "2026-11-22T10:20:30.123",
    "2026-11-22T10:20:30+08:00",
    "2026-02-30T10:20:30.123Z",
  ])("rejects invalid UTC publication dates (%j)", (pub_date) => {
    expect(() => checkManifest({ ...manifest, pub_date })).toThrow("Updater pub_date must be a valid ISO-8601 UTC timestamp")
  })
  it.each([
    ["missing platforms", undefined],
    ["empty platforms", {}],
    ["empty Windows entry", { "windows-x86_64": {} }],
    ["an unsupported platform", { "windows-aarch64": manifest.platforms["windows-x86_64"] }],
    ["an extra platform", { ...manifest.platforms, "windows-aarch64": manifest.platforms["windows-x86_64"] }],
  ])("rejects %s", (_name, platforms) => {
    expect(() => checkManifest({ ...manifest, platforms })).toThrow()
  })
  const meta = files.map((name, i) => ({ name, state: "uploaded", size: 10 + i, digest: `sha256:d${i}` }))
  const sizes = files.map((name, i) => ({ name, size: 10 + i, sha256: `d${i}` }))
  it("validates uploaded asset metadata and refuses bad sets", () => {
    expect(() => checkUploadedAssets(sizes, [meta])).not.toThrow()
    expect(() => checkUploadedAssets(sizes, [meta.map((a) => ({ ...a, size: 0 }))])).toThrow()
    expect(() => checkUploadedAssets(sizes, [meta.slice(0, 3)])).toThrow()
    expect(() => checkUploadedAssets(sizes, meta[0])).toThrow()
    expect(() => checkUploadedAssets(sizes, [[...meta, { ...meta[0] }]])).toThrow()
    expect(() => checkUploadedAssets(sizes, [meta.map((a) => ({ ...a, state: "starter" }))])).toThrow()
    expect(() => checkUploadedAssets(sizes, [meta.map((a) => ({ ...a, digest: "sha256:wrong" }))])).toThrow("Wrong uploaded digest")
  })
})

describe("verifyMinisignSignature", () => {
  const DEFAULT_KEY_ID = Buffer.from("0102030405060708", "hex")
  const DEFAULT_TRUSTED_COMMENT = "timestamp:1700000000\tfile:niko-buddy_2.28.1_windows_X64.exe\thashed"

  const encodePubkey = (rawPublicKey, { alg = "Ed", keyId = DEFAULT_KEY_ID } = {}) => {
    const keyPacket = Buffer.concat([Buffer.from(alg, "ascii"), keyId, rawPublicKey])
    const text = `untrusted comment: minisign public key synthetic\n${keyPacket.toString("base64")}\n`
    return Buffer.from(text, "utf8").toString("base64")
  }

  const encodeSidecar = (lines) => Buffer.from(`${lines.join("\n")}\n`, "utf8").toString("base64")

  const buildFixture = ({
    payload = Buffer.from("synthetic-windows-installer-bytes"),
    keyId = DEFAULT_KEY_ID,
    sigKeyId = keyId,
    sigAlg = "ED",
    trustedPrefix = "trusted comment: ",
    trustedComment = DEFAULT_TRUSTED_COMMENT,
    signedComment = trustedComment,
  } = {}) => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const spkiDer = publicKey.export({ format: "der", type: "spki" })
    const rawPub = spkiDer.subarray(spkiDer.length - 32)
    const digest = createHash("blake2b512").update(payload).digest()
    const signature = sign(null, digest, privateKey)
    const sigPacket = Buffer.concat([Buffer.from(sigAlg, "ascii"), sigKeyId, signature])
    const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(signedComment, "utf8")]), privateKey)
    const pubkeyBase64 = encodePubkey(rawPub, { keyId })
    const sidecarLines = [
      "untrusted comment: signature from synthetic minisign key",
      sigPacket.toString("base64"),
      `${trustedPrefix}${trustedComment}`,
      globalSignature.toString("base64"),
    ]
    return {
      digest,
      pubkeyBase64,
      sidecarBase64: encodeSidecar(sidecarLines),
      sidecarLines,
      sigPacket,
      rawPub,
      globalSignature,
    }
  }

  it("accepts a valid synthetic Ed25519 minisign signature", () => {
    const { digest, sidecarBase64, pubkeyBase64 } = buildFixture()
    expect(() => verifyMinisignSignature(digest, sidecarBase64, pubkeyBase64)).not.toThrow()
  })

  it("rejects a tampered installer digest", () => {
    const { sidecarBase64, pubkeyBase64 } = buildFixture()
    const tamperedDigest = createHash("blake2b512").update("tampered-windows-installer-bytes").digest()
    expect(() => verifyMinisignSignature(tamperedDigest, sidecarBase64, pubkeyBase64)).toThrow(
      "Installer signature verification failed",
    )
  })

  it("rejects a tampered trusted comment", () => {
    const { digest, sidecarBase64, pubkeyBase64 } = buildFixture({
      trustedComment: "timestamp:1700000000\tfile:tampered.exe\thashed",
      signedComment: DEFAULT_TRUSTED_COMMENT,
    })
    expect(() => verifyMinisignSignature(digest, sidecarBase64, pubkeyBase64)).toThrow(
      "Global signature verification failed",
    )
  })

  it("rejects mismatched signature and public key IDs", () => {
    const { digest, sidecarBase64, pubkeyBase64 } = buildFixture({
      sigKeyId: Buffer.from("ffeeddccbbaa9988", "hex"),
    })
    expect(() => verifyMinisignSignature(digest, sidecarBase64, pubkeyBase64)).toThrow(
      "Signature key ID differs from updater key",
    )
  })

  it("rejects invalid signature packet length, algorithm header, layout, or global signature length", () => {
    const { digest, sidecarLines, sigPacket, pubkeyBase64, globalSignature } = buildFixture()

    const shortPacketSidecar = encodeSidecar([
      sidecarLines[0],
      sigPacket.subarray(0, 40).toString("base64"),
      sidecarLines[2],
      sidecarLines[3],
    ])
    expect(() => verifyMinisignSignature(digest, shortPacketSidecar, pubkeyBase64)).toThrow(
      "Unexpected signature packet",
    )

    const wrongAlgFixture = buildFixture({ sigAlg: "Ed" })
    expect(() =>
      verifyMinisignSignature(wrongAlgFixture.digest, wrongAlgFixture.sidecarBase64, wrongAlgFixture.pubkeyBase64),
    ).toThrow()

    const badLayoutSidecar = encodeSidecar(sidecarLines.slice(0, 3))
    expect(() => verifyMinisignSignature(digest, badLayoutSidecar, pubkeyBase64)).toThrow(
      "Unexpected sidecar signature layout",
    )

    const shortGlobalSidecar = encodeSidecar([
      sidecarLines[0],
      sidecarLines[1],
      sidecarLines[2],
      globalSignature.subarray(0, 32).toString("base64"),
    ])
    expect(() => verifyMinisignSignature(digest, shortGlobalSidecar, pubkeyBase64)).toThrow(
      "Unexpected global signature",
    )
  })

  it("rejects a sidecar missing the trusted comment prefix", () => {
    const { digest, sidecarBase64, pubkeyBase64 } = buildFixture({
      trustedPrefix: "comment: ",
    })
    expect(() => verifyMinisignSignature(digest, sidecarBase64, pubkeyBase64)).toThrow("Missing trusted comment")
  })

  it("rejects an invalid public key packet (bad length or algorithm header)", () => {
    const { digest, sidecarBase64, rawPub } = buildFixture()

    const shortPubkey = encodePubkey(rawPub.subarray(0, 16))
    expect(() => verifyMinisignSignature(digest, sidecarBase64, shortPubkey)).toThrow(
      "Unexpected updater public key packet",
    )

    const emptyPubkey = Buffer.from("untrusted comment: empty\n\n", "utf8").toString("base64")
    expect(() => verifyMinisignSignature(digest, sidecarBase64, emptyPubkey)).toThrow(
      "Unexpected updater public key packet",
    )

    const wrongAlgPubkey = encodePubkey(rawPub, { alg: "XX" })
    expect(() => verifyMinisignSignature(digest, sidecarBase64, wrongAlgPubkey)).toThrow()
  })
})
