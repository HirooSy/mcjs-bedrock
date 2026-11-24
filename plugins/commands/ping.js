export default Object.freeze({
  name: "ping",
  admin: false,
  description: "check that the manager is responding",
  run: async ({ reply }) => {
    reply("pong");
  }
});
