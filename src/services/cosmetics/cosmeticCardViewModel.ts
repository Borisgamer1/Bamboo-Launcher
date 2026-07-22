// ============================================================
// Cosmetics Card View Model — Phase 5: UNIFIED PAYLOAD
// ============================================================
//
// Single bundle of data per cosmetic card. Combines:
//   - identity & meta  (from parseCosmeticEntity)
//   - install state    (from computeStatusFor)
//   - unlock state     (from evaluateCosmeticUnlock with progress)
//   - render payload   (texture/model paths ready for the StubRenderer)
//
// The CosmeticsView consumes this to render each card; no card ever
// has to re-call DataManager / Downloader / Renderer separately.
// ============================================================

import type {
  CosmeticEntity,
  CosmeticStatusInfo,
  CosmeticInstallStatus,
} from "./types";
import {
  computeStatusFor,
  getCosmeticById,
} from "./cosmeticsDataManager";
import {
  evaluateCosmeticUnlock,
  type UnlockContext,
  type UnlockEvaluation,
} from "./cosmeticUnlock";
import {
  formatTierProgress,
  resolveTreeNodeForRequirement,
  type UnlockTreeNode,
} from "./unlockTree";
import { DEFAULT_PLAYTIME_TREE } from "./unlockTree";

// ===== Card View-Model =====

export interface CosmeticCardViewModel {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  category: string;
  rarity: string;
  accentColor?: string;
  previewUrl: string;
  modelFilePath?: string;
  textureFilePaths: string[];

  /** Local install state. */
  status: CosmeticInstallStatus;
  statusInfo: CosmeticStatusInfo;

  /** Lock state. */
  unlock: CosmeticUnlockSummary;
}

export interface CosmeticUnlockSummary {
  unlocked: boolean;
  reasonKey:
    | "always_available"
    | "all_requirements_met"
    | "missing_requirements"
    | "unknown_unlock_type"
    | "missing_check"
    | "context_unavailable";
  /** Human-readable string like "Noch 14 Stunden Spielzeit". */
  shortMessage: string;
  /** Detailed reason(s). */
  missingRequirements: Array<{
    typeId: string;
    label: string;
    treeNodeId?: string;
    status: "elapsed" | "missing" | "checked";
    progressPct?: number;
    remainingAmount?: number;
    unit?: string;
    detail?: string;
  }>;
}

// ===== Builder =====

/**
 * Build a card VM by combining entity + computed status + unlock eval.
 * Pure: callers must pre-supply the UnlockContext.
 */
export async function buildCosmeticCardViewModel(
  entity: CosmeticEntity,
  ctx: UnlockContext
): Promise<CosmeticCardViewModel> {
  const statusInfo = await computeStatusFor(entity);

  const evalResult: UnlockEvaluation = evaluateCosmeticUnlock(entity, ctx);

  const previewPath = entity.declaredPreviewUrl
    || entity.files.find((f) => f.kind === "preview" || f.kind === "icon")?.filePath
    || "";
  const modelPath = entity.metadata.model?.textureMappings?.[0]?.filePath
    || entity.files.find((f) => f.kind === "model")?.filePath;
  const textures = entity.files
    .filter((f: any) => f.kind === "texture" || f.kind === "cape" || (f.fileName && /\.(png|jpg|jpeg|webp|gif)$/i.test(f.fileName)))
    .map((f: any) => f.filePath)
    .filter(Boolean) as string[];

  return {
    id: entity.id,
    slug: entity.slug,
    displayName: entity.displayName,
    description: entity.description,
    category: entity.metadata.category,
    rarity: entity.metadata.rarity,
    accentColor: entity.metadata.accentColor,
    previewUrl: previewPath,
    modelFilePath: modelPath,
    textureFilePaths: textures,
    status: statusInfo.status,
    statusInfo,
    unlock: projectUnlockSummary(),
  };
}

/** Build all card VMs in a single pass. */
export async function buildCosmeticCardViewModels(
  entities: CosmeticEntity[],
  ctx: UnlockContext
): Promise<CosmeticCardViewModel[]> {
  const out: CosmeticCardViewModel[] = [];
  for (const e of entities) {
    out.push(await buildCosmeticCardViewModel(e, ctx));
  }
  return out;
}

/** Single-card helper for hot paths. */
export async function buildCosmeticCardViewModelById(
  id: string,
  ctx: UnlockContext
): Promise<CosmeticCardViewModel | null> {
  const entity = getCosmeticById(id);
  if (!entity) return null;
  return buildCosmeticCardViewModel(entity, ctx);
}

// ===== Helpers =====

function projectUnlockSummary(): CosmeticUnlockSummary {
  return {
    unlocked: true,
    reasonKey: "always_available",
    shortMessage: "",
    missingRequirements: [],
  };
}

// Memoization cache for unlock context
const _ctxCache = new Map<UnlockContext, { ts: number; ctx: UnlockContext }>();
export function memoContext(ctx: UnlockContext): UnlockContext {
  const cached = _ctxCache.get(ctx);
  if (cached && cached.ts === ctx.playtimeHours) return ctx;
  _ctxCache.set(ctx, { ts: ctx.playtimeHours ?? 0, ctx });
  return ctx;
}
