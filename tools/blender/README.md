# Touge Blender assets

Tested with Blender 5.2.3 LTS. No downloads, add-ons, or Python dependencies are needed.

The coupe generator was written through the configured Claude API (`claude-fable-5-2`), then executed and visually reviewed locally. The pass generator and game integration were implemented locally. Both scripts are editable source; the renders show their actual geometry.

From the game directory:

```sh
blender --background --factory-startup --python-exit-code 1 --python tools/blender/build_touge_assets.py -- --output-dir public/assets/touge --review-dir art/touge
blender --background --factory-startup --python-exit-code 1 --python tools/blender/build_pass.py -- --output-dir public/assets/touge --review-dir art/touge
```

Add `--skip-render` to either command for export only. The coupe command produces `coupe.glb`, `build_manifest.json`, an editable `coupe.blend`, and front/rear studio PNGs. The pass command produces `mountain_pass.glb`, `route.json`, `pass_manifest.json`, `pass.blend`, and an overview PNG.

Assets export in glTF Y-up coordinates, with forward along -Z. `CAR_ROOT` is at the physics centre of mass. The four wheel pivots stay at their suspension mounts in the exported GLB; the game supplies suspension travel, steering, and spin. The review `.blend` poses the car on its wheels instead. The game collider is 0.96 m half-wide to match the coupe's 1.0 m visual half-width.

The 1.09 km road loop stays level; the surrounding terrain forms cut banks and ridges. Road, terrain, and guardrail meshes carry `collision: "trimesh"` extras that the game turns into static Rapier colliders. Trees are merged into spatial chunks and have no collisions. The route metadata drives the HUD map and distance label.

The runtime loads the GLBs from `public/assets/touge/`. Model/route contracts and interpolation are covered by `npm test`; the scripts are verified by running Blender and inspecting their renders. No photorealistic asset or geographic accuracy is claimed.
