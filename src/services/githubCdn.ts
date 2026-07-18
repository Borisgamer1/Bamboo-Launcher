// ============================================================
// GitHub CDN Service v1.0.0
// Fetches manifests and files from jsDelivr CDN (backed by
// the Bamboo-Launcher---Content GitHub repository).
// ============================================================

import type { AssetManifest, ManifestFile } from "./assetManifest";

// ===== Configuration =====

/** GitHub owner of the content repository */
const GITHUB_OWNER = "Borisgamer1";

/** GitHub repository name for content */
const GITHUB_REPO = "Bamboo-Launcher---Content";

/** Branch to fetch from */
const CDN_BRANCH = "main";

/** Base jsDelivr CDN URL */
export const CDN_BASE = `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${CDN_BRANCH}`;

/** Alternative raw GitHub URL (fallback) */
export const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${CDN_BRANCH}`;

/** GitHub Releases download base (for large files) */
export const RELEASES_BASE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download`;

// ===== Configuration =====

const CONFIG = {
  /** Timeout for HTTP requests (ms) */
  requestTimeout: 15000,
  /** Max retries per request */
  maxRetries: 2,
  /** Delay between retries (ms) */
  retryDelay: 800,
  /** How long to cache manifest fetch in memory (ms) */
  manifestCacheMs: 60000,
};

// ===== CDN URL Builders =====

/** Build the URL for the root manifest.json */
export function getManifestUrl(): string {
  return `${CDN_BASE}/manifest.json`;
}

/** Build the URL for a specific file in the repo */
export function getFileUrl(filePath: string): string {
  return `${CDN_BASE}/${encodeURI(filePath)}`;
}

/** Build a fallback raw GitHub URL */
export function getRawFileUrl(filePath: string): string {
  return `${RAW_BASE}/${encodeURI(filePath)}`;
}

/** Build a GitHub Releases download URL for a tag + asset name */
export function getReleaseDownloadUrl(tag: string, assetName: string): string {
  return `${RELEASES_BASE}/${tag}/${encodeURIComponent(assetName)}`;
}

// ===== Memoization =====

let _manifestCache: { manifest: AssetManifest; fetchedAt: number } | null = null;

// ===== API: Fetch Manifest =====

/**
 * Fetch the root asset manifest from CDN.
 * Results are cached in memory for CONFIG.manifestCacheMs.
 */
export async function fetchManifest(): Promise<AssetManifest> {
  const now = Date.now();
  if (_manifestCache && (now - _manifestCache.fetchedAt) < CONFIG.manifestCacheMs) {
    return _manifestCache.manifest;
  }

  const url = getManifestUrl();
  const manifest = await fetchWithRetry<AssetManifest>(url, {
    headers: { Accept: "application/json" },
  });

  _manifestCache = { manifest, fetchedAt: now };
  return manifest;
}

/** Invalidate the in-memory manifest cache */
export function invalidateManifestCache(): void {
  _manifestCache = null;
}

// ===== API: Download File =====

/**
 * Download a single file from CDN as an ArrayBuffer.
 * Returns the raw bytes and the file metadata.
 */
export async function downloadFile(
  file: ManifestFile,
  onProgress?: (bytesDownloaded: number, totalBytes: number) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const url = getFileUrl(file.path);

  const response = await fetchWithRetryResponse(url, {
    signal,
    headers: { Accept: "*/*" },
  });

  // Read with progress tracking if content-length is available
  if (onProgress && response.body) {
    return readWithProgress(response, file.size, onProgress);
  }

  const data = await response.arrayBuffer();
  return data;
}

/**
 * Download a file from CDN using the fallback raw GitHub URL.
 */
export async function downloadFileFallback(
  file: ManifestFile,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const url = getRawFileUrl(file.path);
  const response = await fetchWithRetryResponse(url, { signal });
  return response.arrayBuffer();
}

// ===== Internal: Fetch Helpers =====

async function fetchWithRetry<T>(
  url: string,
  options: RequestInit & { headers?: Record<string, string> },
  retries: number = CONFIG.maxRetries
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.json();
    } catch (err: any) {
      if (attempt >= retries) {
        throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts: ${err.message}`);
      }
      await delay(CONFIG.retryDelay * (attempt + 1));
    }
  }
  throw new Error(`Unreachable: fetch ${url}`);
}

async function fetchWithRetryResponse(
  url: string,
  options: RequestInit & { headers?: Record<string, string> },
  retries: number = CONFIG.maxRetries
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return response;
    } catch (err: any) {
      if (attempt >= retries) {
        throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts: ${err.message}`);
      }
      await delay(CONFIG.retryDelay * (attempt + 1));
    }
  }
  throw new Error(`Unreachable: fetch ${url}`);
}

/** Read a response body with progress tracking */
async function readWithProgress(
  response: Response,
  totalBytes: number,
  onProgress: (downloaded: number, total: number) => void
): Promise<ArrayBuffer> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    received += value.length;
    onProgress(received, totalBytes);
  }

  // Combine chunks into a single ArrayBuffer
  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result.buffer;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== API: Check if CDN is reachable =====

let _cdnAvailable: boolean | null = null;

export async function isCdnReachable(): Promise<boolean> {
  if (_cdnAvailable !== null) return _cdnAvailable;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(getManifestUrl(), {
      method: "HEAD",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    _cdnAvailable = response.ok;
    return _cdnAvailable;
  } catch {
    _cdnAvailable = false;
    return false;
  }
}

/** Reset CDN reachability check */
export function resetCdnReachability(): void {
  _cdnAvailable = null;
}
