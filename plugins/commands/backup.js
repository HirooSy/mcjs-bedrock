export default Object.freeze({
  name: "backup",
  admin: true,
  description: "save a backup of the world",
  run: async ({ reply, backup }) => {
    reply("backup started");
    try {
      const result = await backup();
      reply(`backup ${result.name} saved, ${result.files} files`);
    } catch (error) {
      reply(`backup failed: ${error.message}`);
    }
  }
});
