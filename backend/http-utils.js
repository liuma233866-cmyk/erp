const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const STATIC_DIR = path.join(__dirname, "..", "frontend");
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "http://127.0.0.1:3000,http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const INCLUDE_RE = /<!--#include\s+file="([^"]+)"\s*-->/g;

function resolveHtmlIncludes(content, baseDir, depth = 0) {
  if (depth > 8) return content;
  return content.replace(INCLUDE_RE, (marker, rel) => {
    const clean = String(rel || "").trim();
    if (!clean || clean.includes("..") || path.isAbsolute(clean)) return marker;
    const target = path.join(baseDir, clean);
    if (!target.startsWith(baseDir + path.sep)) return marker;
    let fragment = "";
    try {
      fragment = fs.readFileSync(target, "utf8");
    } catch {
      return marker;
    }
    fragment = fragment.replace(/\r?\n$/, "");
    return resolveHtmlIncludes(fragment, path.dirname(target), depth + 1);
  });
}

function serveStaticFile(res, pathname) {
  let filePath = pathname;
  if (pathname === "/") {
    filePath = "/landing.html";
  } else if (pathname === "/erp" || pathname === "/erp/" || pathname === "/admin" || pathname === "/admin/") {
    filePath = "/index.html";
  }
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const absPath = path.join(STATIC_DIR, filePath);

  fs.readFile(absPath, (err, content) => {
    if (err) {
      sendJson(res, 404, { message: "Not found" });
      return;
    }

    const ext = path.extname(absPath).toLowerCase();
    const body = ext === ".html" ? resolveHtmlIncludes(String(content), path.dirname(absPath)) : content;
    res.writeHead(200, { "Content-Type": getContentType(ext) });
    res.end(body);
  });
}

function getContentType(ext) {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".pdf":
      return "application/pdf";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let stopped = false;
    req.on("data", (chunk) => {
      if (stopped) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total > maxBytes) {
        stopped = true;
        const error = new Error("Body too large");
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on("end", () => {
      if (stopped) return;
      if (total === 0) {
        resolve({});
        return;
      }
      try {
        // Decode after collecting all chunks so multi-byte UTF-8 characters
        // split across TCP chunks are not corrupted.
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("Invalid JSON");
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function parseRawBody(req, maxBytes = 12e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let stopped = false;
    req.on("data", (chunk) => {
      if (stopped) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        stopped = true;
        const error = new Error("Body too large");
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (stopped) return;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function setApiCorsHeaders(req, res) {
  const origin = String(req.headers.origin || "").trim();
  if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function getBearerToken(req) {
  const auth = String(req?.headers?.authorization || "").trim();
  // RFC 7235 auth schemes are case-insensitive; tolerate any whitespace
  // between the scheme and the token.
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) return String(match[1] || "").trim();
  // Browser clients authenticate via the HttpOnly session cookie instead of a
  // bearer token, so XSS cannot read the credential out of localStorage.
  const cookie = String(req?.headers?.cookie || "");
  const cookieMatch = cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return cookieMatch ? decodeURIComponent(String(cookieMatch[1] || "").trim()) : "";
}

function buildSessionCookie(token, maxAgeSeconds) {
  const value = encodeURIComponent(String(token || ""));
  const parts = [`auth_token=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  parts.push(`Max-Age=${Number(maxAgeSeconds) > 0 ? Math.floor(Number(maxAgeSeconds)) : 0}`);
  return parts.join("; ");
}

function fetchJson(targetUrl) {
  if (typeof fetch === "function") {
    return fetch(targetUrl, { headers: { Accept: "application/json" } })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, data };
      })
      .catch((error) => ({ ok: false, status: 502, data: null, error: String(error) }));
  }

  return new Promise((resolve) => {
    const client = targetUrl.startsWith("https") ? https : http;
    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const req = client.get(targetUrl, { headers: { Accept: "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }
        settle({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
      });
      res.on("error", (err) => settle({ ok: false, status: 502, data: null, error: String(err) }));
    });
    req.on("error", (err) => settle({ ok: false, status: 502, data: null, error: String(err) }));
  });
}

module.exports = {
  buildSessionCookie,
  fetchJson,
  getBearerToken,
  getContentType,
  parseJsonBody,
  parseRawBody,
  sendJson,
  serveStaticFile,
  setApiCorsHeaders
};
