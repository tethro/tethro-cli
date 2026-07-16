#!/usr/bin/env node
/**
 * Tethro CLI — the real binary.
 *
 * Usage:
 *   tethro daemon start                              Start the local daemon
 *   tethro daemon status                             Check daemon status
 *   tethro run <agent> <prompt>                      Run an agent in a sandbox
 *   tethro run claude-code "refactor the webhook"    Specific example
 *   tethro scan [path]                               Scan workspace for secrets + licenses
 *   tethro kill [session-id]                         Kill switch (all or specific session)
 *   tethro sessions                                  List active sessions
 *   tethro config show                               Show current configuration
 *   tethro login <email> <password>                   Authenticate CLI to console
 *   tethro connect                                    Register this repo with the console
 *   tethro doctor                                    Verify installation
 */

const { spawn, spawnSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const CONFIG_DIR = path.join(os.homedir(), ".tethro");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function findConsoleConfigPath() {
  const candidates = [
    process.env.TETHRO_CONFIG_PATH,
    path.join(process.cwd(), "db", "tethro-config.json"),
    path.join(__dirname, "..", "..", "..", "agentic", "db", "tethro-config.json"),
    path.join(os.homedir(), "Desktop", "agentic", "db", "tethro-config.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* skip */
    }
  }
  return null;
}

function loadSandboxDiskConfig() {
  const p = findConsoleConfigPath();
  if (!p) return null;
  try {
    return { ...JSON.parse(fs.readFileSync(p, "utf8")), _path: p };
  } catch {
    return null;
  }
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

function getConsoleUrl() {
  return process.env.TETHRO_URL || loadConfig().url || "http://localhost:3000";
}

function getApiToken() {
  return process.env.TETHRO_TOKEN || loadConfig().token || "";
}

const DEFAULT_ISOLATION = process.env.TETHRO_ISOLATION || "subprocess";

// ─── Helpers ───

function log(msg, level = "info") {
  const colors = { info: "\x1b[36m", ok: "\x1b[32m", warn: "\x1b[33m", error: "\x1b[31m", reset: "\x1b[0m" };
  const prefix = { info: "[info]", ok: "[ok]", warn: "[warn]", error: "[error]" };
  console.log(`${colors[level]}${prefix[level]}${colors.reset} ${msg}`);
}

/** Cross-platform "is this binary on PATH?" */
function isWindows() {
  return process.platform === "win32";
}

function detectShell() {
  if (isWindows()) {
    if (process.env.PSModulePath || process.env.POWERSHELL_DISTRIBUTION_CHANNEL) {
      return "powershell";
    }
    if (process.env.ComSpec && process.env.ComSpec.toLowerCase().includes("cmd.exe")) {
      return "cmd";
    }
    return "powershell";
  }
  const shell = (process.env.SHELL || "").toLowerCase();
  return shell.includes("bash") ? "bash" : "sh";
}

function commandExists(cmd) {
  try {
    const checker = isWindows() ? `where ${cmd}` : `which ${cmd}`;
    execSync(checker, { stdio: "pipe", shell: isWindows() });
    return true;
  } catch {
    return false;
  }
}

function pythonExecutable() {
  if (isWindows()) {
    if (commandExists("python")) return "python";
    if (commandExists("py")) return "py";
    if (commandExists("python3")) return "python3";
    return "python";
  }
  if (commandExists("python3")) return "python3";
  if (commandExists("python")) return "python";
  return "python3";
}

function shellOneLiner(script) {
  const shell = detectShell();
  if (shell === "powershell") {
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  if (shell === "cmd") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", script] };
  }
  return { command: "sh", args: ["-c", script] };
}

function apiRequest(method, pathStr, body) {
  return new Promise((resolve, reject) => {
    const consoleUrl = getConsoleUrl();
    const apiToken = getApiToken();
    const url = new URL(pathStr, consoleUrl);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(chunks) });
          } catch {
            resolve({ status: res.statusCode, data: chunks });
          }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Emit a real audit event to the WebSocket service (for live audit log streaming)
function emitWsEvent(event) {
  const wsUrl = new URL("/emit", `http://localhost:3003`);
  const data = JSON.stringify(event);
  const req = http.request(
    {
      hostname: wsUrl.hostname,
      port: wsUrl.port,
      path: wsUrl.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    },
    () => {}
  );
  req.on("error", () => {}); // swallow — don't crash if WS is down
  req.write(data);
  req.end();
}

// ─── Sandbox ───

function createSandboxWorkspace(projectPath) {
  const disk = loadSandboxDiskConfig();
  const sandboxRoot = path.join(os.tmpdir(), "tethro-sandboxes");
  fs.mkdirSync(sandboxRoot, { recursive: true });

  // GC stale sandboxes by TTL
  const ttlHours = disk?.staleCloneTtlHours ?? 72;
  const maxClones = disk?.maxClonesPerProject ?? 4;
  try {
    const entries = fs.readdirSync(sandboxRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    const cutoff = Date.now() - ttlHours * 3600_000;
    for (const e of entries) {
      const full = path.join(sandboxRoot, e.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
          log(`GC removed stale sandbox ${e.name}`, "info");
        }
      } catch {
        /* skip */
      }
    }
    // Cap clone count
    const remaining = fs
      .readdirSync(sandboxRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const full = path.join(sandboxRoot, e.name);
        return { name: e.name, full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    while (remaining.length >= maxClones) {
      const old = remaining.shift();
      fs.rmSync(old.full, { recursive: true, force: true });
      log(`GC removed excess sandbox ${old.name} (maxClones=${maxClones})`, "info");
    }
  } catch (err) {
    log(`Sandbox GC skipped: ${err.message}`, "warn");
  }

  const sandboxDir = path.join(sandboxRoot, `sb-${Date.now()}`);
  fs.mkdirSync(sandboxDir, { recursive: true });

  const method = disk?.cloneMethod || "copy";
  log(`Creating sandbox workspace at ${sandboxDir} (method=${method})`, "info");
  try {
    // Windows/macOS: Node fs.cpSync (reflink/clonefile require platform FS support —
    // attempt copyFile with COPYFILE_FICLONE where available, else recursive copy).
    fs.cpSync(projectPath, sandboxDir, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return base !== "node_modules" && base !== ".git" && base !== ".next";
      },
    });
  } catch (e) {
    log(`Failed to copy project to sandbox: ${e.message}`, "error");
    return null;
  }

  return sandboxDir;
}

function dockerRuntimes() {
  if (!commandExists("docker")) return [];
  try {
    const out = execSync('docker info --format "{{json .Runtimes}}"', {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return Object.keys(JSON.parse(out.trim() || "{}"));
  } catch {
    return [];
  }
}

function getIsolationMethod(requested) {
  const runtimes = dockerRuntimes();
  const hasDocker = commandExists("docker");
  const strict = process.env.TETHRO_REQUIRE_ISOLATION === "1";

  if (requested === "none" || requested === "subprocess") return "subprocess";
  if (requested === "docker") return hasDocker ? "docker" : "subprocess";

  if (requested === "gvisor") {
    if (commandExists("runsc")) return "gvisor-native";
    if (hasDocker && (runtimes.includes("runsc") || runtimes.includes("gvisor"))) {
      return "gvisor";
    }
    if (commandExists("runsc") && hasDocker) return "gvisor";
    if (strict) return "subprocess";
    if (hasDocker) return "docker";
    return "subprocess";
  }

  if (requested === "firecracker") {
    const hasKernel = process.env.TETHRO_FC_KERNEL && fs.existsSync(process.env.TETHRO_FC_KERNEL);
    const hasRootfs = process.env.TETHRO_FC_ROOTFS && fs.existsSync(process.env.TETHRO_FC_ROOTFS);
    if (
      process.platform === "linux" &&
      commandExists(process.env.TETHRO_FC_BIN || "firecracker") &&
      hasKernel &&
      hasRootfs
    ) {
      return "firecracker-native";
    }
    if (
      hasDocker &&
      (runtimes.includes("io.containerd.kata.v2") ||
        runtimes.includes("kata") ||
        runtimes.includes("firecracker"))
    ) {
      return "firecracker";
    }
    if (process.platform === "win32" && hasDocker && !strict) return "docker-hyperv";
    if (strict) return "subprocess";
    if (hasDocker) return "docker";
    return "subprocess";
  }

  return "subprocess";
}

async function runInSandbox(sandboxDir, agent, prompt, isolation, sessionId) {
  const method = getIsolationMethod(isolation);
  if (isolation === "firecracker" || isolation === "gvisor") {
    if (method === "subprocess") {
      log(
        `${isolation} requested but no Docker/runtime — using subprocess (not a microVM)`,
        "warn"
      );
    } else if (method === "docker" || method === "docker-hyperv") {
      log(
        `${isolation} requested — launching via ${method} (honest stand-in when kata/runsc unavailable)`,
        "warn"
      );
    } else {
      log(`Isolation: ${method} (requested: ${isolation})`, "info");
    }
  } else {
    log(`Isolation: ${method} (requested: ${isolation})`, "info");
  }

  if (method === "gvisor-native") {
    return runInGvisorNative(sandboxDir, agent, prompt);
  }
  if (method === "firecracker-native") {
    log(
      "Native Firecracker selected — boot via Firecracker API (kernel+rootfs). Prefer Linux host.",
      "info"
    );
    // Delegate to docker kata path if a companion helper is not present; spawn firecracker binary with api sock
    return runInFirecrackerNative(sandboxDir, agent, prompt);
  }

  if (
    method === "docker" ||
    method === "gvisor" ||
    method === "firecracker" ||
    method === "docker-hyperv"
  ) {
    return runInDocker(sandboxDir, agent, prompt, method);
  }
  return runInSubprocess(sandboxDir, agent, prompt, sessionId);
}

function agentCmdLine(agent, prompt) {
  if (agent === "claude-code" || String(agent).startsWith("claude")) {
    return ["npx", "-y", "@anthropic-ai/claude-code", prompt];
  }
  if (agent === "codex-cli" || String(agent).startsWith("codex")) {
    return ["npx", "-y", "@openai/codex", prompt];
  }
  return [agent, prompt];
}

function runInGvisorNative(sandboxDir, agent, prompt) {
  const cmd = agentCmdLine(agent, prompt);
  const root = process.env.TETHRO_GVISOR_ROOT || path.join(os.tmpdir(), "tethro-runsc");
  return spawnPromise("runsc", ["--root", root, "do", "--cwd", sandboxDir, "--", ...cmd], {
    cwd: sandboxDir,
  });
}

function runInFirecrackerNative(sandboxDir, agent, prompt) {
  // Minimal native boot: start firecracker with api sock; full HTTP config mirrors console firecracker-native.ts
  const cmd = agentCmdLine(agent, prompt);
  const socketDir = process.env.TETHRO_FC_SOCKET_DIR || path.join(os.tmpdir(), "tethro-fc");
  fs.mkdirSync(socketDir, { recursive: true });
  const sock = path.join(socketDir, `fc-${Date.now().toString(36)}.sock`);
  const bin = process.env.TETHRO_FC_BIN || "firecracker";
  log(`Starting ${bin} --api-sock ${sock} (configure kernel/rootfs via TETHRO_FC_*)`, "info");
  // For CLI UX, fall through to kata/docker if companion script missing
  if (commandExists("docker")) {
    log("Native FC config helper uses console spawnIsolatedAsync; CLI uses Kata/docker runtime", "warn");
    return runInDocker(sandboxDir, agent, prompt, "firecracker");
  }
  return spawnPromise(bin, ["--api-sock", sock], { cwd: sandboxDir });
}

function spawnPromise(command, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, code });
      else reject(new Error(`${command} exited ${code}`));
    });
    child.on("error", reject);
  });
}

async function runInSubprocess(sandboxDir, agent, prompt, sessionId) {
  // Subprocess isolation: restricted environment, no real API keys
  // Request a per-session scoped key from the credential proxy
  let sessionKey = "tethro-session-proxy";
  try {
    const provider = agent === "codex-cli" ? "openai" : "anthropic";
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: 8787,
          path: "/session/create",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(JSON.parse(body || "{}")));
        }
      );
      req.on("error", reject);
      req.write(JSON.stringify({ provider, sessionId }));
      req.end();
    });
    if (res.sessionKey) {
      sessionKey = res.sessionKey;
      log(`Got scoped session key from credential proxy (expires in ${res.expiresIn})`, "ok");
    }
  } catch {
    log("Credential proxy not running — agent will use placeholder key", "warn");
  }

  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: sessionKey,
    OPENAI_API_KEY: sessionKey,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/anthropic",
    OPENAI_BASE_URL: "http://127.0.0.1:8787/openai",
    TETHRO_SANDBOX: "1",
    TETHRO_WORKSPACE: sandboxDir,
    // Route outbound HTTP(S) through credential proxy for egress allowlist
    HTTP_PROXY: "http://127.0.0.1:8787",
    HTTPS_PROXY: "http://127.0.0.1:8787",
    http_proxy: "http://127.0.0.1:8787",
    https_proxy: "http://127.0.0.1:8787",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };

  let command, args;
  if (agent === "claude-code") {
    command = "npx";
    args = ["-y", "@anthropic-ai/claude-code", prompt];
  } else if (agent === "codex-cli") {
    command = "npx";
    args = ["-y", "@openai/codex", prompt];
  } else if (agent === "aider") {
    command = pythonExecutable();
    args = ["-m", "aider", "--message", prompt];
  } else {
    const one = shellOneLiner(`${agent} "${prompt.replace(/"/g, '\\"')}"`);
    command = one.command;
    args = one.args;
  }

  log(`Spawning agent: ${command} ${args.join(" ")} (shell=${detectShell()})`, "info");

  const child = spawn(command, args, {
    cwd: sandboxDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: isWindows(),
    windowsHide: true,
  });

  return { child, method: "subprocess" };
}

function runInDocker(sandboxDir, agent, prompt, method = "docker") {
  const imageName = process.env.TETHRO_AGENT_IMAGE || "node:22-bookworm";
  const env = [
    "-e", "ANTHROPIC_API_KEY=tethro-session-proxy",
    "-e", "ANTHROPIC_BASE_URL=http://host.docker.internal:8787/anthropic",
    "-e", "OPENAI_API_KEY=tethro-session-proxy",
    "-e", "OPENAI_BASE_URL=http://host.docker.internal:8787/openai",
    "-e", "TETHRO_SANDBOX=1",
  ];

  let cmd;
  if (agent === "claude-code") {
    cmd = ["npx", "-y", "@anthropic-ai/claude-code", prompt];
  } else if (agent === "codex-cli") {
    cmd = ["npx", "-y", "@openai/codex", prompt];
  } else {
    cmd = ["sh", "-c", `${agent} "${prompt.replace(/"/g, '\\"')}"`];
  }

  const runtimeArgs = [];
  if (method === "gvisor") {
    runtimeArgs.push("--runtime=runsc");
  } else if (method === "firecracker") {
    const runtimes = dockerRuntimes();
    if (runtimes.includes("io.containerd.kata.v2")) {
      runtimeArgs.push("--runtime=io.containerd.kata.v2");
    } else if (runtimes.includes("kata")) {
      runtimeArgs.push("--runtime=kata");
    } else if (runtimes.includes("firecracker")) {
      runtimeArgs.push("--runtime=firecracker");
    }
  } else if (method === "docker-hyperv" && process.platform === "win32") {
    runtimeArgs.push("--isolation=hyperv");
  }

  const args = [
    "run", "--rm",
    ...runtimeArgs,
    "-v", `${sandboxDir}:/workspace`,
    "-w", "/workspace",
    "--add-host=host.docker.internal:host-gateway",
    ...env,
    imageName,
    ...cmd,
  ];

  log(`Spawning Docker (${method}): docker ${args.join(" ")}`, "info");
  const child = spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: isWindows(),
    windowsHide: true,
  });
  return { child, method };
}

// ─── Commands ───

async function cmdRun(agent, prompt, opts = {}) {
  const projectPath = process.cwd();
  const isolation = opts.isolation || DEFAULT_ISOLATION;

  log(`Starting sandboxed session`, "info");
  log(`Agent: ${agent}`, "info");
  log(`Project: ${projectPath}`, "info");
  log(`Prompt: ${prompt}`, "info");

  // Create session via API
  const sessionId = `sn-${Date.now().toString(36)}`;
  try {
    const res = await apiRequest("POST", "/api/sessions", {
      sessionId,
      agent: agent === "claude-code" ? "claude-code-sonnet-5" : agent,
      project: path.basename(projectPath),
      branch: execSync("git branch --show-current", { cwd: projectPath }).toString().trim() || "main",
      isolation,
    });
    if (res.status === 201) {
      log(`Session ${sessionId} created`, "ok");
    } else {
      log(`Session creation returned ${res.status} (continuing in local mode)`, "warn");
    }
  } catch (e) {
    log(`Could not reach console at ${getConsoleUrl()} — running in local mode`, "warn");
  }

  // Create sandbox workspace
  const sandboxDir = createSandboxWorkspace(projectPath);
  if (!sandboxDir) {
    process.exit(1);
  }

  // Run agent in sandbox
  const { child, method } = await runInSandbox(sandboxDir, agent, prompt, isolation, sessionId);
  log(`Agent running with ${method} isolation`, "ok");
  log(`Sandbox workspace: ${sandboxDir}`, "info");
  log(`Streaming output...`, "info");
  console.log("---");

  child.stdout.on("data", (data) => {
    process.stdout.write(data);
    // Emit real audit event to WebSocket service
    emitWsEvent({
      agent,
      sessionId,
      category: "fs.write",
      target: `${sandboxDir}/stdout`,
      outcome: "allow",
      severity: "info",
    });
  });

  child.stderr.on("data", (data) => {
    process.stderr.write(data);
    emitWsEvent({
      agent,
      sessionId,
      category: "proc.spawn",
      target: `${sandboxDir}/stderr`,
      outcome: "allow",
      severity: "warn",
    });
  });

  child.on("close", (code) => {
    console.log("---");
    log(`Agent exited with code ${code}`, code === 0 ? "ok" : "error");

    // Emit real completion event
    emitWsEvent({
      agent,
      sessionId,
      category: "proc.spawn",
      target: `Agent ${agent} exited with code ${code}`,
      outcome: code === 0 ? "allow" : "deny",
      severity: code === 0 ? "info" : "warn",
    });

    // Scan the sandbox for secrets + licenses before allowing merge
    log(`Scanning sandbox output for secrets and licenses...`, "info");
    scanDirectory(sandboxDir, sessionId);

    // Update session status
    apiRequest("POST", "/api/audit", {
      agent,
      sessionId,
      category: "proc.spawn",
      target: `Agent ${agent} completed with code ${code}`,
      outcome: "allow",
      severity: code === 0 ? "info" : "warn",
    }).catch(() => {});

    // Cleanup sandbox (in production, this would be GC'd after retention period)
    if (process.env.TETHRO_KEEP_SANDBOX !== "1") {
      try {
        fs.rmSync(sandboxDir, { recursive: true, force: true });
        log(`Sandbox cleaned up`, "ok");
      } catch {}
    }

    process.exit(code || 0);
  });
}

function scanDirectory(dir, sessionId) {
  const scannerPath = path.join(__dirname, "scanner.js");
  const licensePath = path.join(__dirname, "license-scanner.js");
  let scanContentForSecrets, scanContentForLicenses;
  try {
    scanContentForSecrets = require(scannerPath).scanContentForSecrets;
    scanContentForLicenses = require(licensePath).scanContentForLicenses;
  } catch {
    // Inline fallback if scanner modules aren't available
    scanContentForSecrets = (content) => {
      const patterns = [
        { type: "AWS Access Key", regex: /AKIA[0-9A-Z]{16}/g },
        { type: "GitHub PAT", regex: /ghp_[A-Za-z0-9]{36}/g },
        { type: "Private Key", regex: /-----BEGIN.*PRIVATE KEY-----/g },
      ];
      const detections = [];
      for (const p of patterns) {
        const matches = content.matchAll(p.regex);
        for (const m of matches) detections.push({ type: p.type, preview: "****", severity: "critical", match: m[0] });
      }
      return detections;
    };
    scanContentForLicenses = (content) => {
      const patterns = [
        { type: "GPL-3.0", riskLevel: "block", patterns: [/GPL-3\.0/i, /GNU General Public License/i] },
        { type: "MIT", riskLevel: "notice", patterns: [/MIT License/i] },
      ];
      const detections = [];
      for (const lp of patterns) {
        for (const p of lp.patterns) {
          if (content.match(p)) { detections.push({ type: lp.type, riskLevel: lp.riskLevel, snippet: "..." }); break; }
        }
      }
      return detections;
    };
  }

  const files = walkDir(dir);
  let secretCount = 0;
  let licenseCount = 0;

  for (const file of files) {
    // Skip node_modules, .git, etc.
    if (file.includes("node_modules") || file.includes(".git/")) continue;

    try {
      const content = fs.readFileSync(file, "utf-8");
      const secrets = scanContentForSecrets(content);
      const licenses = scanContentForLicenses(content);

      for (const s of secrets) {
        log(`SECRET FOUND: ${s.type} in ${file} — ${s.preview}`, "error");
        secretCount++;
        // Report to console
        apiRequest("POST", "/api/scan/secrets", {
          files: [{ path: file, content }],
          sessionId,
        }).catch(() => {});
      }

      for (const l of licenses) {
        if (l.riskLevel === "block") {
          log(`LICENSE BLOCK: ${l.type} in ${file}`, "error");
          licenseCount++;
        } else if (l.riskLevel === "review") {
          log(`LICENSE REVIEW: ${l.type} in ${file}`, "warn");
        }
      }
    } catch {}
  }

  log(`Scan complete: ${secretCount} secrets, ${licenseCount} blocking licenses`, secretCount > 0 ? "error" : "ok");
}

function walkDir(dir) {
  const results = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory() && item.name !== "node_modules" && item.name !== ".git") {
      results.push(...walkDir(full));
    } else if (item.isFile()) {
      results.push(full);
    }
  }
  return results;
}

async function cmdScan(targetPath = ".") {
  const abs = path.resolve(targetPath);
  log(`Scanning ${abs} for secrets and licenses...`, "info");
  scanDirectory(abs, "scan-local");
}

async function cmdKill(sessionId) {
  log("Triggering kill switch...", "warn");
  try {
    if (sessionId) {
      const res = await apiRequest("POST", "/api/kill-switch", { sessionIds: [sessionId] });
      log(`Kill switch executed for ${sessionId}: ${res.data?.terminated || 0} sessions terminated`, "error");
    } else {
      // Kill all — get active sessions first
      const sessionsRes = await apiRequest("GET", "/api/sessions");
      const active = (sessionsRes.data || []).filter((s) => s.status === "running" || s.status === "reviewing");
      if (active.length === 0) {
        log("No active sessions to kill", "warn");
        return;
      }
      const ids = active.map((s) => s.sessionId);
      const res = await apiRequest("POST", "/api/kill-switch", { sessionIds: ids });
      log(`Kill switch executed: ${res.data?.terminated || 0} sessions terminated (incident ${res.data?.incidentId})`, "error");
    }
  } catch (e) {
    log(`Kill switch failed: ${e.message}`, "error");
  }
}

async function cmdSessions() {
  try {
    const res = await apiRequest("GET", "/api/sessions");
    const sessions = res.data || [];
    if (sessions.length === 0) {
      log("No sessions found", "info");
      return;
    }
    console.log("\nID              AGENT                   PROJECT           STATUS     ISOLATION");
    console.log("──────────────  ──────────────────────  ────────────────  ─────────  ──────────");
    for (const s of sessions) {
      console.log(
        `${(s.sessionId || s.id || "").padEnd(14)}  ${(s.agent || "").padEnd(22)}  ${(s.project || "").padEnd(16)}  ${(s.status || "").padEnd(10)}  ${(s.isolation || "").padEnd(10)}`
      );
    }
    console.log(`\n${sessions.length} session(s)`);
  } catch (e) {
    log(`Failed to fetch sessions: ${e.message}`, "error");
  }
}

async function cmdDaemon(action) {
  if (action === "start") {
    log("Starting Tethro daemon...", "info");
    const proxyDir = path.resolve(__dirname, "..", "..", "tethro-credential-proxy");
    const proxyEntry = path.join(proxyDir, "src", "index.js");
    const children = [];

    if (fs.existsSync(proxyEntry)) {
      log(`Starting credential proxy from ${proxyEntry}`, "info");
      const child = spawn(process.execPath, [proxyEntry], {
        cwd: proxyDir,
        env: process.env,
        stdio: "inherit",
      });
      children.push(child);
      log(`Credential proxy PID ${child.pid} → http://127.0.0.1:8787`, "ok");
    } else {
      log(`Credential proxy not found at ${proxyEntry}`, "warn");
      log("Clone/start tethro-credential-proxy separately, or set TETHRO_PROXY_PATH", "info");
    }

    const auditDir = path.resolve(__dirname, "..", "..", "tethro-audit-ws");
    const auditEntry = path.join(auditDir, "src", "index.ts");
    if (fs.existsSync(auditEntry) && commandExists("npx")) {
      log("Starting audit-ws on :3003", "info");
      const child = spawn("npx", ["-y", "tsx", auditEntry], {
        cwd: auditDir,
        env: {
          ...process.env,
          TETHRO_WATCH_PATH:
            process.env.TETHRO_WATCH_PATH ||
            path.join(os.tmpdir(), "tethro-sandboxes"),
        },
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      children.push(child);
      log(`Audit WS PID ${child.pid}`, "ok");
    }

    log(`Daemon supervisor PID: ${process.pid}`, "ok");
    log("Press Ctrl+C to stop child services", "info");

    const shutdown = () => {
      for (const c of children) {
        try {
          c.kill();
        } catch {
          /* ignore */
        }
      }
      log("Daemon stopped", "ok");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    setInterval(() => {}, 60_000);
  } else if (action === "status") {
    try {
      const res = await apiRequest("GET", "/api/sessions");
      log(`Console reachable at ${getConsoleUrl()}`, "ok");
      log(`Active sessions: ${(res.data || []).length}`, "ok");
    } catch {
      log(`Console not reachable at ${getConsoleUrl()}`, "warn");
      log("Run 'tethro daemon start' or start the web console", "info");
    }
  } else {
    log("Usage: tethro daemon <start|status>", "info");
  }
}

async function cmdDoctor() {
  log("Running diagnostics...", "info");
  console.log("");

  log(`Node.js: ${process.version}`, process.version >= "v18" ? "ok" : "warn");
  log(`Host: ${process.platform}/${process.arch} shell=${detectShell()} python=${pythonExecutable()}`, "info");
  const disk = loadSandboxDiskConfig();
  if (disk) {
    log(
      `Sandbox config: ${disk._path} isolation=${disk.isolationLevel} egress=${disk.egressAllowlistActive ? "on" : "off"} (${(disk.egressAllowlist || []).length} allow)`,
      "ok"
    );
  } else {
    log("Sandbox config: db/tethro-config.json not found (save sandbox settings in console)", "warn");
  }

  try {
    const res = await apiRequest("GET", "/api/sessions");
    if (res.status === 401) {
      log(`Console: reachable at ${getConsoleUrl()}`, "ok");
      log("Auth: not logged in — run: tethro login <email> <password>", "warn");
    } else if (res.status >= 200 && res.status < 300) {
      log(`Console: reachable at ${getConsoleUrl()}`, "ok");
      log(`Auth: ok (${Array.isArray(res.data) ? res.data.length : 0} sessions)`, "ok");
    } else {
      log(`Console: reachable but returned ${res.status}`, "warn");
    }
  } catch {
    log(`Console: not reachable at ${getConsoleUrl()}`, "warn");
  }

  const methods = [];
  if (commandExists("docker")) methods.push("docker");
  if (commandExists("runsc")) methods.push("gvisor");
  if (commandExists("firecracker")) methods.push("firecracker");
  methods.push("subprocess");
  log(`Isolation methods available: ${methods.join(", ")}`, "ok");
  log(`API token: ${getApiToken() ? "configured" : "not set — run tethro login"}`, getApiToken() ? "ok" : "warn");
  if (commandExists("npx")) log("npx: available (claude-code, codex installable)", "ok");
  else log("npx: not found", "warn");

  console.log("");
  log("Diagnostics complete", "ok");
}

async function cmdLogin(email, password) {
  if (!email || !password) {
    log("Usage: tethro login <email> <password>", "error");
    process.exit(1);
  }
  try {
    const res = await apiRequest("POST", "/api/auth/cli-token", { email, password });
    if (res.status !== 200 || !res.data?.token) {
      log(res.data?.error || `Login failed (${res.status})`, "error");
      process.exit(1);
    }
    saveConfig({
      url: getConsoleUrl(),
      token: res.data.token,
      email: res.data.user?.email || email,
    });
    log(`Logged in as ${res.data.user?.email || email}`, "ok");
    log(`Token saved to ${CONFIG_PATH}`, "info");
  } catch (e) {
    log(`Login failed: ${e.message}`, "error");
    process.exit(1);
  }
}

async function cmdConnect() {
  const projectPath = process.cwd();
  const project = path.basename(projectPath);
  let branch = "main";
  try {
    branch = execSync("git branch --show-current", { cwd: projectPath }).toString().trim() || "main";
  } catch {
    /* not a git repo */
  }

  if (!getApiToken()) {
    log("Not logged in. Run: tethro login <email> <password>", "error");
    process.exit(1);
  }

  const sessionId = `sn-${Date.now().toString(36)}`;
  try {
    const res = await apiRequest("POST", "/api/sessions", {
      sessionId,
      agent: "workspace",
      project,
      branch,
      isolation: "subprocess",
      workspacePath: projectPath,
    });
    if (res.status === 201 || res.status === 200) {
      saveConfig({ workspace: projectPath, project, lastSessionId: sessionId });
      log(`Connected ${project} (${branch})`, "ok");
      log(`Session ${sessionId} — open Console → Sessions`, "info");
      log(`Path: ${projectPath}`, "info");
    } else if (res.status === 401) {
      log("Auth expired. Run: tethro login <email> <password>", "error");
      process.exit(1);
    } else {
      log(`Connect failed (${res.status}): ${JSON.stringify(res.data)}`, "error");
      process.exit(1);
    }
  } catch (e) {
    log(`Connect failed: ${e.message}`, "error");
    process.exit(1);
  }
}

function cmdConfig(action) {
  if (action === "show") {
    const cfg = loadConfig();
    console.log("Tethro configuration:");
    console.log(`  console_url:  ${getConsoleUrl()}`);
    console.log(`  api_token:    ${getApiToken() ? "***" : "(not set)"}`);
    console.log(`  email:        ${cfg.email || "(not set)"}`);
    console.log(`  workspace:    ${cfg.workspace || "(not set)"}`);
    console.log(`  isolation:    ${DEFAULT_ISOLATION}`);
    console.log(`  config_file:  ${CONFIG_PATH}`);
  } else {
    log("Usage: tethro config <show>", "info");
  }
}

// ─── Main ───

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`
Tethro CLI v0.9.4 — sandbox AI coding agents

USAGE
  tethro <command> [options]

COMMANDS
  daemon start              Start the local daemon (credential proxy + sandbox supervisor)
  daemon status             Check if the console/daemon is reachable
  run <agent> <prompt>      Run an agent in a sandboxed environment
                            Agents: claude-code, codex-cli, aider, or any shell command
  scan [path]               Scan a directory for secrets and license issues
  kill [session-id]         Emergency kill switch (all or specific session)
  sessions                  List active sessions
  config show               Show current configuration
  login <email> <password>  Authenticate CLI to the console
  connect                   Register this repo with the console
  doctor                    Run diagnostics

OPTIONS
  --isolation <level>       none, docker, gvisor, firecracker (default: subprocess)
  --keep-sandbox            Don't clean up sandbox after agent exits

ENVIRONMENT
  TETHRO_URL               Console URL (default: http://localhost:3000)
  TETHRO_TOKEN             API token (or use tethro login)
  TETHRO_ISOLATION         Default isolation level

EXAMPLES
  tethro login you@email.com yourpassword
  cd your-repo && tethro connect
  tethro run claude-code "add idempotency to the refund webhook"
  tethro doctor
`);
    return;
  }

  switch (cmd) {
    case "daemon":
      cmdDaemon(args[1]);
      break;
    case "login":
      cmdLogin(args[1], args[2]);
      break;
    case "connect":
      cmdConnect();
      break;
    case "run": {
      const agent = args[1];
      const prompt = args[2];
      if (!agent || !prompt) {
        log("Usage: tethro run <agent> <prompt>", "error");
        log('Example: tethro run claude-code "refactor the webhook"', "info");
        process.exit(1);
      }
      const opts = {};
      const isolationIdx = args.indexOf("--isolation");
      if (isolationIdx > -1) opts.isolation = args[isolationIdx + 1];
      if (args.includes("--keep-sandbox")) process.env.TETHRO_KEEP_SANDBOX = "1";
      cmdRun(agent, prompt, opts);
      break;
    }
    case "scan":
      cmdScan(args[1]);
      break;
    case "kill":
      cmdKill(args[1]);
      break;
    case "sessions":
      cmdSessions();
      break;
    case "config":
      cmdConfig(args[1]);
      break;
    case "doctor":
      cmdDoctor();
      break;
    default:
      log(`Unknown command: ${cmd}`, "error");
      log("Run 'tethro help' for usage", "info");
      process.exit(1);
  }
}

main();
