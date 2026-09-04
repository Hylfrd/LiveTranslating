import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const node = process.execPath;
const developmentUrl = "http://127.0.0.1:5178";
const children = new Set();

await run(node, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"]);
await run(node, [path.join(root, "scripts", "build-preload.mjs")]);

const vite = start(node, [path.join(root, "node_modules", "vite", "bin", "vite.js")]);
await waitForServer(developmentUrl, 20_000);
const electron = start(
  node,
  [path.join(root, "node_modules", "electron", "cli.js"), "."],
  { VITE_DEV_SERVER_URL: developmentUrl },
);

const exitCode = await new Promise((resolve) => {
  electron.once("exit", (code) => resolve(code ?? 0));
});
shutdown();
process.exitCode = exitCode;

function start(command, args, extraEnvironment = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
    windowsHide: false,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = start(command, args);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args[0] ?? command)} exited with code ${code}`));
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  shutdown();
  throw new Error(`Vite did not become ready at ${url}`);
}

function shutdown() {
  for (const child of children) {
    child.kill();
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdown();
    process.exit(0);
  });
}
