const { hashSessionToken } = require("./security");
const { PERMISSIONS, getEffectiveShopPermissions, isShopRestrictedRole } = require("./permissions");
const { getBearerToken } = require("./http-utils");

function createAuthService(deps) {
  const { getDb, saveDatabase, toPublicUser, respondApi } = deps;
  const sessions = new Map();
  const sessionHashIndex = new Map();

  function persistSession(token, userId, expiresAt) {
    const db = getDb();
    if (!db || typeof db !== "object") return;
    if (!Array.isArray(db.activeSessions)) db.activeSessions = [];
    const tokenHash = hashSessionToken(token);
    const u = String(userId || "").trim();
    const e = Number(expiresAt || 0) || 0;
    if (!tokenHash || !u || !e) return;
    const idx = db.activeSessions.findIndex((s) => String(s?.tokenHash || "") === tokenHash);
    const next = { tokenHash, userId: u, expiresAt: e };
    if (idx >= 0) db.activeSessions[idx] = next;
    else db.activeSessions.push(next);
    sessionHashIndex.set(tokenHash, { userId: u, expiresAt: e });
    saveDatabase();
  }

  function removePersistedSession(token) {
    const db = getDb();
    if (!db || typeof db !== "object" || !Array.isArray(db.activeSessions)) return;
    const tokenHash = hashSessionToken(token);
    if (!tokenHash) return;
    sessionHashIndex.delete(tokenHash);
    const before = db.activeSessions.length;
    // Match hashed rows plus any legacy plaintext rows still present.
    db.activeSessions = db.activeSessions.filter((s) => String(s?.tokenHash || "") !== tokenHash && String(s?.token || "") !== token);
    if (db.activeSessions.length !== before) saveDatabase();
  }

  // Requests are authorized by the in-memory sessions Map (live logins) or, after
  // a restart, by the sessionHashIndex: the presented bearer token is hashed and
  // compared against the SHA-256 hashes persisted in the database, so sessions
  // survive restarts without ever storing plaintext tokens. Legacy plaintext rows
  // from before the hashing change are restored once and migrated to hashed storage.
  function hydrateSessionsFromDatabase() {
    sessions.clear();
    sessionHashIndex.clear();
    const db = getDb();
    const list = Array.isArray(db?.activeSessions) ? db.activeSessions : [];
    const now = Date.now();
    const alive = [];
    for (const row of list) {
      const userId = String(row?.userId || "").trim();
      const expiresAt = Number(row?.expiresAt || 0) || 0;
      if (!userId || expiresAt <= now) continue;
      const tokenHash = String(row?.tokenHash || "").trim();
      if (tokenHash) {
        sessionHashIndex.set(tokenHash, { userId, expiresAt });
        alive.push({ tokenHash, userId, expiresAt });
        continue;
      }
      const legacyToken = String(row?.token || "").trim();
      if (legacyToken) {
        sessions.set(legacyToken, { userId, expiresAt });
        alive.push({ tokenHash: hashSessionToken(legacyToken), userId, expiresAt });
      }
    }
    if (!Array.isArray(db?.activeSessions) || alive.length !== list.length) {
      db.activeSessions = alive;
      saveDatabase();
    }
  }

  function findUserByUsername(username) {
    const db = getDb();
    return (Array.isArray(db?.users) ? db.users : []).find(
      (user) => String(user?.username || "").trim().toLowerCase() === String(username || "").trim().toLowerCase()
    ) || null;
  }

  function findUserById(userId) {
    const db = getDb();
    return (Array.isArray(db?.users) ? db.users : []).find(
      (user) => String(user?.id || "").trim() === String(userId || "").trim()
    ) || null;
  }

  function getSessionFromRequest(req) {
    const token = getBearerToken(req);
    if (!token) {
      return { ok: false, user: null };
    }

    const session = sessions.get(token) || sessionHashIndex.get(hashSessionToken(token));
    if (!session) {
      return { ok: false, user: null };
    }
    if (Date.now() > session.expiresAt) {
      sessions.delete(token);
      removePersistedSession(token);
      return { ok: false, user: null };
    }

    const user = findUserById(session.userId);
    if (!user) {
      sessions.delete(token);
      removePersistedSession(token);
      return { ok: false, user: null };
    }

    return {
      ok: true,
      user: toPublicUser(user)
    };
  }

  function requireAuth(req, res, auditMeta) {
    const sessionData = getSessionFromRequest(req);
    if (!sessionData.ok || !sessionData.user) {
      respondApi(req, res, null, auditMeta, 401, { message: "Unauthorized" });
      return { ok: false };
    }
    return { ok: true, user: sessionData.user };
  }

  function checkPermission(user, action) {
    const target = findUserById(user.id) || user;
    const set = PERMISSIONS[target.role];
    if (!set) return false;
    if (action === "shop.read" || action === "shop.create" || action === "shop.delete" || action === "shop.toggle") {
      if (isShopRestrictedRole(target.role)) return false;
      const p = getEffectiveShopPermissions(target);
      if (action === "shop.read") return p.shopRead;
      if (action === "shop.create") return p.shopCreate;
      if (action === "shop.delete") return p.shopDelete;
      if (action === "shop.toggle") return p.shopToggle;
    }
    return set.has(action);
  }

  return {
    sessions,
    sessionHashIndex,
    persistSession,
    removePersistedSession,
    hydrateSessionsFromDatabase,
    findUserByUsername,
    findUserById,
    getSessionFromRequest,
    requireAuth,
    checkPermission
  };
}

module.exports = { createAuthService };
