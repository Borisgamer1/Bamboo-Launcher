// ============================================================
// Download Manager v2.0.0
// Queue-based download manager with priority scheduling,
// concurrency control, exponential backoff retry, and
// per-file progress tracking.
// ============================================================

import type { ManifestFile } from "./assetManifest";
import type {
  DownloadTask,
  DownloadTaskProgress,
  DownloadQueueProgress,
  DownloadPriority,
  DownloadErrorType,
} from "./assetManifest";
import { PRIORITY_WEIGHT } from "./assetManifest";
import { downloadFile, downloadFileFallback } from "./githubCdn";
import {
  markDownloading,
  markCached,
  recordDownloadFailure,
  storeAssetData,
} from "./assetDatabase";
import { computeHash, getMimeType } from "./assetCache";

// ===== Configuration =====

const CONFIG = {
  /** Maximum concurrent downloads */
  maxConcurrency: 4,
  /** Max retries per file */
  maxRetries: 3,
  /** Base delay for exponential backoff (ms) */
  retryBaseDelay: 1000,
  /** Max backoff delay (ms) */
  retryMaxDelay: 30000,
  /** Timeout per download (ms) */
  downloadTimeout: 30000,
};

// ===== Internal State Types =====

type DownloadResult =
  | { success: true; data: ArrayBuffer }
  | { success: false; error: string; errorType: DownloadErrorType };

// ===== Download Manager =====

class DownloadManager {
  private _tasks: Map<string, DownloadTask> = new Map();
  private _queue: string[] = []; // Task IDs in priority order
  private _activeIds: Set<string> = new Set();
  private _running = false;
  private _taskIdCounter = 0;
  private _listeners: Set<() => void> = new Set();

  // Per-task progress callbacks
  private _taskCallbacks: Map<string, (progress: DownloadTaskProgress) => void> = new Map();

  // Overall progress callback
  private _overallCallback: ((progress: DownloadQueueProgress) => void) | null = null;

  // ===== Read-only State =====

  get activeCount(): number {
    return this._activeIds.size;
  }

  get queuedCount(): number {
    return this._queue.length;
  }

  get isRunning(): boolean {
    return this._running;
  }

  get tasks(): DownloadTask[] {
    return Array.from(this._tasks.values());
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify(): void {
    this._listeners.forEach((fn) => fn());
    this.emitOverallProgress();
  }

  // ===== Enqueue =====

  /**
   * Enqueue a file for download.
   * Returns the task ID that can be used to track progress.
   */
  enqueue(
    file: ManifestFile,
    priority: DownloadPriority = "normal",
    onProgress?: (progress: DownloadTaskProgress) => void
  ): string {
    const id = `dl_${++this._taskIdCounter}_${Date.now()}`;

    const task: DownloadTask = {
      id,
      file,
      priority,
      state: "queued",
      bytesDownloaded: 0,
      retryCount: 0,
      maxRetries: CONFIG.maxRetries,
      createdAt: Date.now(),
    };

    this._tasks.set(id, task);

    // Insert into queue at priority position
    this.insertByPriority(id);

    if (onProgress) {
      this._taskCallbacks.set(id, onProgress);
    }

    this.notify();

    // Auto-start processing
    if (!this._running) {
      this.processQueue();
    }

    return id;
  }

  /**
   * Enqueue multiple files at once.
   */
  enqueueBatch(
    files: ManifestFile[],
    priority: DownloadPriority = "normal",
    onProgress?: (progress: DownloadTaskProgress) => void
  ): string[] {
    return files.map((f) => this.enqueue(f, priority, onProgress));
  }

  /**
   * Set overall progress callback.
   */
  onOverallProgress(callback: (progress: DownloadQueueProgress) => void): void {
    this._overallCallback = callback;
  }

  // ===== Control =====

  /** Cancel a specific task */
  cancel(taskId: string): void {
    const task = this._tasks.get(taskId);
    if (!task) return;

    if (task.state === "downloading") {
      // Can't abort mid-download easily, but mark as cancelled
      task.state = "cancelled";
      this._activeIds.delete(taskId);
    } else {
      task.state = "cancelled";
      this._queue = this._queue.filter((id) => id !== taskId);
    }

    this._taskCallbacks.delete(taskId);
    this.notify();
  }

  /** Cancel all queued tasks (not currently downloading) */
  cancelAll(): void {
    for (const task of this._tasks.values()) {
      if (task.state === "queued") {
        task.state = "cancelled";
      }
    }
    this._queue = [];
    this.notify();
  }

  /** Get task by ID */
  getTask(taskId: string): DownloadTask | undefined {
    return this._tasks.get(taskId);
  }

  // ===== Queue Processing =====

  private insertByPriority(id: string): void {
    const task = this._tasks.get(id);
    if (!task) return;

    const weight = PRIORITY_WEIGHT[task.priority];
    let insertIdx = this._queue.length;

    for (let i = 0; i < this._queue.length; i++) {
      const other = this._tasks.get(this._queue[i]);
      if (other && PRIORITY_WEIGHT[other.priority] > weight) {
        insertIdx = i;
        break;
      }
    }

    this._queue.splice(insertIdx, 0, id);
  }

  private async processQueue(): Promise<void> {
    if (this._running) return;
    this._running = true;

    try {
      while (this._queue.length > 0 || this._activeIds.size > 0) {
        // Start new downloads up to max concurrency
        while (this._activeIds.size < CONFIG.maxConcurrency && this._queue.length > 0) {
          const taskId = this._queue.shift()!;
          const task = this._tasks.get(taskId);
          if (!task || task.state === "cancelled") continue;

          this._activeIds.add(taskId);
          // Fire and forget - errors handled within
          this.processTask(task);
        }

        // Wait a tick before checking again
        await delay(50);

        // If queue is empty and no active downloads, we're done
        if (this._queue.length === 0 && this._activeIds.size === 0) break;
      }
    } finally {
      this._running = false;
      this.notify();
    }
  }

  private async processTask(task: DownloadTask): Promise<void> {
    task.state = "downloading";
    task.startedAt = Date.now();
    this.notify();

    // Mark in database
    await markDownloading(task.file.path).catch(() => {});

    const result = await this.downloadWithRetry(task);

    if (result.success) {
      // Verify hash
      const hash = await computeHash(result.data);
      if (hash !== task.file.hash) {
        this.handleTaskFailure(
          task,
          `Hash mismatch: expected ${task.file.hash}, got ${hash}`,
          "hash_mismatch"
        );
        return;
      }

      // Store in cache
      const mimeType = getMimeType(task.file.path);
      await storeAssetData(task.file.path, result.data);

      // Mark as cached in status DB
      await markCached(task.file.path, hash, task.file.size, 0, mimeType);

      // Success
      task.state = "complete";
      task.completedAt = Date.now();
      task.bytesDownloaded = task.file.size;

      this.emitTaskProgress(task);
    } else {
      // TypeScript narrows result to the failure branch here
      const failure = result as { success: false; error: string; errorType: DownloadErrorType };
      this.handleTaskFailure(task, failure.error, failure.errorType);
    }

    this._activeIds.delete(task.id);
    this.notify();
  }

  private handleTaskFailure(
    task: DownloadTask,
    error: string,
    errorType: DownloadErrorType
  ): void {
    task.retryCount++;

    if (task.retryCount <= task.maxRetries) {
      // Re-queue for retry
      task.state = "queued";
      task.error = error;
      task.errorType = errorType;
      task.bytesDownloaded = 0;
      this.insertByPriority(task.id);
    } else {
      // Max retries exhausted
      task.state = "failed";
      task.error = error;
      task.errorType = errorType;
      task.completedAt = Date.now();

      // Record failure in database
      recordDownloadFailure(task.file.path, error, errorType).catch(() => {});
    }

    this.emitTaskProgress(task);
  }

  private async downloadWithRetry(task: DownloadTask): Promise<DownloadResult> {
    const currentRetry = task.retryCount;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.downloadTimeout);

      const data = await downloadFile(
        task.file,
        (bytes: number, total: number) => {
          task.bytesDownloaded = bytes;
          this.emitTaskProgress(task);
        },
        controller.signal
      );

      clearTimeout(timeoutId);
      return { success: true, data };
    } catch (err: any) {
      const errorType = categorizeError(err);
      return { success: false, error: err.message || "Unknown error", errorType };
    }
  }

  // ===== Progress Emitters =====

  private emitTaskProgress(task: DownloadTask): void {
    const cb = this._taskCallbacks.get(task.id);
    if (cb) {
      cb({
        taskId: task.id,
        filePath: task.file.path,
        bytesDownloaded: task.bytesDownloaded,
        totalBytes: task.file.size,
        percent: task.file.size > 0
          ? Math.round((task.bytesDownloaded / task.file.size) * 100)
          : 0,
      });
    }
    this.emitOverallProgress();
  }

  private emitOverallProgress(): void {
    if (!this._overallCallback) return;

    const allTasks = Array.from(this._tasks.values()).filter(
      (t) => t.state !== "cancelled"
    );
    const complete = allTasks.filter((t) => t.state === "complete").length;
    const failed = allTasks.filter((t) => t.state === "failed").length;
    const bytesDone = allTasks.reduce((sum, t) => sum + t.bytesDownloaded, 0);
    const bytesTotal = allTasks.reduce((sum, t) => sum + t.file.size, 0);

    const progress: DownloadQueueProgress = {
      phase: this.isRunning ? "downloading" : (complete + failed >= allTasks.length ? "complete" : "idle"),
      tasksTotal: allTasks.length,
      tasksComplete: complete,
      tasksFailed: failed,
      bytesDownloaded: bytesDone,
      bytesTotal,
      percent: bytesTotal > 0 ? Math.round((bytesDone / bytesTotal) * 100) : 0,
      currentFile: Array.from(this._activeIds)
        .map((id) => this._tasks.get(id)?.file.path)
        .filter(Boolean)
        .join(", ") || "",
    };

    this._overallCallback(progress);
  }
}

// ===== Helpers =====

function categorizeError(err: any): DownloadErrorType {
  const msg = (err.message || "").toLowerCase();
  if (err.name === "AbortError" || msg.includes("timeout") || msg.includes("abort")) {
    return "timeout";
  }
  if (msg.includes("hash mismatch")) return "hash_mismatch";
  if (msg.includes("size mismatch")) return "size_mismatch";
  if (msg.includes("http")) return "http_error";
  if (msg.includes("network") || msg.includes("fetch")) return "network";
  return "unknown";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== Singleton Export =====

export const downloadManager = new DownloadManager();
export default downloadManager;
