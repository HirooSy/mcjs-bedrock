import {
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  DisplaySlotId,
  ObjectiveSortOrder,
  system,
  world
} from "@minecraft/server";
import settings from "./settings.js";
import { startStatus } from "./status.js";

startStatus({ world, system, DisplaySlotId, ObjectiveSortOrder }, settings.status ?? {});

const round = (value) => Math.round(value * 100) / 100;

const locate = (entity) => {
  const { location, dimension } = entity;
  if (!location || !dimension) {
    return undefined;
  }
  return {
    x: round(location.x),
    y: round(location.y),
    z: round(location.z),
    dimension: String(dimension.id).replace("minecraft:", "")
  };
};

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  const slots = Array.from({ length: 8 }, (_, index) => ({
    type: CustomCommandParamType.String,
    name: `arg${index + 1}`
  }));
  for (const command of settings.commands) {
    customCommandRegistry.registerCommand(
      {
        name: `${settings.namespace}:${command.name}`,
        description: command.description,
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        optionalParameters: slots
      },
      (origin, ...words) => {
        const sender = origin.sourceEntity;
        if (!sender || sender.typeId !== "minecraft:player") {
          return { status: CustomCommandStatus.Failure, message: "players only" };
        }
        const text = [command.name, ...words.filter((word) => typeof word === "string" && word.length > 0)].join(" ");
        console.log(`${settings.marker}${JSON.stringify({ player: sender.name, text, at: locate(sender) })}`);
        return { status: CustomCommandStatus.Success };
      }
    );
  }
});
