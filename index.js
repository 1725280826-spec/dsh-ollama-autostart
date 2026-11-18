/**
 * @local/dsh-ollama-autostart — Host half.
 *
 * Boots `ollama serve` as a detached background service when the DSH Host
 * starts (plugin activation). Idempotent:
 *   1) port already listening  -> ollama is up, skip;
 *   2) pidfile process alive   -> a previous start is still booting, skip;
 *   3) otherwise spawn detached (survives DSH exit), record pidfile, and
 *      poll the port in the background without blocking DSH boot.
 *
 * Row config (all optional):
 *   { command: "ollama", args: ["serve"], host: "127.0.0.1", port: 11434 }
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const PIDFILE = "/tmp/dsh-ollama-autostart.pid";

/** Resolve true when something accepts a TCP connection on host:port. */
function portOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(value);
    };
    const sock = net.connect({ host, port });
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs).unref?.();
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err !== null && err.code === "EPERM";
  }
}

export function apply(ctx, config) {
  const cfg = config && typeof config === "object" ? config : {};
  const host = String(cfg.host ?? "127.0.0.1");
  const port = Number(cfg.port) > 0 ? Number(cfg.port) : 11434;
  const command = String(cfg.command ?? "ollama");
  const args = Array.isArray(cfg.args) && cfg.args.length > 0 ? cfg.args.map(String) : ["serve"];

  const info = (msg) => {
    try {
      if (typeof ctx?.logger?.info === "function") ctx.logger.info(`ollama-autostart: ${msg}`);
      else console.info?.(`[dsh-ollama-autostart] ${msg}`);
    } catch { /* logging must never break activation */ }
  };
  const warn = (msg) => {
    try {
      if (typeof ctx?.logger?.warn === "function") ctx.logger.warn(`ollama-autostart: ${msg}`);
      else console.warn?.(`[dsh-ollama-autostart] ${msg}`);
    } catch { /* ignore */ }
  };

  (async () => {
    try {
      if (await portOpen(host, port)) {
        info(`ollama already listening on ${host}:${port} — skipped`);
        return;
      }

      let stale = null;
      if (existsSync(PIDFILE)) {
        stale = Number(readFileSync(PIDFILE, "utf8").trim());
        if (Number.isInteger(stale) && stale > 0 && pidAlive(stale)) {
          info(`previous autostart pid ${stale} is still alive (likely still booting) — skipped`);
          return;
        }
        rmSync(PIDFILE, { force: true });
      }

      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => {
        warn(`spawn of "${command} ${args.join(" ")}" failed: ${err?.message ?? String(err)}`);
        rmSync(PIDFILE, { force: true });
      });
      child.unref();

      try {
        writeFileSync(PIDFILE, String(child.pid));
      } catch { /* pidfile is best-effort dedupe only */ }

      info(`spawned "${command} ${args.join(" ")}" as detached pid ${child.pid}; waiting for ${host}:${port}…`);

      const deadline = Date.now() + 30_000;
      const tick = async () => {
        if (await portOpen(host, port)) {
          info(`ollama ready on ${host}:${port}`);
          return;
        }
        if (Date.now() > deadline) {
          warn(`ollama not ready on ${host}:${port} within 30s — start it manually if needed`);
          return;
        }
        setTimeout(tick, 1000).unref?.();
      };
      await tick();
    } catch (err) {
      warn(`autostart failed: ${err?.message ?? String(err)}`);
    }
  })();

  return () => {
    /* The service is detached and intentionally outlives DSH; nothing to clean up. */
  };
}
