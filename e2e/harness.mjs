// Shared by the end-to-end tests: child processes with captured output, polling, ports.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const children = [];

export function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  child.output = "";
  child.stdout.on("data", (d) => (child.output += d));
  child.stderr.on("data", (d) => (child.output += d));
  children.push(child);
  return child;
}

export async function until(what, check, ms = 30_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

export const port = () => 41000 + Math.floor(Math.random() * 9000);

export async function stopAll() {
  for (const child of children.splice(0).reverse()) child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
}
