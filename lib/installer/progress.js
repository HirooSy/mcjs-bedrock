export const formatBytes = (bytes) => {
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
};

export const createProgress = ({ log, label, intervalMs = 2000, clock = Date.now }) => {
  const started = clock();
  let last = -Infinity;
  return Object.freeze({
    update: (received, total) => {
      const now = clock();
      if (now - last < intervalMs) {
        return;
      }
      last = now;
      const seconds = Math.max(0.001, (now - started) / 1000);
      const rate = `${formatBytes(received / seconds)}/s`;
      if (total > 0) {
        log(`${label}: ${formatBytes(received)} of ${formatBytes(total)} (${Math.floor((received / total) * 100)}%) at ${rate}`);
      } else {
        log(`${label}: ${formatBytes(received)} at ${rate}`);
      }
    },
    finish: (received) => {
      const seconds = Math.max(0.001, (clock() - started) / 1000);
      log(`${label}: finished ${formatBytes(received)} in ${seconds.toFixed(1)}s`);
    }
  });
};
