function isPrivateIpv4(host) {
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

function isUnsafeIpv6Host(host) {
  // Only treat colon-containing hosts as IPv6 literals; plain domains
  // starting with "fc"/"fd" (e.g. fc2.com) must not be rejected.
  if (!host.includes(":")) return false;
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "::1" || bare === "::") return true;
  if (/^(fc|fd)/.test(bare)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(bare)) return true; // fe80::/10 link-local
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 is normalized by URL to ::ffff:7f00:1)
  const mapped = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mapped) {
    const g1 = parseInt(mapped[1], 16);
    const g2 = parseInt(mapped[2], 16);
    const ipv4 = `${(g1 >> 8) & 0xff}.${g1 & 0xff}.${(g2 >> 8) & 0xff}.${g2 & 0xff}`;
    if (isPrivateIpv4(ipv4)) return true;
  }
  return false;
}

function isSafeExternalHttpUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return false; }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") return false;
  if (isPrivateIpv4(host)) return false;
  if (isUnsafeIpv6Host(host)) return false;
  return true;
}

// Resolve the client IP for rate limiting. X-Forwarded-For is only trusted when
// the server sits behind a reverse proxy that overwrites it; when trusted, the
// LAST entry is the address added by the closest trusted proxy, while earlier
// entries are client-controllable.
function resolveClientIp(forwardedHeader, remoteAddress, trustProxy) {
  const trusted = trustProxy === true || trustProxy === "1";
  if (trusted && typeof forwardedHeader === "string" && forwardedHeader.trim().length > 0) {
    const parts = forwardedHeader.split(",").map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return remoteAddress || "";
}
module.exports = { isSafeExternalHttpUrl, resolveClientIp };
