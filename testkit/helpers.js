export const posixOnly = () => ({ skip: process.platform === "win32" });

export const nativeOnly = () => ({ skip: !["linux", "win32"].includes(process.platform) });

export const logStamp = () => "[2026-11-04 08:49:08:469 INFO]";
