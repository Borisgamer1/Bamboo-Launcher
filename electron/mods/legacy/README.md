# Legacy IPC adapters

`main.js` owns four IPC channels with frozen payloads. `../legacy-bridge.ts` is
only a facade; each channel has one adapter:

| Channel | Adapter | Owns |
| --- | --- | --- |
| `import-profile` | `pack-import.ts` | staging import, content selection, `profiles.json` |
| `export-profile` | `pack-export.ts` | selection flags, provider lookup, archive destination |
| `download-mod` | `mod-install.ts` | Modrinth/CurseForge source resolution, destination folder |
| `delete-content-file` | `content-remove.ts` | path mapping, idempotent removal |

Shared vocabulary is in `shared.ts`: profile root, `profiles/<name>` path,
item-type → content folder, per-instance `mods.index.json`, `profileSlug`.
Dependency/loader key translation is in `pack-format.ts`.

Rules for later passes:

- Core modules own bytes and state: `installModpack`, `exportModpack`,
  `installModrinthProject`, `removeInstalledContent`, `commit*` in
  `content-state.ts`. Adapters never write content directly.
- Provider URL shapes live with the provider: `curseForgeFileIdFromUrl` in
  `../curseforge.ts`, `modrinthVersionIdFromCdnUrl` in `../modrinth.ts`.
- Channel names, payloads and return shapes are the renderer contract. Changing
  one requires a UI change, not just an adapter change.
