export default {
  mode: "production", // production, development
  eula: true, // true, false
  server: {
    version: "1.26.13.1", // latest, preview, 1.26.13.1, 1.26.70.22-preview
    directory: "data", // folder that holds the server files
    binary: null, // null (automatic), bedrock_server, bedrock_server.exe
    downloadUrl: null, // null (official api), https://example.com/bedrock-server.zip
    autoInstall: true, // true, false
    autoUpdate: true, // true, false
    minMemoryMb: 500, // warn when system memory is below this many MB
    memoryArenas: 2, // 0 (system default), 1 or more (fewer memory arenas, less RAM used by the server)
    autoRestart: true, // true, false
    restartDelayMs: 5000, // wait before restarting a crashed server
    stopTimeoutMs: 15000, // wait for a clean stop before killing the server
    maxRestarts: 5, // crashes allowed within restartWindowMs, 0 means unlimited
    restartWindowMs: 300000 // time window used to count crashes
  },
  install: {
    retries: 3, // 1 or more download attempts
    retryDelayMs: 2000, // wait between attempts
    connectTimeoutMs: 20000, // give up when the host does not answer
    stallTimeoutMs: 30000, // give up when data stops flowing
    timeoutMs: 900000, // total time allowed for one download
    externalTools: true, // true, false (fall back to curl and wget)
    tempDirectory: null // null (system temp), /path/to/folder
  },
  network: {
    address: "128.0.0.1", // null (SERVER_IP or localhost), 93.177.64.145, play.example.com
    port: null, // null (SERVER_PORT or 19132), 1 to 65535
    portV6: null // null (port + 1 or 19133), 1 to 65535
  },
  properties: {
    "server-name": "MCJS Server", // any single line text
    "level-name": "world", // world folder name, no slashes
    gamemode: "creative", // survival, creative, adventure
    "force-gamemode": true, // true, false (true applies gamemode to an existing world)
    difficulty: "normal", // peaceful, easy, normal, hard
    "allow-cheats": false, // true, false
    "max-players": 10, // 1 or more
    "online-mode": true, // true, false
    "view-distance": 5, // 5 or more, lower uses less RAM and cpu
    "tick-distance": 4, // 4 to 12
    "player-idle-timeout": 30, // minutes, 0 disables
    "default-player-permission-level": "member", // visitor, member, operator
    "texturepack-required": false, // true, false
    "content-log-file-enabled": false, // true, false
    "compression-algorithm": "snappy", // snappy (less cpu), zlib
    "compression-threshold": 256, // 0 to 65535, smallest packet size that gets compressed
    "max-threads": 2 // 0 (all cpu cores), 1 or more, match the cpu limit of the host
  },
  access: {
    allowlist: [], // names, or { name: "Steve", xuid: "2535440312262399", ignoresPlayerLimit: false }
    operators: [], // xuids such as "2535440312262399"
    members: [], // xuids
    visitors: [] // xuids
  },
  packs: {
    scriptApiVersion: "2.1.0" // 2.1.0, 2.1.0-beta
  },
  commands: {
    namespace: "mcjs", // lowercase letters, digits and underscores
    admins: [] // gamertags allowed to run admin commands
  },
  bridge: {
    marker: "mcjs:cmd" // token without spaces
  },
  backup: {
    enabled: true, // true, false
    intervalMinutes: 0, // 0 disables automatic backups
    keep: 5, // 1 or more backups kept
    directory: "backups", // folder for backups
    holdTimeoutMs: 30000, // wait for the server to finish saving
    pollMs: 1000 // delay between save checks
  },
  plugins: {
    welcome: {
      enabled: true, // true, false
      delayMs: 5000, // wait after a player joins
      message: "welcome to {address}" // placeholders: {address}, {player}
    },
    status: {
      enabled: true, // true, false (sidebar on the right with tps, tick ms and players)
      intervalSeconds: 2, // 1 or more, refresh rate of the sidebar
      title: "server" // title shown above the sidebar
    },
    teleport: {
      maxPoints: 5, // 1 or more tp points per player
      cooldownSeconds: 10, // 0 disables the wait between /tp and /rtp
      randomRadius: 2000 // 100 or more, how far /rtp looks from 0 0
    }
  },
  chat: {
    prefix: "[ Admin]", // text shown before messages typed in the console
    prefixColor: "green", // black, dark_blue, dark_green, dark_aqua, dark_red, dark_purple, gold, gray, dark_gray, blue, green, aqua, red, light_purple, yellow, white
    messageColor: "yellow" // same colors as prefixColor
  },
  log: {
    level: "info", // error, warn, info, debug
    serverOutput: true // true, false
  }
};
