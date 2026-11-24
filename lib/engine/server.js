import { spawn } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import readline from "readline";
import { parseLine } from "./parser.js";

const parseControl = (text) => text.replace(/[\r\n]+/g, " ");

const quote = (text) => `"${String(text).replace(/(["\\])/g, "\\$1")}"`;

const rawtext = (text) => JSON.stringify({ rawtext: [{ text: String(text) }] });

export class BedrockServer extends EventEmitter {
  constructor({
    binaryPath,
    args = [],
    runDir,
    marker,
    autoRestart,
    restartDelayMs,
    stopTimeoutMs,
    maxRestarts,
    restartWindowMs,
    memoryArenas = 0,
    logger
  }) {
    super();
    this.binaryPath = binaryPath;
    this.args = args;
    this.runDir = runDir;
    this.marker = marker;
    this.autoRestart = autoRestart;
    this.restartDelayMs = restartDelayMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.maxRestarts = maxRestarts;
    this.restartWindowMs = restartWindowMs;
    this.memoryArenas = memoryArenas;
    this.logger = logger;
    this.players = new Map();
    this.child = null;
    this.intent = null;
    this.halted = false;
    this.ready = false;
    this.readyCount = 0;
    this.version = null;
    this.startedAt = 0;
    this.crashes = [];
    this.restartTimer = null;
    this.stopPromise = null;
  }

  start() {
    if (this.child) {
      throw new Error("server is already running");
    }
    this.halted = false;
    this.ready = false;
    this.stopPromise = null;
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: [this.runDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter)
    };
    if (this.memoryArenas > 0 && env.MALLOC_ARENA_MAX === undefined) {
      env.MALLOC_ARENA_MAX = String(this.memoryArenas);
    }
    const child = spawn(this.binaryPath, this.args, {
      cwd: this.runDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    this.startedAt = Date.now();
    child.stdin.on("error", () => {});
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.handle(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => this.logger.warn(line));
    child.on("error", (error) => {
      if (this.child === child) {
        this.child = null;
        this.emit("fatal", error);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.handleExit(code, signal);
      }
    });
  }

  handle(line) {
    this.emit("line", line);
    const event = parseLine(line, this.marker);
    switch (event.type) {
      case "chat":
        this.emit("chat", event.at ? { player: event.player, text: event.text, at: event.at } : { player: event.player, text: event.text });
        return;
      case "join":
        this.players.set(event.name, event.xuid);
        this.emit("join", { name: event.name, xuid: event.xuid });
        return;
      case "leave":
        this.players.delete(event.name);
        this.emit("leave", { name: event.name, xuid: event.xuid });
        return;
      case "ready":
        this.ready = true;
        this.readyCount += 1;
        this.emit("ready");
        return;
      case "version":
        this.version = event.version;
        return;
      case "invalid":
        this.logger.warn(`ignored malformed bridge message: ${line}`);
        return;
    }
  }

  isRunning() {
    return this.child !== null;
  }

  isReady() {
    return this.child !== null && this.ready;
  }

  playerNames() {
    return [...this.players.keys()];
  }

  xuidOf(name) {
    return this.players.get(name) ?? null;
  }

  uptime() {
    return this.child ? Date.now() - this.startedAt : 0;
  }

  write(line) {
    if (this.child && this.child.stdin.writable) {
      this.child.stdin.write(`${parseControl(String(line))}\n`);
      return true;
    }
    return false;
  }

  send(command) {
    if (command.trim().toLowerCase() === "stop") {
      this.stop();
      return;
    }
    this.write(command);
  }

  tell(player, text) {
    this.write(`tellraw ${quote(player)} ${rawtext(text)}`);
  }

  broadcast(text) {
    return this.write(`tellraw @a ${rawtext(text)}`);
  }

  collect({ start, timeoutMs, settleMs = 250 }) {
    return new Promise((resolve, reject) => {
      const lines = [];
      let begun = false;
      let settle = null;
      const finish = (error) => {
        clearTimeout(timeout);
        clearTimeout(settle);
        this.off("line", onLine);
        if (error) {
          reject(error);
        } else {
          resolve(lines);
        }
      };
      const timeout = setTimeout(() => {
        const error = new Error("timed out waiting for server output");
        error.code = "COLLECT_TIMEOUT";
        finish(error);
      }, timeoutMs);
      const onLine = (line) => {
        if (!begun) {
          if (!start(line)) {
            return;
          }
          begun = true;
          clearTimeout(timeout);
        }
        lines.push(line);
        clearTimeout(settle);
        settle = setTimeout(() => finish(), settleMs);
      };
      this.on("line", onLine);
    });
  }

  terminate(intent) {
    this.intent = intent;
    const child = this.child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.logger.warn("server did not stop in time, killing it");
        child.kill();
      }, this.stopTimeoutMs);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      this.write("stop");
    });
  }

  stop() {
    this.halted = true;
    clearTimeout(this.restartTimer);
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (!this.child) {
      this.emit("stopped", 0);
      return Promise.resolve(0);
    }
    this.stopPromise = this.terminate("stop");
    return this.stopPromise;
  }

  async restart() {
    if (!this.child) {
      this.start();
      return;
    }
    await this.terminate("restart");
  }

  kill() {
    this.halted = true;
    clearTimeout(this.restartTimer);
    if (this.child) {
      this.child.kill("SIGKILL");
    }
  }

  handleExit(code, signal) {
    this.child = null;
    this.ready = false;
    this.players.clear();
    const intent = this.intent;
    this.intent = null;
    this.emit("exit", { code, signal, intent });
    if (intent === "restart") {
      this.start();
      return;
    }
    if (intent === "stop" || this.halted || !this.autoRestart) {
      this.emit("stopped", code);
      return;
    }
    this.scheduleRestart(code);
  }

  scheduleRestart(code) {
    const now = Date.now();
    this.crashes = this.crashes.filter((at) => now - at < this.restartWindowMs);
    this.crashes.push(now);
    if (this.maxRestarts > 0 && this.crashes.length > this.maxRestarts) {
      const error = new Error(
        `server exited ${this.crashes.length} times within ${this.restartWindowMs}ms, giving up${
          this.readyCount === 0 ? " (it never became ready)" : ""
        }`
      );
      error.code = "CRASH_LOOP";
      error.neverReady = this.readyCount === 0;
      this.emit("fatal", error);
      return;
    }
    this.logger.warn(`server exited with code ${code}, restarting in ${this.restartDelayMs}ms`);
    this.emit("restarting", { code, attempt: this.crashes.length });
    this.restartTimer = setTimeout(() => {
      if (!this.halted) {
        this.start();
      }
    }, this.restartDelayMs);
  }
}
