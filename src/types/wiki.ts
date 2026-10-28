export interface WikiProject {
  /** Stable UUID, persisted inside the project at .niko-buddy/project.json.
   *  Survives the user moving or renaming the project folder. */
  id: string
  name: string
  path: string
}

export interface FileNode {
  name: string
  path: string
  is_dir: boolean
  /** 文件修改时间（UNIX epoch 毫秒）；目录不携带。ISS-20260709-032。 */
  mtime_ms?: number
  children?: FileNode[]
}

export interface WikiPage {
  path: string
  content: string
  frontmatter: Record<string, unknown>
}
