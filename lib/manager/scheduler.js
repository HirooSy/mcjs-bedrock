export const createScheduler = ({ logger, timers = { setInterval, clearInterval } }) => {
  const handles = new Map();
  const running = new Set();

  const every = (name, intervalMs, task) => {
    cancel(name);
    const handle = timers.setInterval(async () => {
      if (running.has(name)) {
        return;
      }
      running.add(name);
      try {
        await task();
      } catch (error) {
        logger.error(`scheduled task ${name} failed: ${error.message}`);
      } finally {
        running.delete(name);
      }
    }, intervalMs);
    if (typeof handle.unref === "function") {
      handle.unref();
    }
    handles.set(name, handle);
  };

  const cancel = (name) => {
    if (handles.has(name)) {
      timers.clearInterval(handles.get(name));
      handles.delete(name);
    }
  };

  const stop = () => {
    for (const name of [...handles.keys()]) {
      cancel(name);
    }
  };

  const names = () => [...handles.keys()];

  return Object.freeze({ every, cancel, stop, names });
};
