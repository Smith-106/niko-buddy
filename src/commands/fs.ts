import { invoke } from "@tauri-apps/api/core"
import type { FileNode, WikiProject } from "@/types/wiki"
import { ensureProjectId, upsertProjectInfo } from "@/lib/project-identity"
import { withFileLockRetry } from "./file-lock-guard"

/**
 * ipcContract 标准错误信封（ledger-d）：所有 fs.ts 导出统一经 invokeFs，
 * 后端 panic/异常的拒绝值被归一化为 FsError { code, command, message, details }。
 * message 保持后端原文（不加前缀，调用方展示零变化）；command/code/details 供定位与重试。
 * Cancel Token：@tauri-apps/api v2 的 InvokeOptions 仅含 headers（无 signal），
 * 跨 IPC 取消在平台层不可实现——本项记账降级，不做假取消。
 */
export class FsError extends Error {
  readonly code: string
  readonly command: string
  readonly details: unknown
  constructor(command: string, message: string, details: unknown) {
    super(message)
    this.name = "FsError"
    this.code = `fs/${command}`
    this.command = command
    this.details = details
  }
}

export function toFsError(command: string, err: unknown): FsError {
  if (err instanceof FsError) return err
  let message: string
  if (err instanceof Error) {
    message = err.message || String(err)
  } else if (typeof err === "string") {
    message = err
  } else {
    try {
      message = JSON.stringify(err) ?? String(err)
    } catch {
      message = String(err)
    }
  }
  return new FsError(command, message, err)
}

async function invokeFs<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return args === undefined ? await invoke<T>(command) : await invoke<T>(command, args)
  } catch (err) {
    throw toFsError(command, err)
  }
}

interface RawProject {
  name: string
  path: string
}

export async function readFile(path: string): Promise<string> {
  return invokeFs<string>("read_file", { path })
}

export async function writeFile(path: string, contents: string): Promise<void> {
  return invokeFs<void>("write_file", { path, contents })
}

export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  // Windows 并发 rename 瞬态错误（sharing violation/EBUSY）：TS 侧 choke point 重试。
  return withFileLockRetry(() => invokeFs<void>("write_file_atomic", { path, contents }))
}

export async function listDirectory(path: string): Promise<FileNode[]> {
  return invokeFs<FileNode[]>("list_directory", { path })
}

export async function copyFile(
  source: string,
  destination: string
): Promise<void> {
  return invokeFs("copy_file", { source, destination })
}

export async function copyDirectory(
  source: string,
  destination: string
): Promise<string[]> {
  return invokeFs<string[]>("copy_directory", { source, destination })
}

export async function preprocessFile(path: string): Promise<string> {
  return invokeFs<string>("preprocess_file", { path })
}

export async function deleteFile(path: string): Promise<void> {
  return invokeFs("delete_file", { path })
}

export async function findRelatedWikiPages(
  projectPath: string,
  sourceName: string
): Promise<string[]> {
  return invokeFs<string[]>("find_related_wiki_pages", { projectPath, sourceName })
}

export async function createDirectory(path: string): Promise<void> {
  return invokeFs<void>("create_directory", { path })
}

export async function fileExists(path: string): Promise<boolean> {
  return invokeFs<boolean>("file_exists", { path })
}

/** 目录判定（DI-1）：必须走 Rust `metadata.file_type().is_dir()`，
 *  不得用 getFileSize 推断（Windows 上目录 len()=Ok(0) 可被误判为文件）。 */
export async function pathIsDirectory(path: string): Promise<boolean> {
  return invokeFs<boolean>("path_is_directory", { path })
}

export async function getFileModifiedTime(path: string): Promise<number> {
  return invokeFs<number>("get_file_modified_time", { path })
}

export async function getFileSize(path: string): Promise<number> {
  return invokeFs<number>("get_file_size", { path })
}

export async function getFileMd5(path: string): Promise<string> {
  return invokeFs<string>("get_file_md5", { path })
}

export interface FileBase64 {
  base64: string
  mimeType: string
}

export async function readFileAsBase64(path: string): Promise<FileBase64> {
  return invokeFs<FileBase64>("read_file_as_base64", { path })
}

export async function createProject(
  name: string,
  path: string,
): Promise<WikiProject> {
  let raw: RawProject
  try {
    raw = await invoke<RawProject>("create_project", { name, path })
  } catch (err) {
    throw toFsError("create_project", err)
  }
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

export async function openProject(path: string): Promise<WikiProject> {
  let raw: RawProject
  try {
    raw = await invoke<RawProject>("open_project", { path })
  } catch (err) {
    throw toFsError("open_project", err)
  }
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

export async function openProjectFolder(path: string): Promise<void> {
  return invokeFs<void>("open_project_folder", { path })
}

export async function openFileLocation(path: string): Promise<void> {
  return invokeFs<void>("open_file_location", { path })
}

export async function getExecutableDir(): Promise<string> {
  return invokeFs<string>("get_executable_dir")
}

export async function getResourceDir(): Promise<string> {
  return invokeFs<string>("get_resource_dir")
}

/**
 * writeFilesAtomic — 多文件原子事务（64 号实施 M1，Rust `write_files_atomic`）。
 * files 为 [路径, 内容] 对：temp 写入 + 统一 rename + 失败回滚零 rename。
 * 空数组为 no-op 成功。
 */
export async function writeFilesAtomic(files: Array<[string, string]>): Promise<void> {
  if (files.length === 0) return
  // Windows 并发 rename 瞬态错误（sharing violation/EBUSY）：TS 侧 choke point 重试。
  return withFileLockRetry(() => invokeFs<void>("write_files_atomic", { files }))
}
