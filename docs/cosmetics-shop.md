# Cosmetics

The launcher installs, previews and deletes `.cosmiq` packages. Equipping stays
in game: the wardrobe reads the packages and the player picks what to wear.

## Where the files live

Cosmetics belong to the account, not to one instance. The library is the truth:

```
<launcher appData>/cosmetics/<name>.cosmiq     # library
<instance>/bamboo/cosmetics/<name>.cosmiq      # mirror the game reads
```

The game only reads the instance folder, so every instance gets a copy. Install
writes the library and all instances, delete removes both, and a start re-syncs
so an instance created later still sees everything. Packages that exist only in
an instance folder (hand-exported from the editor) are adopted into the library
instead of being deleted, and a modified copy is never overwritten.

## Reading a package

`.cosmiq` is a Cosmiq container:

```
"COSMIQCP" | version (1 byte, 1) | manifest length (int32 BE) | model length (int32 BE)
| manifest JSON | model JSON
```

The model is a Blockbench `java_block` document with PNG textures embedded as
data URLs. Its `cosmiq.bamboo.fit` is already baked into the elements, so the
launcher renders the geometry as authored in feet space (y = 0 on the ground,
+Z behind the player). Metadata comes from the manifest; rarity from
`cosmiq.bamboo.rarity`; a `bamboo-cape` tag marks a cape.

Limits: 16 MB per file, 64 KB manifest, 12 MB model, 4 MB per texture.
`electron/cosmetics/cosmiq.ts` does the parsing and has no Electron dependency.

## The shop catalog

The catalog lives in the public shop repo
`https://github.com/Borisgamer1/Bamboo-Cosmetics`:

```
catalog.json        # entries below
packages/*.cosmiq   # the packages the entries point at
```

Shape of `catalog.json`:

```json
{
  "version": 1,
  "items": [
    {
      "id": "bird-cape",
      "name": "Bird Cape",
      "creator": "Bamboo Launcher",
      "description": "Cape with Green Bird",
      "rarity": "Legendary",
      "slots": ["back", "cape"],
      "file": "./bird-cape.cosmiq"
    }
  ]
}
```

- `file` is resolved relative to the catalog, so `./packages/x.cosmiq` becomes
  a raw GitHub URL. A full `https://` URL also works.
- `slots` is `head`, `back` and/or `cape` and only drives the label and icon;
  the in-game body slot comes from the package itself.
- Card text comes from the catalog; installing and previewing always re-read the
  package, so a wrong catalog entry cannot change what is written.

Card artwork: add `"image": "./previews/<id>.png"` to an entry. Bundled
thumbnails are read as data URLs (the renderer cannot touch files), remote ones
load from raw GitHub.

The launcher requests the public catalog first:

```
https://raw.githubusercontent.com/Borisgamer1/Bamboo-Cosmetics/main/catalog.json
```

If that fails it uses `resources/cosmetics-shop/catalog.json`, a copy of the
same items, so the shop keeps working offline. To publish an item, put the
`.cosmiq` file into `packages/` of the shop repo and add its entry to
`catalog.json`; nothing in the launcher needs to change. The URL lives in
`electron/cosmetics/shop.ts`.

## Out of scope

- No equipping or loadout state in the launcher.
- No accounts, prices or server: the shop is a file list, not a store.
- No thumbnails; the selected item is rendered in the 3D stage.
