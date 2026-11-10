/**
 * Instance cover images: a curated set extracted from the wallpaper bundles in
 * `resources/Instanz Vorlagen`, plus images the user uploaded once and reuses
 * across instances. Uploaded covers live in localStorage as compressed JPEG
 * data URLs so they survive restarts without touching the profile store.
 */

export const INSTANCE_COVER_IDS = [
  "15th-anniversary",
  "aquatic-update",
  "bedrock-edition",
  "bundles-of-bravery",
  "burberry",
  "buzzy-bees",
  "cats-and-pandas",
  "caves-and-cliffs-1",
  "caves-and-cliffs-2",
  "chaos-cubed",
  "chase-the-skies",
  "copper-age",
  "default-skins",
  "island",
  "java-edition",
  "marketplace-blm",
  "marketplace-crocs",
  "marketplace-pride-2021",
  "marketplace-pride-2022",
  "mineshaft",
  "mounts-of-mayhem",
  "movie-bees",
  "movie-creeper",
  "movie-portal",
  "movie-vista",
  "nether-update",
  "ocean-monument",
  "pc-bundle",
  "spring-to-life",
  "the-garden-awakens",
  "tiny-takeover",
  "tiny-takeover-axolotl",
  "tiny-takeover-bee",
  "trails-and-tales",
  "tricky-trials",
  "village-and-pillage",
  "wild-update",
  "wild-update-adventure",
  "wild-update-mangroves",
  "wild-update-warden",
  "wilderness-bound",
  "winter-celebration",
  "world-color",
] as const;

export type InstanceCoverId = (typeof INSTANCE_COVER_IDS)[number];

/** Relative so the built renderer also works from `file://`. */
export function instanceCoverSrc(id: string): string {
  return `./instance-covers/${id}.jpg`;
}

export function instanceCoverLabel(id: string): string {
  return id
    .split("-")
    .map((part) => (part.length <= 2 ? part : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

export function pickRandomInstanceCover(): string {
  const index = Math.floor(Math.random() * INSTANCE_COVER_IDS.length);
  return instanceCoverSrc(INSTANCE_COVER_IDS[index]);
}

/** Old builds seeded instances from three Unsplash photos; those are gone. */
export function isLegacyInstanceCover(value: string): boolean {
  return /^https:\/\/images\.unsplash\.com\//i.test(value);
}

/** Stable replacement so an old instance does not change cover on every start. */
export function instanceCoverForSeed(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return instanceCoverSrc(INSTANCE_COVER_IDS[Math.abs(hash) % INSTANCE_COVER_IDS.length]);
}

export interface InstanceCoverIdentity {
  id?: string;
  name?: string;
}

/** The one seed policy shared by profile mapping and serialization. */
export function instanceCoverSeed(source: InstanceCoverIdentity, index = 0): string {
  return source.id || source.name || String(index);
}

/** One place for the rule that a dead external seed becomes a bundled cover. */
export function normalizeInstanceCover(
  value: string,
  source: InstanceCoverIdentity,
  index = 0,
): string {
  return isLegacyInstanceCover(value)
    ? instanceCoverForSeed(instanceCoverSeed(source, index))
    : value;
}

export interface UploadedInstanceCover {
  id: string;
  dataUrl: string;
  addedAt: number;
}

export const UPLOADED_COVERS_KEY = "bamboo-instance-covers";
const MAX_UPLOADED_COVERS = 18;
const COVER_WIDTH = 1280;
const COVER_HEIGHT = 720;

function isUploadedCover(value: unknown): value is UploadedInstanceCover {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.dataUrl === "string" &&
    entry.dataUrl.startsWith("data:image/") &&
    typeof entry.addedAt === "number"
  );
}

export function readUploadedInstanceCovers(): UploadedInstanceCover[] {
  try {
    const raw = localStorage.getItem(UPLOADED_COVERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUploadedCover);
  } catch {
    return [];
  }
}

/**
 * Compress an arbitrary uploaded image into a 16:9 JPEG, so a 20 MB photo does
 * not eat the whole localStorage quota. Falls back to the original data URL.
 */
export async function prepareInstanceCover(dataUrl: string): Promise<string> {
  if (typeof document === "undefined") return dataUrl;
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = COVER_WIDTH;
        canvas.height = COVER_HEIGHT;
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(dataUrl);
          return;
        }
        const scale = Math.max(COVER_WIDTH / image.width, COVER_HEIGHT / image.height);
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;
        context.drawImage(
          image,
          (COVER_WIDTH - drawWidth) / 2,
          (COVER_HEIGHT - drawHeight) / 2,
          drawWidth,
          drawHeight,
        );
        resolve(canvas.toDataURL("image/jpeg", 0.84));
      } catch {
        resolve(dataUrl);
      }
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

export function saveUploadedInstanceCover(dataUrl: string): UploadedInstanceCover | null {
  const cover: UploadedInstanceCover = {
    id: `cover_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    dataUrl,
    addedAt: Date.now(),
  };
  const next = [cover, ...readUploadedInstanceCovers().filter((entry) => entry.dataUrl !== dataUrl)]
    .slice(0, MAX_UPLOADED_COVERS);
  try {
    localStorage.setItem(UPLOADED_COVERS_KEY, JSON.stringify(next));
    return cover;
  } catch {
    // Quota exceeded: the caller can still use the image for this instance.
    return null;
  }
}
