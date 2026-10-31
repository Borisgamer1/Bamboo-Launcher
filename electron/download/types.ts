import type { Checksum } from './checksum'

export type FileValidator = 'file' | 'zip' | 'json'

export interface InstallFile {
  path: string
  urls: string[]
  size?: number
  checksum?: Checksum
  validator?: FileValidator
  executable?: boolean
  replace?: boolean
  trustExistingSize?: boolean
}

export interface InstallFilesTask {
  type: 'files'
  id: string
  destination: string
  files: InstallFile[]
  dependsOn?: string[]
  concurrency?: number
}

export interface InstallJavaTask {
  type: 'java'
  id: string
  majorVersion: number
  component?: string
  dependsOn?: string[]
}

export type MaterializeOperation =
  | { type: 'write'; path: string; content: string | Buffer; mode?: number }
  | { type: 'ensure-directory'; path: string }
  | { type: 'copy'; from: string; path: string }
  | { type: 'link'; from: string; path: string }
  | { type: 'remove'; path: string }
  | { type: 'extract'; archive: string; entry: string; path: string }
  | { type: 'merge-zip'; archives: string[]; path: string; excludePrefixes?: string[] }

export interface InstallMaterializeTask {
  type: 'materialize'
  id: string
  root: string
  operations: MaterializeOperation[]
  dependsOn?: string[]
}

export type InstallTask = InstallFilesTask | InstallJavaTask | InstallMaterializeTask

export interface InstallManifest {
  version: 1
  tasks: InstallTask[]
}

export type InstallPhase =
  | 'task-start'
  | 'file-start'
  | 'file-skip'
  | 'file-done'
  | 'task-done'
  | 'done'

export interface InstallProgress {
  phase: InstallPhase
  taskId?: string
  taskType?: InstallTask['type']
  currentFile?: string
  completedFiles: number
  totalFiles: number
  downloadedFiles: number
  skippedFiles: number
  bytes: number
  totalBytes: number
  downloadedBytes: number
  bytesPerSecond: number
}

export interface InstallReport {
  tasks: number
  files: number
  downloadedFiles: number
  skippedFiles: number
  bytes: number
  downloadedBytes: number
  durationMs: number
}
