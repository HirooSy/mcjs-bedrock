# Behavior packs

Drop behavior packs into this folder. They are loaded into the world automatically the next time the server starts.

## Accepted formats

- `.mcpack`
- `.zip`
- `.mcaddon` (behavior packs go here, resource packs go to `plugins/resourcepacks/`)
- A folder that contains `manifest.json`

## Usage

1. Upload the pack to this folder.
2. Restart the server.
3. Check the log. A pack that cannot be loaded shows as `pack <name> skipped: <reason>`.

## Notes

- `manifest.json` may sit at the root of an archive or inside a single folder.
- The pack name comes from the file or folder name. Two packs cannot share a name or a UUID.
- Remove a pack from this folder and restart to unload it from the server and the world.
- This folder is empty on purpose. The built-in mcjs pack (commands and status sidebar) lives in `bridge/`.
- This `README.md` is ignored by the loader.
