export default Object.freeze({
  name: "broadcast",
  admin: true,
  usage: "<message>",
  description: "send a message to every player",
  run: async ({ player, args, usage, broadcast }) => {
    if (args.length === 0) {
      usage();
      return;
    }
    broadcast(`[${player}] ${args.join(" ")}`);
  }
});
