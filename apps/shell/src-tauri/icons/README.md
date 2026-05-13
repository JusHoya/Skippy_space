# `apps/shell/src-tauri/icons/`

Real Tauri 2 bundle icons live here. The agent that scaffolded this directory
cannot generate binary PNG/ICO files, so the folder is currently a placeholder.

## What needs to be here for `tauri build` to succeed

```
icons/
  32x32.png
  128x128.png
  128x128@2x.png
  icon.ico         # multi-resolution Windows .ico (16/32/48/256)
```

`tauri.conf.json` references all four. Without them, **`tauri build` will fail
at the bundling step.** `tauri dev` works fine — it does not need the icons.

## Fast path: use `tauri icon`

The official Tauri CLI ships an icon generator. Place a single 1024×1024 PNG
named `icon.png` in this directory, then from the workspace root run:

```powershell
pnpm --filter @skippy/shell tauri icon ./src-tauri/icons/icon.png
```

That will write the four required files plus a default `icon.icns` for macOS
into this directory.

## Even faster path: borrow Tauri's stock icons

```powershell
# In a scratch directory anywhere
pnpm create tauri-app scratch --template react-ts --manager pnpm
# Then copy
Copy-Item scratch\src-tauri\icons\* C:\Users\hoyer\WorkSpace\Projects\Skippy_space\apps\shell\src-tauri\icons\
```

The stock icons are generic Tauri marks. Replace them before any v1.0 ship.

## v1.0 art direction

Per PRD §12 and §3.2 the app icon should be a literature-accurate Skippy
beercan silhouette in `#66FCF1` (Neon Cyan) on `#0B0C10` (Dark Matter). The
SVG sibling file `icon.svg` in this directory is a rough starting point — feed
it through `rsvg-convert` or Inkscape at 1024×1024 to produce `icon.png`, then
run `tauri icon` per the fast path above.
