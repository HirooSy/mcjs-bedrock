export const startStatus = ({ world, system, DisplaySlotId, ObjectiveSortOrder }, options = {}, clock = Date.now) => {
  const { enabled = true, intervalSeconds = 2, title = "server", objective = "mcjs_status" } = options;
  if (!enabled) {
    return false;
  }
  let lastTick = system.currentTick;
  let lastTime = clock();
  let board = null;
  system.runInterval(() => {
    const now = clock();
    const tick = system.currentTick;
    const ticks = tick - lastTick;
    const elapsed = now - lastTime;
    lastTick = tick;
    lastTime = now;
    if (ticks <= 0 || elapsed <= 0) {
      return;
    }
    if (board === null) {
      board = world.scoreboard.getObjective(objective) ?? world.scoreboard.addObjective(objective, title);
      world.scoreboard.setObjectiveAtDisplaySlot(DisplaySlotId.Sidebar, {
        objective: board,
        sortOrder: ObjectiveSortOrder.Descending
      });
    }
    board.setScore("tps", Math.min(20, Math.round((ticks * 1000) / elapsed)));
    board.setScore("tick ms", Math.round(elapsed / ticks));
    board.setScore("players", world.getAllPlayers().length);
  }, Math.max(1, Math.round(intervalSeconds * 20)));
  return true;
};
