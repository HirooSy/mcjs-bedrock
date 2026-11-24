export default Object.freeze({
  name: "players",
  admin: false,
  aliases: ["online"],
  description: "list the players who are online",
  run: async ({ reply, players }) => {
    reply(players.length > 0 ? `online ${players.length}: ${players.join(", ")}` : "no players online");
  }
});
