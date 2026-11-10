# Bamboo Cosmetics

Cosmetic packages for Bamboo Launcher. The launcher reads `catalog.json` from
this repo and installs the `.cosmiq` files the entries point at.

```
catalog.json          # what the shop shows
packages/*.cosmiq     # the packages themselves
previews/*.png        # card artwork, one per item
```

## Add an item

1. Export the cosmetic from Cosmiq as a `.cosmiq` file.
2. Drop it into `packages/`.
3. Add one entry to `catalog.json`:

```json
{
  "id": "bird-cape",
  "name": "Bird Cape",
  "creator": "Bamboo Launcher",
  "description": "Cape with Green Bird",
  "rarity": "Legendary",
  "slots": ["back", "cape"],
  "file": "./packages/bird-cape.cosmiq",
  "image": "./previews/bird-cape.png"
}
```

`id` is unique and stable (the launcher uses it to know what is installed).
`rarity` is `Common`, `Uncommon`, `Rare`, `Epic` or `Legendary`. `slots` is
`head`, `back` and/or `cape` and only drives the icon and label; the in-game
slot comes from the package itself. `file` and `image` are relative to this
catalog; the image is optional (5:8 portrait looks best, up to 2 MB).

Card text is display-only: installing and previewing always read the package,
so the shop can never change what gets written.
