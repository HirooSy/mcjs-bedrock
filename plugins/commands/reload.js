export default Object.freeze({
  name: "reload",
  admin: true,
  description: "reload the manager plugins",
  run: async ({ reply, reload }) => {
    const summary = await reload();
    const suffix = summary.restartRequired ? ", restart the server to register the changed commands" : "";
    reply(`reloaded ${summary.commands} commands and ${summary.events} events${suffix}`);
  }
});
