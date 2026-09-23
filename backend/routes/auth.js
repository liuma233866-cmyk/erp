// 从 server.js 拆出的路由注册表（auth-session 域）。

function createAuthRoutes(deps) {
  const { authService, respondApi, getDb, parseJsonBody, maskSensitive, checkRateLimit, loginRateBuckets, LOGIN_RATE_LIMIT_WINDOW_MS, LOGIN_RATE_LIMIT_MAX, validateLoginCredentials, verifyPassword, hashPassword, LEGACY_PASSWORD_SALT, createPasswordHash, saveDatabase, crypto, TOKEN_TTL_MS, buildSessionCookie, toPublicUser, getBearerToken, normalizeCompanyName, normalizeCompanyId, getEffectiveShopPermissions, normalizeShopAssignments, hashSessionToken } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/register" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            console.warn("Blocked /api/register request", {
              method: req.method,
              referer: req.headers.referer || "",
              origin: req.headers.origin || "",
              userAgent: req.headers["user-agent"] || "",
              remoteAddress: req.socket?.remoteAddress || ""
            });
            respondApi(req, res, null, { ...auditBase, actionType: "create", resourceType: "user" }, 403, { message: "Public register is disabled" });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/login" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const body = await parseJsonBody(req);
            auditBase.actionType = "login";
            auditBase.resourceType = "session";
            auditBase.requestBodyMasked = maskSensitive(body);
        
            const username = String(body.username || "").trim();
            const password = String(body.password || "");
            const loginRateResult = checkRateLimit(loginRateBuckets, `${clientIp}:login:${username || "-"}`, LOGIN_RATE_LIMIT_WINDOW_MS, LOGIN_RATE_LIMIT_MAX);
            if (!loginRateResult.ok) {
              res.setHeader("Retry-After", String(Math.max(1, Math.ceil((loginRateResult.retryAfterMs || LOGIN_RATE_LIMIT_WINDOW_MS) / 1000))));
              respondApi(req, res, null, auditBase, 429, { message: "Too many login attempts, please retry later" });
              return;
            }
        
            const validation = validateLoginCredentials(username, password);
            if (!validation.ok) {
              respondApi(req, res, null, auditBase, 400, { message: validation.message });
              return;
            }
        
            const user = authService.findUserByUsername(username);
            if (!user || !verifyPassword(user, password)) {
              respondApi(req, res, null, auditBase, 401, { message: "Invalid username or password" });
              return;
            }
            // Re-hash legacy records (fixed global salt) and hashes created with the old
            // PBKDF2 iteration count using the current parameters.
            if (!user.passwordSalt || user.passwordHash !== hashPassword(password, user.passwordSalt || LEGACY_PASSWORD_SALT)) {
              const upgraded = createPasswordHash(password);
              user.passwordSalt = upgraded.passwordSalt;
              user.passwordHash = upgraded.passwordHash;
              saveDatabase();
            }
        
            const token = crypto.randomBytes(32).toString("hex");
            const expiresAt = Date.now() + TOKEN_TTL_MS;
            authService.sessions.set(token, { userId: user.id, expiresAt });
            authService.persistSession(token, user.id, expiresAt);
            res.setHeader("Set-Cookie", buildSessionCookie(token, Math.floor(TOKEN_TTL_MS / 1000)));
        
            respondApi(req, res, user, auditBase, 200, {
              token,
              expiresInSeconds: Math.floor(TOKEN_TTL_MS / 1000),
              user: toPublicUser(user)
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/logout" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const auth = authService.getSessionFromRequest(req);
            const token = getBearerToken(req);
            if (token) {
              authService.sessions.delete(token);
              authService.removePersistedSession(token);
            }
            res.setHeader("Set-Cookie", buildSessionCookie("", 0));
            respondApi(req, res, auth.user, { ...auditBase, actionType: "logout", resourceType: "session" }, 200, { message: "Logged out" });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/profile" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const auth = authService.requireAuth(req, res, auditBase);
            if (!auth.ok) return;
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "user", resourceId: auth.user.id }, 200, {
              id: auth.user.id,
              username: auth.user.username,
              role: auth.user.role,
              companyName: normalizeCompanyName(auth.user.companyName || ""),
              companyId: normalizeCompanyId(auth.user.companyId || ""),
              shopPermissions: getEffectiveShopPermissions(auth.user),
              shopAssignments: normalizeShopAssignments(auth.user.shopAssignments, getDb().shops || [], auth.user)
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/sessions" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "session" });
            if (!auth.ok) return;
            const currentHash = hashSessionToken(getBearerToken(req));
            const rows = Array.isArray(getDb().activeSessions) ? getDb().activeSessions : [];
            const items = rows
              .filter((s) => String(s?.userId || "") === auth.user.id)
              .map((s) => ({
                id: String(s?.tokenHash || ""),
                expiresAt: Number(s?.expiresAt || 0) || 0,
                current: String(s?.tokenHash || "") === currentHash
              }))
              .sort((a, b) => b.expiresAt - a.expiresAt);
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "session" }, 200, { sessions: items });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/sessions/") && method === "DELETE",
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const sessionId = decodeURIComponent(pathname.split("/").pop() || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "delete", resourceType: "session", resourceId: sessionId });
            if (!auth.ok) return;
            if (sessionId === hashSessionToken(getBearerToken(req))) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "session", resourceId: sessionId }, 400, { message: "Cannot revoke current session, use logout instead" });
              return;
            }
            let removed = false;
            for (const [token, session] of authService.sessions.entries()) {
              if (String(session?.userId || "") !== auth.user.id) continue;
              if (hashSessionToken(token) !== sessionId) continue;
              authService.sessions.delete(token);
              authService.removePersistedSession(token);
              removed = true;
            }
            // Sessions restored from the persisted hash index have no plaintext token
            // in the live map; revoke them directly by hash.
            if (!removed && authService.sessionHashIndex.has(sessionId)) {
              const restored = authService.sessionHashIndex.get(sessionId);
              if (String(restored?.userId || "") === auth.user.id) {
                authService.sessionHashIndex.delete(sessionId);
                if (Array.isArray(getDb().activeSessions)) {
                  getDb().activeSessions = getDb().activeSessions.filter((s) => String(s?.tokenHash || "") !== sessionId);
                }
                saveDatabase();
                removed = true;
              }
            }
            if (!removed) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "session", resourceId: sessionId }, 404, { message: "Session not found" });
              return;
            }
            respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "session", resourceId: sessionId }, 200, { message: "Session revoked" });
            return;
      }
    },
  ];
}

module.exports = { createAuthRoutes };
