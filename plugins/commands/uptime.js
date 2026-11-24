const format = (milliseconds) => {
  const total = Math.floor(milliseconds / 1000);
  const parts = [
    [Math.floor(total / 86400), "d"],
    [Math.floor((total % 86400) / 3600), "h"],
    [Math.floor((total % 3600) / 60), "m"],
    [total % 60, "s"]
  ];
  const visible = parts.filter(([value], index) => value > 0 || index === parts.length - 1);
  return visible.map(([value, unit]) => `${value}${unit}`).join(" ");
};

export default Object.freeze({
  name: "uptime",
  admin: false,
  description: "show how long the server has been running",
  run: async ({ reply, uptime }) => {
    reply(`server uptime ${format(uptime())}`);
  }
});
