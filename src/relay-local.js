/**
 * Local session registry + checkpoint restore for the kill/restore relay.
 * Console publishes via Upstash; daemon polls /api/relay/poll and runs these.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { gunzipSync, gzipSync } = require("zlib");

const REGISTRY_PATH = path.join(os.homedir(), ".tethro", "local-sessions.json");

const SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  "coverage",
  ".tethro",
]);

function loadRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return {};
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveRegistry(map) {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(map, null, 2));
}

function registerLocalSession(sessionId, opts) {
  const map = loadRegistry();
  map[sessionId] = {
    pid: opts.pid,
    pgid: opts.pgid ?? null,
    startKey: opts.startKey ?? null,
    workspace: opts.workspace,
    updatedAt: Date.now(),
  };
  saveRegistry(map);
}

function unregisterLocalSession(sessionId) {
  const map = loadRegistry();
  delete map[sessionId];
  saveRegistry(map);
}

function getLocalSession(sessionId) {
  return loadRegistry()[sessionId] || null;
}

function listLocalSessions() {
  const map = loadRegistry();
  return Object.entries(map).map(([sessionId, v]) => ({ sessionId, ...v }));
}

function killLocalProcess(opts) {
  const pid = opts.pid;
  if (!pid) return { ok: true, detail: "no PID" };
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F /T`, {
        stdio: "pipe",
        shell: process.env.ComSpec || "cmd.exe",
      });
      return { ok: true, detail: `taskkill pid ${pid}` };
    }
    if (opts.pgid) {
      try {
        process.kill(-opts.pgid, "SIGKILL");
        return { ok: true, detail: `SIGKILL pgid ${opts.pgid}` };
      } catch {
        /* fall through */
      }
    }
    process.kill(pid, "SIGKILL");
    return { ok: true, detail: `SIGKILL pid ${pid}` };
  } catch (e) {
    return { ok: false, detail: e.message || "kill failed" };
  }
}

function checkpointDir(workspace) {
  const dir = path.join(workspace, ".tethro", "checkpoints");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a healthy checkpoint blob (same format as console checkpoint-store). */
function createLocalCheckpoint(workspace, sessionId) {
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith(".env")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        if (fs.statSync(full).size > 2_000_000) continue;
      } catch {
        continue;
      }
      files.push(full);
    }
  }
  walk(workspace);

  const chunks = [];
  for (const full of files) {
    const rel = path.relative(workspace, full).replace(/\\/g, "/");
    const buf = fs.readFileSync(full);
    chunks.push(Buffer.from(`${rel}\n${buf.length}\n`, "utf8"), buf);
  }
  const out = path.join(checkpointDir(workspace), `${sessionId}-ckpt-0.tgz`);
  fs.writeFileSync(out, gzipSync(Buffer.concat(chunks)));
  return { ok: true, path: out, files: files.length };
}

function restoreLatestLocalCheckpoint(workspace, sessionId) {
  const dir = path.join(workspace, ".tethro", "checkpoints");
  if (!fs.existsSync(dir)) {
    return { ok: false, detail: "no checkpoints dir" };
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(sessionId) && f.endsWith(".tgz"))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (files.length === 0) {
    return { ok: false, detail: "no checkpoint archive" };
  }
  const archive = path.join(dir, files[0].f);
  const raw = gunzipSync(fs.readFileSync(archive));
  let offset = 0;
  let count = 0;
  const root = path.resolve(workspace);
  while (offset < raw.length) {
    const nl1 = raw.indexOf(0x0a, offset);
    if (nl1 < 0) break;
    const rel = raw.subarray(offset, nl1).toString("utf8");
    const nl2 = raw.indexOf(0x0a, nl1 + 1);
    if (nl2 < 0) break;
    const len = Number(raw.subarray(nl1 + 1, nl2).toString("utf8"));
    if (!Number.isFinite(len) || len < 0) break;
    const start = nl2 + 1;
    const end = start + len;
    if (end > raw.length) break;
    const content = raw.subarray(start, end);
    const target = path.resolve(path.join(workspace, rel));
    if (target !== root && !target.startsWith(root + path.sep)) {
      offset = end;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    count++;
    offset = end;
  }
  return { ok: true, detail: `restored ${count} files from ${files[0].f}`, files: count };
}

async function handleRelayCommand(cmd, apiRequest, log) {
  const local = getLocalSession(cmd.sessionId);
  if (!local) {
    const detail = `no local session ${cmd.sessionId}`;
    log(detail, "warn");
    await apiRequest("POST", "/api/relay/ack", {
      sessionId: cmd.sessionId,
      requestId: cmd.requestId,
      op: cmd.op,
      ok: false,
      detail,
    }).catch(() => {});
    return;
  }

  if (cmd.op === "kill") {
    const res = killLocalProcess(local);
    log(`Relay kill ${cmd.sessionId}: ${res.detail}`, res.ok ? "ok" : "error");
    await apiRequest("POST", "/api/relay/ack", {
      sessionId: cmd.sessionId,
      requestId: cmd.requestId,
      op: "kill",
      ok: res.ok,
      detail: res.detail,
    }).catch(() => {});
    return;
  }

  if (cmd.op === "restore") {
    const res = restoreLatestLocalCheckpoint(local.workspace, cmd.sessionId);
    log(`Relay restore ${cmd.sessionId}: ${res.detail}`, res.ok ? "ok" : "warn");
    await apiRequest("POST", "/api/relay/ack", {
      sessionId: cmd.sessionId,
      requestId: cmd.requestId,
      op: "restore",
      ok: res.ok,
      detail: res.detail || "",
    }).catch(() => {});
  }
}

module.exports = {
  registerLocalSession,
  unregisterLocalSession,
  getLocalSession,
  listLocalSessions,
  killLocalProcess,
  createLocalCheckpoint,
  restoreLatestLocalCheckpoint,
  handleRelayCommand,
};
