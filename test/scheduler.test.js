import assert from "node:assert/strict";
import { test } from "node:test";
import { createScheduler } from "../lib/manager/scheduler.js";
import { memoryLogger } from "../testkit/logger.js";

const fakeTimers = () => {
  const active = new Map();
  let next = 1;
  return {
    active,
    timers: {
      setInterval: (callback, ms) => {
        const handle = { id: next, ms, callback, unref: () => {} };
        active.set(next, handle);
        next += 1;
        return handle;
      },
      clearInterval: (handle) => active.delete(handle.id)
    },
    tick: async (name) => {
      for (const handle of [...active.values()]) {
        if (handle.name === name || name === undefined) {
          await handle.callback();
        }
      }
    }
  };
};

test("a task is scheduled at its interval and runs on each tick", async () => {
  const { logger } = memoryLogger();
  const fake = fakeTimers();
  const scheduler = createScheduler({ logger, timers: fake.timers });
  let runs = 0;
  scheduler.every("job", 60000, async () => {
    runs += 1;
  });
  assert.deepEqual(scheduler.names(), ["job"]);
  assert.equal([...fake.active.values()][0].ms, 60000);
  await fake.tick();
  await fake.tick();
  assert.equal(runs, 2);
});

test("a failing task is logged and keeps its schedule", async () => {
  const { logger, has } = memoryLogger();
  const fake = fakeTimers();
  const scheduler = createScheduler({ logger, timers: fake.timers });
  let runs = 0;
  scheduler.every("flaky", 1000, async () => {
    runs += 1;
    throw new Error("bad run");
  });
  await fake.tick();
  await fake.tick();
  assert.equal(runs, 2);
  assert.ok(has("error", "scheduled task flaky failed: bad run"));
});

test("a task that is still running is not started twice", async () => {
  const { logger } = memoryLogger();
  const fake = fakeTimers();
  const scheduler = createScheduler({ logger, timers: fake.timers });
  let runs = 0;
  let release;
  scheduler.every("slow", 1000, () => {
    runs += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const first = fake.tick();
  await fake.tick();
  assert.equal(runs, 1);
  release();
  await first;
  const third = fake.tick();
  assert.equal(runs, 2);
  release();
  await third;
});

test("scheduling the same name replaces the previous timer", () => {
  const { logger } = memoryLogger();
  const fake = fakeTimers();
  const scheduler = createScheduler({ logger, timers: fake.timers });
  scheduler.every("job", 1000, async () => {});
  scheduler.every("job", 2000, async () => {});
  assert.equal(fake.active.size, 1);
  assert.equal([...fake.active.values()][0].ms, 2000);
});

test("cancel and stop clear timers", () => {
  const { logger } = memoryLogger();
  const fake = fakeTimers();
  const scheduler = createScheduler({ logger, timers: fake.timers });
  scheduler.every("a", 1000, async () => {});
  scheduler.every("b", 1000, async () => {});
  scheduler.cancel("a");
  assert.deepEqual(scheduler.names(), ["b"]);
  scheduler.cancel("missing");
  scheduler.stop();
  assert.deepEqual(scheduler.names(), []);
  assert.equal(fake.active.size, 0);
});

test("real timers are unref'd so they never keep the process alive", () => {
  const { logger } = memoryLogger();
  let captured = null;
  const scheduler = createScheduler({
    logger,
    timers: {
      setInterval: (callback, ms) => {
        captured = setInterval(callback, ms);
        return captured;
      },
      clearInterval
    }
  });
  scheduler.every("real", 3600000, async () => {});
  assert.equal(captured.hasRef(), false);
  scheduler.stop();
});
