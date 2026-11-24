export const defaults = Object.freeze({
  mode: "production",
  eula: true,
  server: Object.freeze({
    version: "latest",
    directory: "data",
    binary: null,
    downloadUrl: null,
    autoInstall: true,
    autoUpdate: true,
    minMemoryMb: 500,
    memoryArenas: 2,
    autoRestart: true,
    restartDelayMs: 5000,
    stopTimeoutMs: 15000,
    maxRestarts: 5,
    restartWindowMs: 300000
  }),
  install: Object.freeze({
    retries: 3,
    retryDelayMs: 2000,
    connectTimeoutMs: 20000,
    stallTimeoutMs: 30000,
    timeoutMs: 900000,
    externalTools: true,
    tempDirectory: null
  }),
  network: Object.freeze({
    address: null,
    port: null,
    portV6: null
  }),
  properties: Object.freeze({
    "server-name": "MCJS Server",
    "level-name": "world",
    gamemode: "survival",
    "force-gamemode": false,
    difficulty: "normal",
    "allow-cheats": false,
    "max-players": 10,
    "online-mode": true,
    "view-distance": 6,
    "tick-distance": 4,
    "player-idle-timeout": 30,
    "default-player-permission-level": "member",
    "texturepack-required": false,
    "content-log-file-enabled": false,
    "compression-algorithm": "snappy",
    "compression-threshold": 256
  }),
  access: Object.freeze({
    allowlist: Object.freeze([]),
    operators: Object.freeze([]),
    members: Object.freeze([]),
    visitors: Object.freeze([])
  }),
  packs: Object.freeze({
    scriptApiVersion: "2.1.0"
  }),
  commands: Object.freeze({
    namespace: "mcjs",
    admins: Object.freeze([])
  }),
  bridge: Object.freeze({
    marker: "mcjs:cmd"
  }),
  backup: Object.freeze({
    enabled: true,
    intervalMinutes: 0,
    keep: 5,
    directory: "backups",
    holdTimeoutMs: 30000,
    pollMs: 1000
  }),
  plugins: Object.freeze({
    welcome: Object.freeze({
      enabled: true,
      delayMs: 5000,
      message: "welcome to {address}"
    }),
    status: Object.freeze({
      enabled: true,
      intervalSeconds: 2,
      title: "server"
    }),
    teleport: Object.freeze({
      maxPoints: 5,
      cooldownSeconds: 10,
      randomRadius: 2000
    })
  }),
  chat: Object.freeze({
    prefix: "[ Admin]",
    prefixColor: "green",
    messageColor: "yellow"
  }),
  log: Object.freeze({
    level: "info",
    serverOutput: true
  })
});
