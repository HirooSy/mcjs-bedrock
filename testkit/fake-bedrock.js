import fs from "fs";
import path from "path";
import readline from "readline";

const walk = (directory) => {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
};

const main = () => {
  const options = new Map(
    process.argv
      .slice(2)
      .map((arg) => arg.replace(/^--/, "").split("="))
      .map(([key, value = "true"]) => [key, value])
  );
  const level = options.get("level") ?? "world";
  const readyAfterQueries = Number(options.get("query-delay") ?? 0);
  const shrink = Number(options.get("shrink") ?? 0);
  const state = { holding: false, queries: 0 };

  const say = (text) => {
    const stamp = new Date().toISOString().replace("T", " ").replace("Z", "").replace(".", ":");
    process.stdout.write(`[${stamp} INFO] ${text}\n`);
  };

  const received = (line) => {
    fs.appendFileSync("received.log", `${line}\n`);
  };

  const listing = () => {
    const base = path.resolve("worlds");
    const ghosts = options.has("ghost") ? [`${level}/db/ghost.ldb:10`] : [];
    return [...walk(path.join(base, level))
      .map((file) => {
        const size = fs.statSync(file).size;
        const reported = shrink > 0 && size > shrink ? size - shrink : size;
        return `${path.relative(base, file).split(path.sep).join("/")}:${reported}`;
      }), ...ghosts]
      .join(", ");
  };

  say("Starting Server");
  say("Version 1.26.61.1");
  if (!options.has("never-ready")) {
    say("Server started.");
  }

  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    received(line);
    if (line === "stop") {
      if (options.has("ignore-stop")) {
        return;
      }
      say("Quit correctly");
      process.exit(0);
    }
    if (line.startsWith("__emit ")) {
      process.stdout.write(`${line.slice(7)}\n`);
      return;
    }
    if (line === "__crash") {
      process.exit(1);
    }
    if (line === "save hold") {
      state.holding = true;
      state.queries = 0;
      say("Saving...");
      return;
    }
    if (line === "save query") {
      if (!state.holding || options.has("no-save")) {
        return;
      }
      state.queries += 1;
      if (state.queries <= readyAfterQueries) {
        say("A previous save has not been completed.");
        return;
      }
      say("Data saved. Files are now ready to be copied.");
      say(listing());
      return;
    }
    if (line === "save resume") {
      state.holding = false;
      say("Changes to the world are resumed.");
      return;
    }
    say(`Unknown command: ${line}`);
  });
};

main();
