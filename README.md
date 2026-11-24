# MCJS-BEDROCK

<img height="25" alt="node version" src="https://img.shields.io/badge/NodeJS_>=18-000000.svg?&style=for-the-badge&logo=node.js&logoColor=green" />

> [!NOTE]
> A Node.js manager for the Minecraft Bedrock Dedicated Server (BDS). It downloads, installs, updates, configures, restarts and backs up the server for you. No `npm install`, no manual downloads.

## Features

- Easy to set up.
- Automatic install and update from the official Mojang API, with resilient downloads and integrity checks.
- One readable `config.js` that generates `server.properties`, the allowlist and permissions.
- Auto restart after crashes, scheduled backups, clean one line logs.
- In-game slash commands, including teleport points and random teleport.
- Live status sidebar in game (TPS and tick time).
- Drop-in behavior and resource packs (`.mcpack`, `.zip`, `.mcaddon` or folders).
- Plugins written as plain JavaScript files.
- Zero dependencies: only Node.js built-in modules.

## Requirements

- Node.js 18.18 or newer
- Linux or Windows on x86_64 (BDS has no macOS or ARM build)
- An open UDP port

## Quick start

```
node .
```

On the first run mcjs downloads the server, writes its configuration, installs the bridge pack and starts it:

```
[ info ] installing bedrock server 1.26.13.1 (release)
[ info ] installed bedrock server 1.26.13.1
[ info ] server ready 93.177.64.145:5497
[ info ] player joined Steve
```

The Minecraft EULA is accepted by default (`eula: true` in `config.js`). Logs carry no timestamps; set `mode: "development"` to see the detailed output.

## Commands

| Command | Purpose |
| --- | --- |
| `node .` | Run the server, installing or updating first when needed |
| `node . install` | Install or update the server, then exit |
| `node . check` | Compare the installed version with the latest |
| `node . doctor` | Diagnose network, disk, CPU and port problems |
| `node . backups` | List backups |
| `node . restore <name>` | Restore a world from a backup (stop the server first) |
| `--config other.js` | Use another config file (`.js` or `.json`) |
| `--eula` | Accept the EULA for this run |

Exit codes: `0` success, `1` failure, `2` invalid arguments.

## Console

Anyone with panel access can type in the mcjs console while the server runs:

| Input | Result |
| --- | --- |
| `hello world` | Sent to everyone in game as a chat message: `[ Admin]` in green, then the text in yellow |
| `/list`, `/op name`, `/say hi` | Run as a server command (the slash is removed) |
| `.backup`, `.players` | Run a plugin command as admin |
| `stop` | Stop the server and mcjs |

Change the prefix and colors under `chat` in `config.js`; the accepted color names are listed there.

## In-game commands

Type them in chat with the `/mcjs:` prefix, for example `/mcjs:help`. Arguments are separated by spaces (up to 8 words).

| Command | Who | Purpose |
| --- | --- | --- |
| `help`, `ping`, `info`, `players`, `uptime` | everyone | Basic information |
| `settp [name]` | everyone | Save your position as a tp point (default name `home`) |
| `tp [name]`, `warp [name]` | everyone | Teleport to one of your tp points |
| `deltp [name]` | everyone | Delete a tp point |
| `rtp` | everyone | Teleport to a random spot in the overworld |
| `broadcast`, `cmd`, `reload`, `backup`, `restart` | admins | Server management |

Teleport notes:

- Minecraft already owns the short `/tp`, so use `/mcjs:tp` or `/warp`. The other short forms (`/settp`, `/deltp`, `/rtp`) work when the name is free.
- Tp points are per player and remember their dimension. Limits live in `plugins.teleport` (`maxPoints`, `cooldownSeconds`, `randomRadius`).
- `/rtp` spreads you around the world origin, so keep `randomRadius` modest on weak hosts; new chunks cost CPU.

Admins are the gamertags listed in `commands.admins`.

## Configuration

Edit `config.js`. Every setting has a comment listing its accepted values, and missing keys fall back to defaults. Mistakes are reported all at once at startup.

| Section | What it controls |
| --- | --- |
| `mode`, `eula` | `development` enables debug logs; the EULA flag |
| `server` | version, folder, auto install and update, auto restart, memory arenas |
| `install` | retries, timeouts, external download tools, temp folder |
| `network` | public address and ports (`null` means automatic) |
| `properties` | passed to `server.properties` (gamemode, difficulty, view distance and more) |
| `access` | allowlist and permission lists |
| `commands` | in-game command namespace and admin gamertags |
| `backup` | automatic interval, how many to keep, folder |
| `plugins` | per plugin options: `welcome`, `status`, `teleport` |
| `chat` | prefix and colors of messages typed in the console |
| `log` | level and server output |

`server.version` accepts `latest`, `preview`, an exact version such as `1.26.13.1` (pinned, never auto updated), or an exact preview such as `1.26.70.22-preview`.

`server.properties` is regenerated from `config.js` on every start. Allowlist and permission files are merged with existing ones, never overwritten. Updates keep `worlds/`, `server.properties`, `allowlist.json`, `permissions.json` and `config/`.

## Packs

Put packs in these folders and they are loaded on the next start:

- `plugins/behaviorpacks/`
- `plugins/resourcepacks/`

Accepted: `.mcpack`, `.zip`, `.mcaddon` (sorted into behavior and resource packs automatically) and plain folders. Remove a pack from the folder to unload it. Failures appear as `pack <name> skipped: <reason>`.

The mcjs bridge pack (in-game commands and the status sidebar) lives in `bridge/` and is always loaded.

## Status sidebar

The right side of the game screen shows `tps` (healthy at 20), `tick ms` (healthy near 50) and `players`. These measure the server itself, not each player's network ping, which BDS does not expose. If `tps` drops or `tick ms` climbs, the server is short on CPU; if both look healthy but the game stutters, the cause is the connection between player and server. Configure it under `plugins.status`.

## Hosting panels

Panels such as Pterodactyl pass the port in `SERVER_PORT`, which mcjs uses automatically. `SERVER_IP` is often an internal container address, so set `network.address` in `config.js` to the public address players use; it appears in the `server ready` log and the welcome message. The allocation must be UDP.

Common problems:

- `EACCES: permission denied`: the container user does not own the folder yet. Stop and start the server once, or fix the folder permissions in the panel.
- Downloads hang or fail: run `node . doctor`. It changes nothing and reports DNS, API reachability, download hosts, disk space, CPU and the port in use.

## Performance and memory

Defaults favor small servers: `view-distance` 5 in the shipped config, `snappy` compression, `max-threads: 2` (BDS in a container sees every host core and spawns too many threads) and `server.memoryArenas: 2` (limits BDS malloc arenas). Set `max-threads` to `0` on a dedicated multi-core machine.

The RAM shown by a panel is mcjs (Node, about 50 MB) plus BDS, and BDS is by far the larger part, so very low totals are not realistic.

## Plugins

Add `.js` files to `plugins/commands/` or `plugins/events/`. A file may export one plugin or an array of them.

```js
export default {
  name: "hello",
  aliases: ["hi"],
  admin: false,
  description: "say hello",
  usage: "<name>",
  run: async ({ player, args, reply, usage }) => {
    if (args.length === 0) {
      usage();
      return;
    }
    reply(`hello ${args[0]}, from ${player}`);
  }
};
```

Events use `on: "join" | "leave" | "ready"`. The context offers `player`, `xuid`, `at` (position of the player running the command), `args`, `admin`, `info`, `options`, `storage`, `players`, `reply`, `tell`, `broadcast`, `send`, `log`, `sleep`, `uptime`, `backup`, `restart` and `reload`. `storage()` gives `read` and `write` over a JSON file in `data/mcjs-plugins/`. Command names use lowercase letters, digits and underscores. Broken plugins are skipped with a warning; restart the server after adding commands so the bridge registers them.

## Backups

`/mcjs:backup` uses the official BDS protocol (`save hold`, `save query`, copy, `save resume`), so the copy is consistent while players are online. Backups go to `backups/<date>/<world>/`, only `backup.keep` are retained, and a failed backup leaves nothing behind.

## Development

```
npm test
```

Runs the Node test suite (370+ tests, under a minute) against a fake BDS and local HTTP servers. `test/style.test.js` enforces the code rules: no comments (except in `config.js`), no uppercase constants, no single module level constants, no emoji, and no `data/` folder in the repo.

Known limits:

- Nothing has been tested against the real BDS or Mojang API in the development environment; formats follow documentation and reference projects.
- The bridge pack is tested with a stand-in `@minecraft/server`. Check in-game command registration and the teleport commands once on a real server.
- `package.json` has no dependencies by design; the zip extractor (`lib/installer/zip.js`) is written in-house and checks CRC32 and path traversal.
