const patterns = Object.freeze({
  prefix: /^\[[^\]]*\]\s?/,
  header: /^\[([^\]]*)\]\s?/,
  level: /\b(INFO|WARN|WARNING|ERROR|DEBUG)\b/i,
  tag: /^\[[A-Za-z ]+\]\s?/,
  joined: /Player connected: (.+?), xuid: ?(\d*)/,
  left: /Player disconnected: (.+?), xuid: ?(\d*)/,
  ready: /Server started\./,
  version: /\bVersion:? (\d+(?:\.\d+){2,3})\b/
});

const levels = Object.freeze({ info: "info", warn: "warn", warning: "warn", error: "error", debug: "debug" });

const noise = Object.freeze([
  /^=+/,
  /^Server Telemetry/i,
  /^Enabling this telemetry/i,
  /^To enable this feature/i,
  /^to the server\.properties/i,
  /^Waiting for Minecraft services/i,
  /^Server started\./,
  /^Starting Server$/,
  /^(Version|Session ID|Build ID|Branch|Commit ID|Configuration)\b/,
  /^NO LOG FILE/,
  /^Running AutoCompaction/,
  /^Opening level/,
  /^IPv[46] (not )?supported/,
  /^No CDN config file found/,
  /^(Level Name|Game mode|Difficulty):/,
  /^Content logging/,
  /^Pack Stack/,
  /@ (development_)?(resource|behavior)_packs\//,
  /^Player (connected|disconnected|Spawned):?/,
  /Custom Command alias \[.*\] already in use/
]);

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const stripPrefix = (line) => line.replace(patterns.prefix, "");

export const isNoise = (text) => noise.some((pattern) => pattern.test(text));

export const readOutput = (line) => {
  const found = line.match(patterns.header);
  const word = found ? found[1].match(patterns.level)?.[1].toLowerCase() : undefined;
  const body = found ? line.slice(found[0].length) : line;
  return { level: levels[word] ?? "info", text: body.replace(patterns.tag, "").trim() };
};

const isPosition = (value) =>
  value !== null &&
  typeof value === "object" &&
  [value.x, value.y, value.z].every((axis) => Number.isFinite(axis)) &&
  typeof value.dimension === "string";

export const parseLine = (line, marker) => {
  const at = line.indexOf(marker);
  if (at !== -1) {
    const payload = parseJson(line.slice(at + marker.length));
    const valid = payload !== null && typeof payload.player === "string" && typeof payload.text === "string";
    if (!valid) {
      return { type: "invalid", line };
    }
    const chat = { type: "chat", player: payload.player, text: payload.text };
    const { x, y, z, dimension } = payload.at ?? {};
    return isPosition(payload.at) ? { ...chat, at: { x, y, z, dimension } } : chat;
  }
  const body = stripPrefix(line);
  const joined = body.match(patterns.joined);
  if (joined) {
    return { type: "join", name: joined[1], xuid: joined[2] || null };
  }
  const left = body.match(patterns.left);
  if (left) {
    return { type: "leave", name: left[1], xuid: left[2] || null };
  }
  if (patterns.ready.test(body)) {
    return { type: "ready" };
  }
  const version = body.match(patterns.version);
  if (version) {
    return { type: "version", version: version[1] };
  }
  return { type: "other", line };
};
