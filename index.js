/**
 * dsh-ollama-autostart — Host half.
 *
 * Boots `ollama serve` as a detached background service when the DSH Host
 * starts, and exposes a settings-page API for the plugin's control panel:
 *
 *   GET  /api/ollama-autostart/           live status (listening / pid / version)
 *   POST /api/ollama-autostart/start     manual start (idempotent)
 *   POST /api/ollama-autostart/health    /api/tags probe -> enabled / not
 *   POST /api/ollama-autostart/embed-test /api/embed direct test (bypasses DSH)
 *   POST /api/ollama-autostart/version   `ollama --version`
 *   POST /api/ollama-autostart/ipv4-cli  `MNEMON_EMBED_ENDPOINT=http://127.0.0.1:<port> mnemon embed --status`
 *
 * Idempotent start:
 *   1) port already listening  -> skip;
 *   2) pidfile process alive   -> previous start still booting, skip;
 *   3) otherwise spawn detached (survives DSH exit), record pidfile, poll
 *      the port in the background without blocking DSH boot.
 *
 * On activation the host also runs the version check once (requirement 4).
 *
 * Row config (all optional):
 *   { command: "ollama", args: ["serve"], host: "127.0.0.1", port: 11434,
 *     embedModel: "nomic-embed-text" }
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const PIDFILE = "/tmp/dsh-ollama-autostart.pid";
const EMBED_TEST_TEXT = "测试文本";
const API_PREFIX = "/api/ollama-autostart";

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one command to completion (no PTY): returns { ok, code, output } with
 * a bounded tail, or { ok: false, error } when the executable is missing.
 */
function runCommand(command, args, { timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let errText = "";
    let done = false;
    let child;
    try {
      child = spawn(command, args, { env: env === undefined ? process.env : env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, error: String(err?.message ?? err) });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ ok: false, timedOut: true, output: (out + errText).slice(-2000) });
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errText += d; });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(err?.message ?? err) });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code, output: (out + errText).slice(-2000) });
    });
  });
}

export function apply(ctx, config) {
  const cfg = config && typeof config === "object" ? config : {};
  const host = String(cfg.host ?? "127.0.0.1");
  const port = Number(cfg.port) > 0 ? Number(cfg.port) : 11434;
  const command = String(cfg.command ?? "ollama");
  const args = Array.isArray(cfg.args) && cfg.args.length > 0 ? cfg.args.map(String) : ["serve"];
  const embedModel = String(cfg.embedModel ?? "nomic-embed-text");

  /** Live facts the settings panel reads. */
  const state = {
    running: false,
    startedByUs: false,
    startedPid: null,
    version: null,
    versionChecked: false,
  };

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

  /** Requirement 4: one `ollama --version` on host boot (and on demand). */
  const checkVersion = async () => {
    const r = await runCommand("ollama", ["--version"]);
    state.versionChecked = true;
    if (r.ok) {
      const firstLine = (r.output.trim().split("\n").find((line) => line.trim()) || "").trim();
      state.version = firstLine || r.output.trim().slice(0, 120);
      info(`detected Ollama version: ${state.version}`);
      return { ok: true, version: state.version };
    }
    warn(`version check failed: ${r.error ?? r.output?.slice(0, 200) ?? "unknown"}`);
    return { ok: false, error: r.error ?? "non-zero exit" };
  };

  /** Idempotent `ollama serve` start (port -> pidfile -> spawn, then poll). */
  const ensureRunning = async () => {
    if (await portOpen(host, port)) {
      state.running = true;
      return { running: true, started: false, reason: "already-listening", host, port };
    }

    if (existsSync(PIDFILE)) {
      const pid = Number(readFileSync(PIDFILE, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        state.running = true;
        return { running: true, started: false, reason: "booting", pid };
      }
      rmSync(PIDFILE, { force: true });
    }

    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", (err) => {
      warn(`spawn of "${command} ${args.join(" ")}" failed: ${err?.message ?? String(err)}`);
      rmSync(PIDFILE, { force: true });
    });
    child.unref();
    try {
      writeFileSync(PIDFILE, String(child.pid));
    } catch { /* pidfile is best-effort dedupe only */ }
    state.startedByUs = true;
    state.startedPid = child.pid;

    info(`spawned "${command} ${args.join(" ")}" as detached pid ${child.pid}; waiting for ${host}:${port}…`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await portOpen(host, port)) {
        state.running = true;
        info(`ollama ready on ${host}:${port}`);
        return { running: true, started: true, pid: child.pid };
      }
      await sleep(1000);
    }
    warn(`ollama not ready on ${host}:${port} within 30s — start it manually if needed`);
    return { running: false, started: true, pid: child.pid, reason: "not-ready-within-30s" };
  };

  /** Requirement 2: probe /api/tags — the "is the service actually serving" check. */
  const health = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`http://${host}:${port}/api/tags`, { signal: controller.signal });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        return {
          enabled: true,
          host,
          port,
          modelCount: Array.isArray(body.models) ? body.models.length : null,
        };
      }
      return { enabled: false, host, port, error: `HTTP ${res.status}` };
    } catch (err) {
      return { enabled: false, host, port, error: String(err?.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Requirement 3: bypass DSH entirely — call Ollama's /api/embed directly.
   * An embeddings array means Ollama and the model are healthy; an error or an
   * empty payload points at the Ollama side, not DSH.
   */
  const embedTest = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`http://${host}:${port}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: embedModel, input: EMBED_TEST_TEXT }),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(body.embeddings) && body.embeddings.length > 0) {
        const dim = Array.isArray(body.embeddings[0]) ? body.embeddings[0].length : null;
        return { ok: true, model: body.model ?? embedModel, dimension: dim, count: body.embeddings.length };
      }
      return {
        ok: false,
        model: body.model ?? embedModel,
        error: body.error || `HTTP ${res.status}`,
      };
    } catch (err) {
      return { ok: false, model: embedModel, error: String(err?.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
  };

  /** Requirement 5: force the CLI onto the IPv4 literal and read its verdict. */
  const ipv4CliTest = async () => {
    const endpoint = `http://127.0.0.1:${port}`;
    const r = await runCommand("mnemon", ["embed", "--status"], {
      timeoutMs: 30_000,
      env: { ...process.env, MNEMON_EMBED_ENDPOINT: endpoint },
    });
    return { ok: r.ok, endpoint, code: r.code ?? null, output: r.output || r.error || "" };
  };

  /** Activation: start the service, then detect the version once. */
  (async () => {
    try {
      const started = await ensureRunning();
      if (started.started === false && started.reason === "already-listening") {
        info(`ollama already listening on ${host}:${port} — skipped`);
      }
    } catch (err) {
      warn(`autostart failed: ${err?.message ?? String(err)}`);
    }
    await checkVersion();
  })();

  /**
   * Browser-facing API. The webServer service is published by the browser half
   * AFTER plugin activation, so register inside a deferred inject fiber that
   * pends until the service exists (the same pattern the in-app settings pages
   * use; a one-shot ctx.get at apply time would answer undefined forever).
   */
  if (typeof ctx?.inject === "function") {
    ctx.inject(["webServer"], (scoped) => {
      const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json" },
      });
      const handle = async (request) => {
        let segment = "";
        try {
          const url = new URL(request.url, "http://localhost");
          segment = url.pathname.replace(new RegExp(`^${API_PREFIX}`), "").replace(/\/+$/, "");
        } catch {
          segment = "";
        }
        try {
          switch (segment) {
            case "":
              return json({
                running: state.running,
                listening: await portOpen(host, port),
                startedByUs: state.startedByUs,
                pid: state.startedPid,
                host,
                port,
                version: state.version,
                versionChecked: state.versionChecked,
              });
            case "/start":
              if (request.method !== "POST") return json({ error: "POST only" }, 405);
              return json(await ensureRunning());
            case "/health":
              if (request.method !== "POST") return json({ error: "POST only" }, 405);
              return json(await health());
            case "/embed-test":
              if (request.method !== "POST") return json({ error: "POST only" }, 405);
              return json(await embedTest());
            case "/version":
              if (request.method !== "POST") return json({ error: "POST only" }, 405);
              const v = await checkVersion();
              return json({ ok: v.ok, version: state.version, error: v.error });
            case "/ipv4-cli":
              if (request.method !== "POST") return json({ error: "POST only" }, 405);
              return json(await ipv4CliTest());
            default:
              return json({ error: `unknown endpoint "${segment}"` }, 404);
          }
        } catch (err) {
          return json({ error: String(err?.message ?? err) }, 500);
        }
      };
      scoped.effect(
        () => scoped.webServer.register({ kind: "prefix", path: API_PREFIX, handler: handle }),
        "ollama-autostart: api routes",
      );
      info(`settings API mounted at ${API_PREFIX}`);
    });
  }

  return () => {
    /* The service is detached and intentionally outlives DSH; nothing to clean up. */
  };
}
