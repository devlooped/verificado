#!/usr/bin/env node
// Local stdio MCP server that forwards every message to Vercel's remote MCP server
// (https://mcp.vercel.com), signed in with the login of the Vercel CLI.
//
// The CLI keeps its OAuth tokens in auth.json and refreshes the access token only once it
// has expired, on its next API call. Before each request this proxy reads the current token;
// when it has expired (or the server rejects it), it runs a cheap authenticated CLI command
// so the CLI refreshes and saves new tokens, then reads the file again. No token is stored
// anywhere else, and no browser is ever needed while the CLI login is valid.
//
// Environment overrides:
//   VERCEL_MCP_URL    upstream MCP endpoint (default https://mcp.vercel.com)
//   VERCEL_AUTH_FILE  path of the CLI's auth.json (default: the CLI's data folder)
//   VERCEL_CLI        command that runs the Vercel CLI (default: vercel)

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const UPSTREAM = process.env.VERCEL_MCP_URL || "https://mcp.vercel.com";
const AUTH_FILE = process.env.VERCEL_AUTH_FILE || defaultAuthFile();
const VERCEL_CLI = process.env.VERCEL_CLI || "vercel";
const EXPIRY_MARGIN_SECONDS = 30;
const CLI_TIMEOUT_MS = 60_000;

let sessionId;
let protocolVersion;
let refreshing;

function log(message) {
  process.stderr.write(`[vercel-mcp-proxy] ${message}\n`);
}

function defaultAuthFile() {
  const home = os.homedir();
  let dataDir;
  if (process.platform === "win32") {
    dataDir = path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "com.vercel.cli", "Data");
  } else if (process.platform === "darwin") {
    dataDir = path.join(home, "Library", "Application Support", "com.vercel.cli");
  } else {
    dataDir = path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "com.vercel.cli");
  }
  return path.join(dataDir, "auth.json");
}

async function readAuth() {
  try {
    return JSON.parse(await readFile(AUTH_FILE, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the Vercel CLI login at ${AUTH_FILE} (${error.message}). Run \`vercel login\`.`);
  }
}

const nowSeconds = () => Date.now() / 1000;
const isExpiring = (auth) =>
  typeof auth.expiresAt === "number" && auth.expiresAt - EXPIRY_MARGIN_SECONDS <= nowSeconds();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs an authenticated CLI call; the CLI refreshes an expired access token first and saves it.
function runCliRefresh() {
  return new Promise((resolve) => {
    const args = ["api", "/v2/user", "--silent", "--non-interactive"];
    // On Windows the CLI is a .cmd/.ps1 shim, which only a shell can start.
    const options = { stdio: ["ignore", "ignore", "pipe"], windowsHide: true };
    const child =
      process.platform === "win32"
        ? spawn(`${VERCEL_CLI} ${args.join(" ")}`, { ...options, shell: true })
        : spawn(VERCEL_CLI, args, options);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      log(`Could not run \`${VERCEL_CLI}\`: ${error.message}`);
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) log(`\`${VERCEL_CLI} ${args.join(" ")}\` exited with ${code}: ${stderr.trim().slice(-500)}`);
      resolve();
    });
  });
}

async function refreshThroughCli() {
  const auth = await readAuth();
  // The CLI only refreshes a token that has already expired: wait out the last seconds.
  if (typeof auth.expiresAt === "number") {
    const waitMs = (auth.expiresAt - nowSeconds() + 1) * 1000;
    if (waitMs > 0 && waitMs <= (EXPIRY_MARGIN_SECONDS + 1) * 1000) await sleep(waitMs);
  }
  log("Refreshing the Vercel CLI login.");
  await runCliRefresh();
}

// Returns a usable access token; `rejected` is a token the server has just refused.
async function getToken(rejected) {
  let auth = await readAuth();
  if (auth.token && auth.token !== rejected && !isExpiring(auth)) return auth.token;

  refreshing ??= refreshThroughCli().finally(() => (refreshing = undefined));
  await refreshing;

  auth = await readAuth();
  if (!auth.token || auth.token === rejected || (typeof auth.expiresAt === "number" && auth.expiresAt <= nowSeconds())) {
    throw new Error("The Vercel CLI login could not be refreshed. Run `vercel login`, then retry.");
  }
  return auth.token;
}

function post(body, token) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
  return fetch(UPSTREAM, { method: "POST", headers, body });
}

function emit(message) {
  if (message?.result?.protocolVersion && message.result.serverInfo) protocolVersion = message.result.protocolVersion;
  process.stdout.write(JSON.stringify(message) + "\n");
}

function emitAll(payload) {
  for (const message of Array.isArray(payload) ? payload : [payload]) emit(message);
}

async function relaySse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) emitAll(JSON.parse(data));
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      flush(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
}

function requestIds(payload) {
  return (Array.isArray(payload) ? payload : [payload])
    .filter((message) => message && message.method && message.id !== undefined)
    .map((message) => message.id);
}

async function forward(line) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  try {
    let token = await getToken();
    let response = await post(line, token);
    if (response.status === 401) {
      await response.body?.cancel();
      token = await getToken(token);
      response = await post(line, token);
    }

    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) sessionId = newSessionId;

    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Vercel MCP answered HTTP ${response.status}: ${text}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream") && response.body) {
      await relaySse(response.body);
    } else if (contentType.includes("application/json")) {
      const text = await response.text();
      if (text.trim()) emitAll(JSON.parse(text));
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    log(error.message);
    for (const id of requestIds(payload)) {
      emit({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
    }
  }
}

const pending = new Set();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  const task = forward(line).finally(() => pending.delete(task));
  pending.add(task);
});
input.on("close", async () => {
  await Promise.allSettled([...pending]);
  if (sessionId) {
    try {
      const token = await getToken();
      await fetch(UPSTREAM, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Best effort: the server expires sessions on its own.
    }
  }
  process.exit(0);
});
