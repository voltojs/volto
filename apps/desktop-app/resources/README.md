# App icon sources

`icon.svg` is the editable source. Tauri's bundler needs raster icons; the PNG used by the
current build lives at `src-tauri/icons/icon.png` (512×512).

Regenerate the full Tauri icon set (macOS `.icns`, Windows `.ico`, PNG sizes) with:

```bash
pnpm --filter @voltojs/desktop-app tauri icon resources/icon.svg
```

`tauri.conf.json` points at `icons/icon.png` and keeps `bundle.active = false`, so a normal
`tauri build --no-bundle` only needs that one file. Release bundles need the generated set.
