#!/usr/bin/env node
import { mkdir, copyFile, symlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const targetDir = join(homedir(), ".pi", "agent", "extensions");
const target = join(targetDir, "pi-omniroute-bridge.js");
const built = join(root, "dist", "index.js");
const sourceTs = join(root, "src", "index.ts");

const cmd = process.argv[2] ?? "help";

async function install() {
  await mkdir(targetDir, { recursive: true });
  if (existsSync(built)) {
    await copyFile(built, target);
    console.log(`Installed built extension to ${target}`);
  } else {
    const tsTarget = target.replace(/\.js$/, ".ts");
    await rm(tsTarget, { force: true });
    await symlink(sourceTs, tsTarget);
    console.log(`Build not found; linked TypeScript extension to ${tsTarget}`);
  }
  console.log("In pi, run /reload, then /omniroute-onboard.");
}

async function uninstall() {
  await rm(target, { force: true });
  await rm(target.replace(/\.js$/, ".ts"), { force: true });
  console.log("Removed pi-omniroute-bridge extension from ~/.pi/agent/extensions.");
}

switch (cmd) {
  case "install":
    await install();
    break;
  case "uninstall":
    await uninstall();
    break;
  default:
    console.log(`Usage: pi-omniroute-bridge <install|uninstall>\n\nCommands:\n  install    Copy/link extension into ~/.pi/agent/extensions\n  uninstall  Remove installed extension`);
}
