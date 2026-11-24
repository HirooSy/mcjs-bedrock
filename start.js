import path from "path";
import { fileURLToPath } from "url";
import { run } from "./lib/cli.js";

run(process.argv.slice(2), { root: path.dirname(fileURLToPath(import.meta.url)) }).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error.message);
    process.exit(1);
  }
);
