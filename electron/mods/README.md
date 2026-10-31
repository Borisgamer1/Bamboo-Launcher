# Mods pipeline

Phase 1 of `MOD_HANDLING_PIPELINE_SPEC.md`: installed-file ledger plus a
provider-neutral catalog layer. No version selection, resolver, download
manager or update engine lives here yet.

## Layers (top to bottom)

| Module | Owns | Must not |
|---|---|---|
| `provider.ts` | `ModProvider` contract, file-key validation | know a provider's field names or query dialect |
| `providers/<provider>.ts` | one adapter: query dialect, cache keys, canonical mapping | do HTTP or hold provider-specific cache policy |
| `provider-cache.ts` | TTLs (search 10 min, metadata 30 min), LRU bound, in-flight dedupe, stale-while-revalidate, canonical keys | know what a project or version is |
| `loaders.ts` | the single loader catalog (Modrinth name, CurseForge id, `gameVersions` tokens) | contain provider reads |
| `modrinth.ts` / `curseforge.ts` | HTTP, auth/retries, raw response normalisation for that provider | choose versions or cache |
| `ledger.ts` | installed files keyed by SHA-1, path set, legacy migration, atomic serialised writes | fetch catalog data |

`types.ts` is the canonical vocabulary shared by every layer; `index.ts` is the
public surface of the package.

## Data flow

```
caller -> ModProvider (providers/*) -> ProviderCache -> client (modrinth.ts | curseforge.ts) -> API
                    |
                    +-> canonical ProviderProject / ProviderVersion / ProviderSearchPage
```

State has one owner: cache entries live in the `ProviderCache` instance held by
an adapter, and the on-disk ledger is owned by `ModLedger` (shadow mode: it is
only written when `save()`/`upsert()` is called). There is no module-level
mutable state.

## Where a change belongs

- New canonical field: `types.ts` + the provider's adapter mapping.
- New loader or loader alias: `loaders.ts` only.
- Cache TTL, eviction or key canonicalisation: `provider-cache.ts` only.
- A provider endpoint or its pagination: the catalog client, exposed through
  the adapter (see `filesPage`/`versionsByHashes`).
- Installed-file metadata or migration: `ledger.ts`.
