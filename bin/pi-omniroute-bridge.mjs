#!/usr/bin/env node
import { mkdir, copyFile, symlink, rm, readFile, realpath } from "node:fs/promises";
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
const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
const settingsDir = dirname(settingsPath);

const cmd = process.argv[2] ?? "help";
const force = process.argv.includes("--force");

async function canonical(file) {
  try {
    return await realpath(file);
  } catch {
    return resolve(file);
  }
}

async function isLoadedAsPackage() {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    const rootPath = await canonical(root);
    for (const spec of packages) {
      if (typeof spec !== "string" || spec.startsWith("npm:")) continue;
      const candidate = spec.startsWith("/") ? spec : resolve(settingsDir, spec);
      if ((await canonical(candidate)) === rootPath) return true;
    }
  } catch {
    // Missing/unreadable settings should not block normal install.
  }
  return false;
}

async function install() {
  await mkdir(targetDir, { recursive: true });
  if (!force && await isLoadedAsPackage()) {
    await rm(target, { force: true });
    await rm(target.replace(/\.js$/, ".ts"), { force: true });
    console.log(`Skipped install: ${root} is already listed in ~/.pi/agent/settings.json packages.`);
    console.log("Removed any stale pi-omniroute-bridge copy from ~/.pi/agent/extensions to avoid duplicate tool registration.");
    console.log("Use --force if you intentionally want a separate extensions-dir copy.");
    return;
  }
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
    console.log(`Usage: pi-omniroute-bridge <install|uninstall> [--force]\n\nCommands:\n  install    Copy/link extension into ~/.pi/agent/extensions unless already loaded as a package\n  uninstall  Remove installed extension\n\nOptions:\n  --force    Install even when this project is already listed in ~/.pi/agent/settings.json packages`);
}
