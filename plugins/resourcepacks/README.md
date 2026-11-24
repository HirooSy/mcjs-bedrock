# Resource packs

Drop resource packs into this folder. They are loaded into the world automatically the next time the server starts.

## Accepted formats

- `.mcpack`
- `.zip`
- `.mcaddon` (resource packs go here, behavior packs go to `plugins/behaviorpacks/`)
- A folder that contains `manifest.json`

## Usage

1. Upload the pack to this folder.
2. Restart the server.
3. Check the log. A pack that cannot be loaded shows as `pack <name> skipped: <reason>`.

## Notes

- `manifest.json` may sit at the root of an archive or inside a single folder.
- The pack name comes from the file or folder name. Two packs cannot share a name or a UUID.
- Remove a pack from this folder and restart to unload it from the server and the world.
- Players download resource packs when they join. Set `texturepack-required` in `config.js` to force players to use the pack.
- This `README.md` is ignored by the loader.
