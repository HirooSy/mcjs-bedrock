export const colors = Object.freeze({
  black: "0",
  dark_blue: "1",
  dark_green: "2",
  dark_aqua: "3",
  dark_red: "4",
  dark_purple: "5",
  gold: "6",
  gray: "7",
  dark_gray: "8",
  blue: "9",
  green: "a",
  aqua: "b",
  red: "c",
  light_purple: "d",
  yellow: "e",
  white: "f"
});

export const formatChat = ({ prefix, prefixColor, messageColor }, message) =>
  `\u00a7${colors[prefixColor]}${prefix}\u00a7r \u00a7${colors[messageColor]}${message}`;
