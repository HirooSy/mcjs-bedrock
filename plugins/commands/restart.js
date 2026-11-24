export default Object.freeze({
  name: "restart",
  admin: true,
  description: "restart the server",
  run: async ({ reply, restart }) => {
    reply("restarting the server");
    await restart();
  }
});
