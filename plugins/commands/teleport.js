const rules = Object.freeze({
  pattern: /^[a-z0-9][a-z0-9_-]{0,15}$/,
  fallback: "home",
  dimensions: Object.freeze(["overworld", "nether", "the_end"])
});

const quoted = (text) => `"${String(text).replace(/(["\\])/g, "\\$1")}"`;

const round = (value) => Math.round(value * 100) / 100;

const settingsOf = (options) => ({
  maxPoints: options.maxPoints ?? 5,
  cooldownSeconds: options.cooldownSeconds ?? 10,
  randomRadius: options.randomRadius ?? 2000
});

const createTeleport = () => {
  const lastUse = new Map();

  const prepare = (ctx, name) => {
    if (ctx.origin === "console") {
      ctx.reply("this command can only be used in game");
      return null;
    }
    if (name !== null && !rules.pattern.test(name)) {
      ctx.reply("a name uses 1 to 16 letters, digits, - or _");
      return null;
    }
    return { owner: ctx.xuid ?? String(ctx.player).toLowerCase(), settings: settingsOf(ctx.options) };
  };

  const remaining = (ready) => {
    const until = (lastUse.get(ready.owner) ?? 0) + ready.settings.cooldownSeconds * 1000;
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  };

  const missing = (ctx, points, name) => {
    const names = Object.keys(points).sort();
    return names.length > 0
      ? `no tp point named ${name}, yours: ${names.join(", ")}`
      : `no tp points yet, save one with ${ctx.qualify("settp")} [name]`;
  };

  const nameOf = (ctx) => (ctx.args[0] ?? rules.fallback).toLowerCase();

  return [
    {
      name: "settp",
      section: "teleport",
      admin: false,
      usage: "[name]",
      description: "save your position as a tp point",
      run: async (ctx) => {
        const name = nameOf(ctx);
        const ready = prepare(ctx, name);
        if (!ready) {
          return;
        }
        if (!ctx.at) {
          ctx.reply("your position is unavailable, restart the server to refresh the bridge pack");
          return;
        }
        const store = ctx.storage();
        const data = store.read();
        const points = data[ready.owner] ?? {};
        if (!Object.hasOwn(points, name) && Object.keys(points).length >= ready.settings.maxPoints) {
          ctx.reply(`limit of ${ready.settings.maxPoints} tp points reached, remove one with ${ctx.qualify("deltp")} <name>`);
          return;
        }
        points[name] = { x: round(ctx.at.x), y: round(ctx.at.y), z: round(ctx.at.z), dimension: ctx.at.dimension };
        store.write({ ...data, [ready.owner]: points });
        ctx.reply(`tp point ${name} saved`);
      }
    },
    {
      name: "tp",
      section: "teleport",
      admin: false,
      aliases: ["warp"],
      usage: "[name]",
      description: "teleport to one of your tp points",
      run: async (ctx) => {
        const name = nameOf(ctx);
        const ready = prepare(ctx, name);
        if (!ready) {
          return;
        }
        const points = ctx.storage().read()[ready.owner] ?? {};
        const point = Object.hasOwn(points, name) ? points[name] : null;
        if (!point || !rules.dimensions.includes(point.dimension)) {
          ctx.reply(missing(ctx, points, name));
          return;
        }
        const wait = remaining(ready);
        if (wait > 0) {
          ctx.reply(`wait ${wait}s before teleporting again`);
          return;
        }
        ctx.send(`execute in ${point.dimension} run tp ${quoted(ctx.player)} ${point.x} ${point.y} ${point.z}`);
        lastUse.set(ready.owner, Date.now());
        ctx.reply(`teleporting to ${name}`);
      }
    },
    {
      name: "deltp",
      section: "teleport",
      admin: false,
      usage: "[name]",
      description: "delete one of your tp points",
      run: async (ctx) => {
        const name = nameOf(ctx);
        const ready = prepare(ctx, name);
        if (!ready) {
          return;
        }
        const store = ctx.storage();
        const data = store.read();
        const points = data[ready.owner] ?? {};
        if (!Object.hasOwn(points, name)) {
          ctx.reply(missing(ctx, points, name));
          return;
        }
        const { [name]: removed, ...rest } = points;
        store.write({ ...data, [ready.owner]: rest });
        ctx.reply(`tp point ${name} deleted`);
      }
    },
    {
      name: "rtp",
      section: "teleport",
      admin: false,
      description: "teleport to a random spot in the overworld",
      run: async (ctx) => {
        const ready = prepare(ctx, null);
        if (!ready) {
          return;
        }
        if (ctx.at && ctx.at.dimension !== "overworld") {
          ctx.reply("random teleport only works in the overworld");
          return;
        }
        const wait = remaining(ready);
        if (wait > 0) {
          ctx.reply(`wait ${wait}s before teleporting again`);
          return;
        }
        ctx.send(`execute in overworld run spreadplayers 0 0 1 ${ready.settings.randomRadius} ${quoted(ctx.player)}`);
        lastUse.set(ready.owner, Date.now());
        ctx.reply("looking for a random spot");
      }
    }
  ];
};

export default createTeleport();
