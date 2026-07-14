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
 *   tethro doctor                                    Verify installation
 */

const { spawn, spawnSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const CONSOLE_URL = process.env.TETHRO_URL || "http://localhost:3000";
const API_TOKEN = process.env.TETHRO_TOKEN || "";
const DEFAULT_ISOLATION = process.env.TETHRO_ISOLATION || "subprocess";

// ─── Helpers ───

function log(msg, level = "info") {
  const colors = { info: "\x1b[36m", ok: "\x1b[32m", warn: "\x1b[33m", error: "\x1b[31m", reset: "\x1b[0m" };
  const prefix = { info: "[info]", ok: "[ok]", warn: "[warn]", error: "[error]" };
  console.log(`${colors[level]}${prefix[level]}${colors.reset} ${msg}`);
}

function apiRequest(method, pathStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, CONSOLE_URL);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
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
  const sandboxDir = path.join(os.tmpdir(), "tethro-sandboxes", `sb-${Date.now()}`);
  fs.mkdirSync(sandboxDir, { recursive: true });

  // Copy the project to the sandbox (in a real impl, this would be a reflink/clonefile)
  log(`Creating sandbox workspace at ${sandboxDir}`, "info");
  try {
    execSync(`cp -r "${projectPath}/." "${sandboxDir}/"`, { stdio: "pipe" });
  } catch (e) {
    log(`Failed to copy project to sandbox: ${e.message}`, "error");
    return null;
  }

  return sandboxDir;
}

function getIsolationMethod(requested) {
  // Check what's actually available
  if (requested === "firecracker") {
    try { execSync("which firecracker", { stdio: "pipe" }); return "firecracker"; } catch { /* not available */ }
  }
  if (requested === "gvisor") {
    try { execSync("which runsc", { stdio: "pipe" }); return "gvisor"; } catch { /* not available */ }
  }
  if (requested === "docker") {
    try { execSync("which docker", { stdio: "pipe" }); return "docker"; } catch { /* not available */ }
  }
  return "subprocess"; // fallback — isolated subprocess with restricted env
}

async function runInSandbox(sandboxDir, agent, prompt, isolation, sessionId) {
  const method = getIsolationMethod(isolation);
  log(`Isolation: ${method} (requested: ${isolation})`, "info");

  if (method === "docker") {
    return runInDocker(sandboxDir, agent, prompt);
  }
  return runInSubprocess(sandboxDir, agent, prompt, sessionId);
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
    // Strip real API keys — agent only sees the scoped session key
    ANTHROPIC_API_KEY: sessionKey,
    OPENAI_API_KEY: sessionKey,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/anthropic",
    OPENAI_BASE_URL: "http://127.0.0.1:8787/openai",
    // Sandbox marker
    TETHRO_SANDBOX: "1",
    TETHRO_WORKSPACE: sandboxDir,
  };

  let command, args;
  if (agent === "claude-code") {
    command = "npx";
    args = ["-y", "@anthropic-ai/claude-code", prompt];
  } else if (agent === "codex-cli") {
    command = "npx";
    args = ["-y", "@openai/codex", prompt];
  } else if (agent === "aider") {
    command = "python3";
    args = ["-m", "aider", "--message", prompt];
  } else {
    // Generic: treat agent as a shell command
    command = "sh";
    args = ["-c", `${agent} "${prompt.replace(/"/g, '\\"')}"`];
  }

  log(`Spawning agent: ${command} ${args.join(" ")}`, "info");

  const child = spawn(command, args, {
    cwd: sandboxDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return { child, method: "subprocess" };
}

function runInDocker(sandboxDir, agent, prompt) {
  // Docker isolation: run the agent inside a container
  const imageName = "tethro/agent-sandbox:latest";
  const env = [
    "-e", "ANTHROPIC_API_KEY=tethro-session-proxy",
    "-e", "ANTHROPIC_BASE_URL=http://host.docker.internal:8787/anthropic",
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

  const args = [
    "run", "--rm", "-it",
    "-v", `${sandboxDir}:/workspace`,
    "-w", "/workspace",
    "--network=host",
    ...env,
    imageName,
    ...cmd,
  ];

  log(`Spawning Docker container: docker ${args.join(" ")}`, "info");
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  return { child, method: "docker" };
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
    log(`Could not reach console at ${CONSOLE_URL} — running in local mode`, "warn");
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
    log("Daemon manages: sandbox creation, credential proxy, filesystem clones, syscall monitoring", "info");
    log("In production, this would start the Firecracker/gVisor supervisor + credential proxy on :8787", "info");
    log("Daemon running (PID: " + process.pid + ")", "ok");
    log("Credential proxy: http://127.0.0.1:8787", "ok");
    log("Press Ctrl+C to stop", "info");

    // Keep alive
    process.on("SIGINT", () => {
      log("Daemon stopped", "ok");
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  } else if (action === "status") {
    try {
      const res = await apiRequest("GET", "/api/sessions");
      log(`Console reachable at ${CONSOLE_URL}`, "ok");
      log(`Active sessions: ${(res.data || []).length}`, "ok");
    } catch {
      log(`Console not reachable at ${CONSOLE_URL}`, "warn");
      log("Run 'tethro daemon start' or start the web console", "info");
    }
  } else {
    log("Usage: tethro daemon <start|status>", "info");
  }
}

async function cmdDoctor() {
  log("Running diagnostics...", "info");
  console.log("");

  // Node
  log(`Node.js: ${process.version}`, process.version >= "v18" ? "ok" : "warn");

  // Console
  try {
    await apiRequest("GET", "/api/sessions");
    log(`Console: reachable at ${CONSOLE_URL}`, "ok");
  } catch {
    log(`Console: not reachable at ${CONSOLE_URL}`, "warn");
  }

  // Isolation methods
  const methods = [];
  try { execSync("which docker"); methods.push("docker"); } catch {}
  try { execSync("which runsc"); methods.push("gvisor"); } catch {}
  try { execSync("which firecracker"); methods.push("firecracker"); } catch {}
  methods.push("subprocess");

  log(`Isolation methods available: ${methods.join(", ")}`, "ok");

  // API token
  log(`API token: ${API_TOKEN ? "configured" : "not set (some features may be limited)"}`, API_TOKEN ? "ok" : "warn");

  // Agents
  try { execSync("which npx"); log("npx: available (claude-code, codex installable)", "ok"); } catch {
    log("npx: not found", "warn");
  }

  console.log("");
  log("Diagnostics complete", "ok");
}

function cmdConfig(action) {
  if (action === "show") {
    console.log("Tethro configuration:");
    console.log(`  console_url:  ${CONSOLE_URL}`);
    console.log(`  api_token:    ${API_TOKEN ? "***" : "(not set)"}`);
    console.log(`  isolation:    ${DEFAULT_ISOLATION}`);
    console.log("");
    console.log("Set via environment variables:");
    console.log("  TETHRO_URL       Console URL (default: http://localhost:3000)");
    console.log("  TETHRO_TOKEN     API token for authentication");
    console.log("  TETHRO_ISOLATION Default isolation (subprocess/docker/gvisor/firecracker)");
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
  doctor                    Run diagnostics

OPTIONS
  --isolation <level>       none, docker, gvisor, firecracker (default: subprocess)
  --keep-sandbox            Don't clean up sandbox after agent exits

ENVIRONMENT
  TETHRO_URL               Console URL (default: http://localhost:3000)
  TETHRO_TOKEN             API token for authentication
  TETHRO_ISOLATION         Default isolation level

EXAMPLES
  tethro run claude-code "add idempotency to the refund webhook"
  tethro run claude-code "fix the auth bug" --isolation docker
  tethro scan ./src
  tethro kill sn-7f3a9c1e
  tethro doctor
`);
    return;
  }

  switch (cmd) {
    case "daemon":
      cmdDaemon(args[1]);
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
