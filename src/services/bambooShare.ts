// ============================================================
// Bamboo Share Service v0.1.0
// Client for share code management
// ============================================================

import { API_BASE } from "./api";

// ===== Types =====

export interface ShareInfo {
  shareCode: string;
  title: string;
  description: string;
  minecraftVersion: string;
  modloader: string;
  modloaderVersion: string;
  fileSize: number;
  modCount: number;
  resourcepackCount: number;
  shaderCount: number;
  datapackCount: number;
  worldCount: number;
  downloadCount: number;
  authorName: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface ShareCreateResult {
  shareCode: string;
  title: string;
  description: string;
  minecraftVersion: string;
  modloader: string;
  modloaderVersion: string;
  fileSize: number;
  modCount: number;
  resourcepackCount: number;
  shaderCount: number;
  datapackCount: number;
  worldCount: number;
  authorName: string;
  expiresAt: string;
  createdAt: string;
}

export interface ShareCreateRequest {
  title: string;
  description?: string;
  minecraftVersion: string;
  modloader: string;
  modloaderVersion?: string;
  fileBase64: string; // Base64-encoded file content
  fileName: string;
  modCount?: number;
  resourcepackCount?: number;
  shaderCount?: number;
  datapackCount?: number;
  worldCount?: number;
  authorName?: string;
  authorId?: string;
}

export interface ShareListEntry {
  shareCode: string;
  title: string;
  description: string;
  minecraftVersion: string;
  modloader: string;
  fileSize: number;
  downloadCount: number;
  createdAt: string;
  expiresAt: string | null;
  isActive: boolean;
}

export interface ShareStats {
  totalShares: number;
  activeShares: number;
  totalDownloads: number;
  totalSizeBytes: number;
  storagePath: string;
  maxFileSize: number;
  expiryDays: number;
}

// ===== Service =====

class BambooShareService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = `${API_BASE}/share`;
  }

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Launcher-Key": import.meta.env.VITE_LAUNCHER_KEY || "",
    };
  }

  /**
   * Create a new Bamboo Share from exported data
   */
  async createShare(request: ShareCreateRequest): Promise<ShareCreateResult> {
    const res = await fetch(`${this.baseUrl}/create`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(error.error || `Failed to create share: HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.data;
  }

  /**
   * Get information about a share by code (without downloading)
   */
  async getShareInfo(code: string): Promise<ShareInfo> {
    const res = await fetch(`${this.baseUrl}/info/${encodeURIComponent(code.toUpperCase())}`, {
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("Share-Code nicht gefunden oder abgelaufen");
      }
      throw new Error(`Failed to get share info: HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.data;
  }

  /**
   * Validate a share code without full info load
   */
  async validateCode(code: string): Promise<{ valid: boolean; reason?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/validate/${encodeURIComponent(code.toUpperCase())}`, {
        headers: this.getHeaders(),
      });

      if (!res.ok) return { valid: false, reason: "Server error" };

      const data = await res.json();
      return { valid: data.valid, reason: data.reason };
    } catch (err: any) {
      return { valid: false, reason: err.message };
    }
  }

  /**
   * Download a share by code - returns the file data as ArrayBuffer
   */
  async downloadShare(code: string): Promise<{ data: ArrayBuffer; fileName: string }> {
    const res = await fetch(`${this.baseUrl}/download/${encodeURIComponent(code.toUpperCase())}`, {
      headers: {
        "X-Launcher-Key": import.meta.env.VITE_LAUNCHER_KEY || "",
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("Share nicht gefunden oder abgelaufen");
      }
      throw new Error(`Failed to download share: HTTP ${res.status}`);
    }

    // Extract filename from Content-Disposition header
    const disposition = res.headers.get("Content-Disposition") || "";
    const fileNameMatch = disposition.match(/filename="?([^"]+)"?/);
    const fileName = fileNameMatch ? fileNameMatch[1] : `${code}.bamboo`;

    const data = await res.arrayBuffer();
    return { data, fileName };
  }

  /**
   * Delete a share by code
   */
  async deleteShare(code: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/${encodeURIComponent(code.toUpperCase())}`, {
      method: "DELETE",
      headers: this.getHeaders(),
    });

    return res.ok;
  }

  /**
   * List shares by author
   */
  async listSharesByAuthor(
    authorId: string,
    page: number = 1,
    limit: number = 20
  ): Promise<{ data: ShareListEntry[]; total: number }> {
    const res = await fetch(
      `${this.baseUrl}/author/${authorId}?page=${page}&limit=${limit}`,
      { headers: this.getHeaders() }
    );

    if (!res.ok) throw new Error(`Failed to list shares: HTTP ${res.status}`);

    const result = await res.json();
    return { data: result.data, total: result.total };
  }

  /**
   * Get share statistics
   */
  async getStats(): Promise<ShareStats> {
    const res = await fetch(`${this.baseUrl}/stats`, {
      headers: this.getHeaders(),
    });

    if (!res.ok) throw new Error(`Failed to get share stats: HTTP ${res.status}`);

    const data = await res.json();
    return data.data;
  }

  /**
   * Format file size for display
   */
  formatShareSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = bytes / Math.pow(1024, i);
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
}

export const bambooShareService = new BambooShareService();
export default bambooShareService;
