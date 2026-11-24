export default Object.freeze({
  name: "help",
  admin: false,
  description: "list the commands you can use",
  run: async ({ reply, commands, qualify, admin }) => {
    const lines = commands
      .filter((command) => !command.alias && (admin || !command.admin))
      .map((command) => `${qualify(command.name)} - ${command.description}`);
    reply(lines.join("\n"));
  }
});
