export const levelRanks = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

export const createLogger = (level, output = console) => {
  const threshold = levelRanks[level] ?? levelRanks.info;
  const write = (name, method) => (message) => {
    if (levelRanks[name] <= threshold) {
      output[method](`[ ${name} ] ${message}`);
    }
  };
  return Object.freeze({
    error: write("error", "error"),
    warn: write("warn", "warn"),
    info: write("info", "log"),
    debug: write("debug", "log")
  });
};
