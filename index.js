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
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const PIDFILE = "/tmp/dsh-ollama-autostart.pid";
const DEBUG_FILE = "/tmp/dsh-ollama-autostart-debug.json";

/**
 * The auto-start preference is a boot-time behavior, so it persists in a
 * plugin-owned file under the DSH home (the same convention other plugins'
 * user data uses) rather than in the row's config — the row config's editor
 * lane may be unavailable in this profile.
 */
const DSH_HOME = process.env.DSH_HOME || "/root/.dsh";
const PREFERENCE_FILE = `${DSH_HOME}/plugin-data/dsh-ollama-autostart/auto-start.json`;

/** Read the auto-start switch: true unless the file explicitly says false. */
function readAutoStart() {
  try {
    const value = JSON.parse(readFileSync(PREFERENCE_FILE, "utf8"));
    return value && value.autoStart !== false;
  } catch {
    return true;
  }
}

/** Persist the auto-start switch. */
function writeAutoStart(enabled) {
  mkdirSync(dirname(PREFERENCE_FILE), { recursive: true });
  writeFileSync(PREFERENCE_FILE, JSON.stringify({ autoStart: !!enabled, updatedAt: new Date().toISOString() }, null, 1));
}

/** Debug marker for route-registration diagnostics (removed once verified). */
function dbg(payload) {
  try {
    writeFileSync(DEBUG_FILE, JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 1));
  } catch { /* diagnostics only */ }
}
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

/**
 * Declaring any service puts this entry's fiber in the injection lane, which
 * is what makes `ctx.inject` available on the context — a row with an empty
 * inject list gets a plain service view without the nested-fiber capability.
 * `tools` is present in every web-profile composition.
 */
export const inject = ["tools"];

export function apply(ctx, config) {
  const cfg = config && typeof config === "object" ? config : {};
  dbg({
    phase: "apply",
    hasInject: typeof ctx?.inject === "function",
    hasEffect: typeof ctx?.effect === "function",
    hasGet: typeof ctx?.get === "function",
    webServerNow: typeof ctx?.get === "function" ? (ctx.get("webServer") ? "present" : "absent") : "n/a",
  });
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
   * Parse one `ollama list` / `ollama ps` table into structured rows.
   *
   * The CLI prints variable-width, whitespace-aligned columns, so header-based
   * slice offsets break as soon as a value is wider than its column (e.g. a
   * runner name of "llamacpp" against a 9-wide CONTEXT gap). Instead each row
   * is extracted by anchoring the value patterns themselves:
   *
   *   list:  <name>  <8+ hex id | "unknown">  <number K/M/G TB | N/A>  <rest...>
   *   ps:    <name>  <id>  <size>  <processor>  <number>  <runner>  <rest...>
   *
   * The name is whatever sits before the id anchor, so it stays intact even
   * when it is wider than the header column. Empty tables come back as []
   * (the CLI prints either just the header or a "No running models" line).
   */
  const LIST_COLUMNS = ["name", "id", "size", "modified"];
  const PS_COLUMNS = ["name", "id", "size", "processor", "context", "runner", "until"];
  const RE_LIST_ROW = /^(.*\S)\s+([0-9a-f]{8,}|unknown)\s+(\d+(?:\.\d+)?\s*[KMGT]?B|\d+(?:\.\d+)?\s*%?\s*\w*|N\/A)\s*(.*)$/i;
  const RE_PS_ROW = /^(.*\S)\s+([0-9a-f]{8,}|unknown)\s+(\d+(?:\.\d+)?\s*[KMGT]?B|N\/A)\s+(.*?)\s+(\d+)\s+(\S+)\s*(.*)$/;

  const parseAligned = (text, columns, rowRe, tail) => {
    const lines = (text || "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim().length > 0);
    const rows = [];
    for (const line of lines) {
      // Skip headers and the CLI's empty-state annotations.
      if (/^NAME\b/.test(line) || /no running models/i.test(line)) continue;
      const m = rowRe.exec(line);
      if (!m) continue;
      const [, name, id, size, ...rest] = m;
      const row = { name: name.trim(), id, size };
      if (tail === "modified" && rest[0]) row.modified = rest[0].trim();
      if (tail === "ps") {
        row.processor = (rest[0] || "").trim();
        row.context = (rest[1] || "").trim();
        row.runner = (rest[2] || "").trim();
        row.until = (rest[3] || "").trim();
      }
      if (columns.some((key) => row[key])) rows.push(row);
    }
    return rows;
  };

  /**
   * Requirement: model query with a CLI-first ladder:
   *   1) `ollama list`   — pulled models with their sizes (占用);
   *   2) `ollama ps`     — currently loaded/running models with VRAM;
   *   3) fallback `curl -s /api/tags` when both CLI calls fail — parse the
   *      JSON in-process (equivalent to the `| python -c` pipe, without a
   *      python dependency).
   *
   * The CLI tables are parsed into structured rows here; the client renders
   * them with localized labels, so the panel language never depends on the
   * CLI's own (English) output.
   */
  const listModels = async () => {
    const listR = await runCommand("ollama", ["list"], { timeoutMs: 15_000 });
    const psR = await runCommand("ollama", ["ps"], { timeoutMs: 15_000 });
    if (listR.ok || psR.ok) {
      return {
        ok: true,
        source: "cli",
        list: {
          rows: listR.ok ? parseAligned(listR.output, LIST_COLUMNS, RE_LIST_ROW, "modified") : [],
          error: listR.ok ? undefined : (listR.error ?? listR.output ?? "non-zero exit"),
        },
        ps: {
          rows: psR.ok ? parseAligned(psR.output, PS_COLUMNS, RE_PS_ROW, "ps") : [],
          error: psR.ok ? undefined : (psR.error ?? psR.output ?? "non-zero exit"),
        },
      };
    }
    // Ladder step 3: curl the HTTP API directly.
    const curlR = await runCommand("curl", ["-s", "-m", "10", `http://${host}:${port}/api/tags`], { timeoutMs: 15_000 });
    let names = null;
    if (curlR.ok) {
      try {
        const body = JSON.parse(curlR.output || "{}");
        names = Array.isArray(body.models)
          ? body.models.map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean)
          : null;
      } catch {
        names = null;
      }
    }
    if (names === null) {
      // Same URL through the in-process fetch (covers a missing curl).
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const res = await fetch(`http://${host}:${port}/api/tags`, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          names = Array.isArray(body.models)
            ? body.models.map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean)
            : [];
        }
      } catch {
        names = [];
      }
    }
    return {
      ok: true,
      source: "api",
      models: names,
      note: "cli-unavailable",
      cliError: (listR.error ?? psR.error ?? "").slice(0, 160),
    };
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

  /**
   * Activation: honor the auto-start switch — ON boots the service, OFF does
   * not (the manual button and the other checks still work at any time). The
   * version detection runs either way, once, on every host boot.
   */
  (async () => {
    const autoStart = readAutoStart();
    try {
      if (autoStart) {
        const started = await ensureRunning();
        if (started.started === false && started.reason === "already-listening") {
          info(`ollama already listening on ${host}:${port} — skipped`);
        }
      } else {
        info(`auto-start switch is OFF — skipping the ollama serve boot (manual start still available)`);
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
      dbg({ phase: "webserver-fiber", registerType: typeof scoped.webServer?.register });
      /**
       * The webServer carrier passes node:http (req, res) to prefix handlers
       * and awaits the handler — nothing converts a returned Web Response, so
       * every reply MUST be written through res (writeHead + end) or the
       * socket hangs open and the request never completes.
       */
      const handle = async (req, res) => {
        const send = (payload, status = 200) => {
          const body = JSON.stringify(payload);
          res.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(body);
        };
        let segment = "";
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const markerAt = url.pathname.indexOf(API_PREFIX);
          segment = markerAt >= 0
            ? url.pathname.slice(markerAt + API_PREFIX.length).replace(/\/+$/, "")
            : "";
        } catch {
          segment = "";
        }
        const method = String(req.method ?? "GET").toUpperCase();
        /** Read a JSON body from the node request stream. */
        const readBody = async () => {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          if (!raw) return {};
          try {
            return JSON.parse(raw);
          } catch {
            return {};
          }
        };
        try {
          switch (segment) {
            case "":
              return send({
                running: state.running,
                listening: await portOpen(host, port),
                startedByUs: state.startedByUs,
                pid: state.startedPid,
                host,
                port,
                version: state.version,
                versionChecked: state.versionChecked,
                autoStart: readAutoStart(),
              });
            case "/auto-start":
              if (method !== "POST") return send({ error: "POST only" }, 405);
              const body = await readBody();
              const enabled = !!body.enabled;
              writeAutoStart(enabled);
              let startReport = null;
              if (enabled) {
                // Flipping ON while the host is running: bring the service up
                // now, not only at the next boot.
                startReport = await ensureRunning();
              }
              info(`auto-start switch ${enabled ? "ON" : "OFF"}${startReport?.started ? `; service starting (pid ${startReport.pid})` : ""}`);
              return send({
                ok: true,
                autoStart: enabled,
                started: startReport ? startReport.started : undefined,
                pid: startReport ? startReport.pid : undefined,
                reason: startReport ? startReport.reason : undefined,
              });
            case "/start":
              if (method !== "POST") return send({ error: "POST only" }, 405);
              return send(await ensureRunning());
            case "/health":
              if (method !== "POST") return send({ error: "POST only" }, 405);
              return send(await health());
            case "/models":
              if (method !== "POST") return send({ error: "POST only" }, 405);
              return send(await listModels());
            case "/embed-test":
              if (method !== "POST") return send({ error: "POST only" }, 405);
              return send(await embedTest());
            case "/version":
              if (method !== "POST") return send({ error: "POST only" }, 405);
              const v = await checkVersion();
              return send({ ok: v.ok, version: state.version, error: v.error });
            case "/ipv4-cli":
              if (method !== "POST") return send({ error: "POST only" }, 405);
              return send(await ipv4CliTest());
            default:
              return send({ error: `unknown endpoint "${segment}"` }, 404);
          }
        } catch (err) {
          return send({ error: String(err?.message ?? err) }, 500);
        }
      };
      scoped.effect(
        () => {
          scoped.webServer.register({ kind: "prefix", path: API_PREFIX, handler: handle });
          dbg({ phase: "routes-registered" });
        },
        "ollama-autostart: api routes",
      );
      info(`settings API mounted at ${API_PREFIX}`);
    });
  }

  return () => {
    /* The service is detached and intentionally outlives DSH; nothing to clean up. */
  };
}
