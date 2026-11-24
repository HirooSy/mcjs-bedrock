export default Object.freeze({
  name: "welcome",
  on: "join",
  run: async ({ player, info, options, tell, sleep }) => {
    const { enabled = true, delayMs = 5000, message = "welcome to {address}" } = options;
    if (!enabled || !player) {
      return;
    }
    await sleep(delayMs);
    tell(player, message.replace("{address}", info.address).replace("{player}", player));
  }
});
