export default Object.freeze({
  name: "cmd",
  admin: true,
  usage: "<server command>",
  description: "run a command on the server console",
  run: async ({ args, usage, send }) => {
    if (args.length === 0) {
      usage();
      return;
    }
    send(args.join(" "));
  }
});
