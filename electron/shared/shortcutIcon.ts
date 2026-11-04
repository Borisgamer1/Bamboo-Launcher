/**
 * Desktop shortcuts must use the instance cover, never the launcher logo. The
 * shell only accepts an .ico path, so a resolved cover image is wrapped in a
 * single-image ICO container (PNG payload, 256 px, supported since Vista).
 */
export const DEFAULT_INSTANCE_COVER = 'java-edition.jpg';

export type InstanceCoverSource =
  | { kind: 'data-url'; value: string }
  | { kind: 'bundled'; file: string }
  | { kind: 'file'; path: string }
  | { kind: 'default' };

const EMBEDDED_IMG = /<img\b[^>]*\bsrc=["']([^"']+)["']/i;
const DATA_URL = /^data:image\/(?:png|jpe?g|webp);base64,/i;
const BUNDLED = /^(?:\.\/|\/)?instance-covers\/([a-z0-9._-]+\.(?:jpe?g|png|webp))$/i;
const BAMBOO_FILE = /^bamboo-file:\/\/(.+)$/i;
const FILE_URL = /^file:\/\/(.+)$/i;
const WINDOWS_PATH = /^[a-z]:[\\/]/i;
const UNC_PATH = /^\\\\/;

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseInstanceCoverSource(value: unknown): InstanceCoverSource {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { kind: 'default' };

  const embedded = EMBEDDED_IMG.exec(raw);
  const candidate = (embedded ? embedded[1] : raw).trim();
  if (!candidate) return { kind: 'default' };

  if (DATA_URL.test(candidate)) return { kind: 'data-url', value: candidate };

  const bundled = BUNDLED.exec(candidate);
  if (bundled) return { kind: 'bundled', file: bundled[1] };

  const bambooFile = BAMBOO_FILE.exec(candidate);
  if (bambooFile) {
    const path = decodePath(bambooFile[1]);
    return path ? { kind: 'file', path } : { kind: 'default' };
  }

  const fileUrl = FILE_URL.exec(candidate);
  if (fileUrl) {
    const path = decodePath(fileUrl[1]);
    return path ? { kind: 'file', path } : { kind: 'default' };
  }

  if (WINDOWS_PATH.test(candidate) || UNC_PATH.test(candidate) || candidate.startsWith('/')) {
    return { kind: 'file', path: candidate };
  }

  // Remote legacy covers and emoji placeholders must not fall back to the
  // launcher logo; the caller resolves the bundled default instead.
  return { kind: 'default' };
}

/** A missing or unusable cover still becomes an instance image, never the logo. */
export function shortcutCoverPlan(value: unknown): InstanceCoverSource {
  const source = parseInstanceCoverSource(value);
  return source.kind === 'default' ? { kind: 'bundled', file: DEFAULT_INSTANCE_COVER } : source;
}

export function shortcutIconFileName(folderName: string): string {
  const safe = String(folderName || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `${safe || 'instance'}.ico`;
}

/** ICO with one 256 px PNG image; offsets and sizes are little-endian. */
export function pngToIco(png: Buffer): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}
