#!/usr/bin/env node
// obsidian-vault-mcp - MCP server exposing an Obsidian vault over Streamable HTTP.
// https://github.com/jakergirard/obsidian-vault-mcp (MIT)

import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const VERSION = "1.1.0";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const VAULT = path.resolve(process.env.VAULT_DIR || "/vault");
const DATA = path.resolve(process.env.DATA_DIR || "/data");
const READ_ONLY = /^(1|true|yes)$/i.test(process.env.READ_ONLY || "");
const MAX_READ_BYTES = 1_000_000;
const MAX_SEARCH_CHARS = 15_000;

// --- bearer token -----------------------------------------------------------

function loadToken() {
  if (process.env.MCP_TOKEN && process.env.MCP_TOKEN.trim()) {
    return process.env.MCP_TOKEN.trim();
  }
  const file = path.join(DATA, "mcp_token");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* fall through and generate */
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  console.log(`[mcp] Generated access token (saved to ${file}):`);
  console.log(`[mcp]   ${token}`);
  return token;
}

const TOKEN = loadToken();

function tokenMatches(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function auth(req, res, next) {
  const urlToken = typeof req.params?.token === "string" ? req.params.token.trim() : "";
  if (tokenMatches(urlToken)) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// --- vault helpers ----------------------------------------------------------

function resolveInVault(p) {
  const rel = String(p ?? "").replace(/^[/\\]+/, "");
  const abs = path.resolve(VAULT, rel);
  if (abs !== VAULT && !abs.startsWith(VAULT + path.sep)) {
    throw new Error(`Path escapes the vault: ${p}`);
  }
  return abs;
}

const relToVault = (abs) => path.relative(VAULT, abs) || ".";

function assertWritable() {
  if (READ_ONLY) throw new Error("Server is in read-only mode (READ_ONLY=true).");
}

async function readNote(p) {
  const abs = resolveInVault(p);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) {
    throw new Error(`'${relToVault(abs)}' is a directory. Use list_dir.`);
  }
  if (st.size > MAX_READ_BYTES) {
    throw new Error(
      `File is ${st.size} bytes (limit ${MAX_READ_BYTES}). Use search to locate the section you need.`
    );
  }
  return fsp.readFile(abs, "utf8");
}

function ripgrep(query, scope) {
  const scopeAbs = resolveInVault(scope || "");
  const rel = relToVault(scopeAbs);
  const args = [
    "--fixed-strings",
    "--ignore-case",
    "--line-number",
    "--no-heading",
    "--color", "never",
    "--max-count", "5",
    "--max-filesize", "1M",
    "--max-columns", "250",
    "--",
    query,
    rel,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      "rg",
      args,
      { cwd: VAULT, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err && err.code === 1) return resolve("No matches.");
        if (err) return reject(new Error((stderr || err.message || "").trim() || "search failed"));
        resolve(stdout);
      }
    );
  });
}

// --- MCP server -------------------------------------------------------------

const text = (s) => ({ content: [{ type: "text", text: s }] });
const errText = (e) => ({
  content: [{ type: "text", text: `Error: ${e && e.message ? e.message : e}` }],
  isError: true,
});
const run = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return errText(e);
  }
};

function buildServer() {
  const server = new McpServer({ name: "obsidian-vault-mcp", version: VERSION });

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Read a file from the Obsidian vault. Paths are relative to the vault root, e.g. 'Projects/Plan.md'.",
      inputSchema: { path: z.string().describe("Vault-relative file path") },
    },
    run(async ({ path: p }) => text(await readNote(p)))
  );

  server.registerTool(
    "write_note",
    {
      title: "Write note",
      description:
        "Create or overwrite a file in the vault with the given content. Parent folders are created automatically.",
      inputSchema: {
        path: z.string().describe("Vault-relative file path"),
        content: z.string().describe("Full file content"),
      },
    },
    run(async ({ path: p, content }) => {
      assertWritable();
      const abs = resolveInVault(p);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, "utf8");
      return text(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${relToVault(abs)}`);
    })
  );

  server.registerTool(
    "append_note",
    {
      title: "Append to note",
      description:
        "Append content to the end of a file (created if missing). A newline is inserted before the appended content if the file does not already end with one.",
      inputSchema: {
        path: z.string().describe("Vault-relative file path"),
        content: z.string().describe("Content to append"),
      },
    },
    run(async ({ path: p, content }) => {
      assertWritable();
      const abs = resolveInVault(p);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      let prefix = "";
      try {
        const st = await fsp.stat(abs);
        if (st.size > 0) {
          const fh = await fsp.open(abs, "r");
          const { buffer } = await fh.read(Buffer.alloc(1), 0, 1, st.size - 1);
          await fh.close();
          prefix = buffer.toString("utf8") === "\n" ? "" : "\n";
        }
      } catch {
        /* file does not exist yet */
      }
      await fsp.appendFile(abs, prefix + content, "utf8");
      return text(`Appended ${Buffer.byteLength(content, "utf8")} bytes to ${relToVault(abs)}`);
    })
  );

  server.registerTool(
    "patch_note",
    {
      title: "Patch note",
      description:
        "Replace an exact string in a file. old_str must appear exactly once. Use this for targeted edits like checking off a checkbox.",
      inputSchema: {
        path: z.string().describe("Vault-relative file path"),
        old_str: z.string().describe("Exact string to replace (must be unique in the file)"),
        new_str: z.string().describe("Replacement string"),
      },
    },
    run(async ({ path: p, old_str, new_str }) => {
      assertWritable();
      if (old_str.length === 0) throw new Error("old_str must not be empty.");
      const abs = resolveInVault(p);
      const current = await readNote(p);
      const count = current.split(old_str).length - 1;
      if (count === 0) throw new Error("old_str not found in file.");
      if (count > 1) {
        throw new Error(`old_str matches ${count} times; provide a more specific string.`);
      }
      await fsp.writeFile(abs, current.replace(old_str, new_str), "utf8");
      return text(`Patched ${relToVault(abs)}`);
    })
  );

  server.registerTool(
    "list_dir",
    {
      title: "List directory",
      description:
        "List files and folders in a vault directory. Omit path (or pass '') for the vault root.",
      inputSchema: {
        path: z.string().optional().describe("Vault-relative directory path (default: vault root)"),
      },
    },
    run(async ({ path: p }) => {
      const abs = resolveInVault(p || "");
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      entries.sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
      );
      const lines = entries.map((e) => (e.isDirectory() ? `[DIR]  ${e.name}` : `[FILE] ${e.name}`));
      return text(lines.join("\n") || "(empty)");
    })
  );

  server.registerTool(
    "search",
    {
      title: "Search vault",
      description:
        "Case-insensitive fixed-string search across the vault (ripgrep). Returns 'path:line:text' matches, max 5 per file. Optionally scope to a subdirectory.",
      inputSchema: {
        query: z.string().describe("Text to search for (fixed string, not regex)"),
        path: z.string().optional().describe("Vault-relative directory to scope the search"),
      },
    },
    run(async ({ query, path: p }) => {
      const out = await ripgrep(query, p);
      const clipped =
        out.length > MAX_SEARCH_CHARS ? out.slice(0, MAX_SEARCH_CHARS) + "\n... (truncated)" : out;
      return text(clipped.trim() || "No matches.");
    })
  );

  return server;
}

// --- HTTP wiring (stateless Streamable HTTP) --------------------------------

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, version: VERSION, readOnly: READ_ONLY }));

app.post("/t/:token/mcp", auth, handleMcp);

async function handleMcp(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
app.get("/t/:token/mcp", auth, methodNotAllowed);
app.delete("/t/:token/mcp", auth, methodNotAllowed);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[mcp] obsidian-vault-mcp v${VERSION} listening on :${PORT} (vault: ${VAULT}${READ_ONLY ? ", read-only" : ""})`
  );
});
