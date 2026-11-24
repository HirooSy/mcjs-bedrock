import assert from "node:assert/strict";
import { test } from "node:test";
import { startStatus } from "../bridge/scripts/status.js";

const setup = (options, { players = 3 } = {}) => {
  const state = { tick: 0, time: 0, board: null, slot: null, interval: null, existing: false };
  const board = {
    scores: {},
    setScore: (name, value) => {
      board.scores[name] = value;
    }
  };
  const api = {
    system: {
      get currentTick() {
        return state.tick;
      },
      runInterval: (callback, ticks) => {
        state.interval = { callback, ticks };
      }
    },
    world: {
      scoreboard: {
        getObjective: () => (state.existing ? board : undefined),
        addObjective: (id, title) => {
          state.board = { id, title };
          return board;
        },
        setObjectiveAtDisplaySlot: (slot, display) => {
          state.slot = [slot, display.sortOrder];
        }
      },
      getAllPlayers: () => new Array(players).fill({})
    },
    DisplaySlotId: { Sidebar: "sidebar" },
    ObjectiveSortOrder: { Descending: "descending" }
  };
  const started = startStatus(api, options, () => state.time);
  const advance = (ticks, ms) => {
    state.tick += ticks;
    state.time += ms;
    state.interval.callback();
  };
  return { state, board, started, advance };
};

test("a healthy server reports 20 tps and 50 ms per tick on the right side sidebar", () => {
  const s = setup({});
  assert.equal(s.started, true);
  assert.equal(s.state.interval.ticks, 40);
  s.advance(40, 2000);
  assert.deepEqual(s.state.slot, ["sidebar", "descending"]);
  assert.deepEqual(s.state.board, { id: "mcjs_status", title: "server" });
  assert.deepEqual(s.board.scores, { tps: 20, "tick ms": 50, players: 3 });
});

test("a lagging server reports fewer ticks and longer ticks", () => {
  const s = setup({});
  s.advance(40, 4000);
  assert.deepEqual(s.board.scores, { tps: 10, "tick ms": 100, players: 3 });
});

test("tps never exceeds 20 even when ticks catch up", () => {
  const s = setup({});
  s.advance(40, 1000);
  assert.equal(s.board.scores.tps, 20);
});

test("the sidebar objective is created once and reused", () => {
  const s = setup({});
  s.advance(40, 2000);
  s.state.board = null;
  s.advance(40, 2000);
  assert.equal(s.state.board, null);
});

test("an existing objective is reused instead of being added again", () => {
  const s = setup({});
  s.state.existing = true;
  s.advance(40, 2000);
  assert.equal(s.state.board, null);
  assert.equal(s.board.scores.tps, 20);
});

test("a run without elapsed time writes nothing", () => {
  const s = setup({});
  s.advance(0, 0);
  assert.deepEqual(s.board.scores, {});
});

test("the interval and title follow the options", () => {
  const s = setup({ intervalSeconds: 5, title: "play" });
  assert.equal(s.state.interval.ticks, 100);
  s.advance(100, 5000);
  assert.equal(s.state.board.title, "play");
});

test("a disabled status starts nothing", () => {
  const s = setup({ enabled: false });
  assert.equal(s.started, false);
  assert.equal(s.state.interval, null);
});
