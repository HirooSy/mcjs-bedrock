export default Object.freeze({
  name: "info",
  admin: false,
  description: "show the server address and version",
  run: async ({ reply, info }) => {
    reply(`${info.address}:${info.port} version ${info.version}`);
  }
});
