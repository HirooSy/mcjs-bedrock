export const memoryLogger = () => {
  const lines = [];
  const push = (level) => (message) => {
    lines.push({ level, message: String(message) });
  };
  const logger = Object.freeze({
    error: push("error"),
    warn: push("warn"),
    info: push("info"),
    debug: push("debug")
  });
  const has = (level, fragment) => lines.some((line) => line.level === level && line.message.includes(fragment));
  return { logger, lines, has };
};
