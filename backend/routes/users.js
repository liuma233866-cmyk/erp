// 从 server.js 拆出的路由注册表（users 域）。

function createUsersRoutes(deps) {
  const { authService, respondApi, getDb, parseJsonBody, maskSensitive, saveDatabase, paginateItems, toPublicUser, makeId, ROLE_ADMIN, ROLE_SUPERVISOR, ALL_ROLES, REGISTER_DEFAULT_ROLE, normalizeCompanyName, normalizeCompanyId, sameCompanyEntity, resolveCompanyIdByName, validateCredentials, createPasswordHash, getRoleShopPermissionDefaults, isShopRestrictedRole, getEffectiveShopPermissions, parseBooleanPermission, normalizeShopAssignments, isDedicatedAdminUser, sqlWriters } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/users" && method === "GET",
      handler: async (req, res, query, auditBase, pathname) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "user" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "user.read")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "user" }, 403, { message: "Forbidden" });
              return;
            }
        
            let users = getDb().users.map((u) => toPublicUser(u));
            if (auth.user.role !== ROLE_ADMIN) {
              users = users.filter((user) => sameCompanyEntity(user, auth.user) || user.id === auth.user.id);
            }
            const paged = paginateItems(users, query, 50);
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "user" }, 200, { items: paged.items, pagination: paged.pagination });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/users" && method === "POST",
      handler: async (req, res, query, auditBase, pathname) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "user.create")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) }, 403, { message: "Forbidden" });
              return;
            }
        
            const username = String(body.username || "").trim();
            const password = String(body.password || "");
            const role = String(body.role || REGISTER_DEFAULT_ROLE).trim();
            const incomingCompanyName = normalizeCompanyName(body.companyName || "");
            const creatorCompanyName = normalizeCompanyName(auth.user.companyName || "");
            const creatorCompanyId = normalizeCompanyId(auth.user.companyId || "");
            let companyName = auth.user.role === ROLE_ADMIN ? incomingCompanyName : creatorCompanyName;
            let companyId = auth.user.role === ROLE_ADMIN
              ? (role === ROLE_SUPERVISOR ? makeId("CMP") : "system")
              : creatorCompanyId;
            // Pair name and id consistently: an admin assigning a plain user to a named
            // company must not store companyName="X" with companyId="system".
            if (auth.user.role === ROLE_ADMIN && role !== ROLE_SUPERVISOR) {
              if (companyName) {
                companyId = resolveCompanyIdByName(companyName);
              } else {
                companyName = "系统";
              }
            }
        
            const validation = validateCredentials(username, password);
            if (!validation.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) }, 400, { message: validation.message });
              return;
            }
            if (!ALL_ROLES.includes(role)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) }, 400, { message: "Invalid role" });
              return;
            }
            if (username.toLowerCase() === "admin") {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) }, 403, { message: "The admin username is reserved for the dedicated IT development account" });
              return;
            }
            if (role === ROLE_ADMIN) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) }, 403, { message: "admin is reserved for the dedicated IT development account" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && role === ROLE_SUPERVISOR) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) }, 403, { message: "Only IT admin can create company admins" });
              return;
            }
            if (auth.user.role === ROLE_ADMIN && role === ROLE_SUPERVISOR && !companyName) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) }, 400, { message: "companyName is required for company admin" });
              return;
            }
            if (role !== ROLE_ADMIN && !companyName) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) }, 400, { message: "companyName is required for every company account" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && !companyId) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) }, 400, { message: "company is not initialized" });
              return;
            }
            if (authService.findUserByUsername(username)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", requestBodyMasked: maskSensitive(body) }, 409, { message: "Username already exists" });
              return;
            }
        
            const credentials = createPasswordHash(password);
            const user = {
              id: makeId("USR"),
              username,
              passwordSalt: credentials.passwordSalt,
              passwordHash: credentials.passwordHash,
              role,
              companyName: role === ROLE_ADMIN ? "系统" : companyName,
              companyId: role === ROLE_ADMIN ? "system" : companyId,
              shopPermissions: getRoleShopPermissionDefaults(role),
              shopAssignments: [],
              createdAt: new Date().toISOString()
            };
        
            getDb().users.push(user);
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "user", resourceId: user.id, requestBodyMasked: maskSensitive(body) }, 201, {
              message: "User created",
              user: toPublicUser(user)
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/users/") && pathname.endsWith("/role") && method === "PUT",
      handler: async (req, res, query, auditBase, pathname) => {
            const body = await parseJsonBody(req);
            const userId = decodeURIComponent(pathname.split("/")[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "user.role.update")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Forbidden" });
              return;
            }
        
            const nextRole = String(body.role || "").trim();
            if (!ALL_ROLES.includes(nextRole)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 400, { message: "Invalid role" });
              return;
            }
        
            if (userId === auth.user.id && nextRole !== ROLE_ADMIN) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 400, { message: "Cannot downgrade yourself" });
              return;
            }
        
            const user = getDb().users.find((u) => u.id === userId);
            if (!user) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 404, { message: "User not found" });
              return;
            }
            if (isDedicatedAdminUser(user) && nextRole !== ROLE_ADMIN) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "The dedicated admin IT account cannot be downgraded" });
              return;
            }
            if (nextRole === ROLE_ADMIN && !isDedicatedAdminUser(user)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Only the dedicated admin IT account may use the admin role" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && !sameCompanyEntity(user, auth.user)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Cannot manage users from another company" });
              return;
            }
            if (auth.user.role === ROLE_SUPERVISOR && (user.role === ROLE_ADMIN || user.role === ROLE_SUPERVISOR)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Cannot manage another admin account" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && nextRole === ROLE_SUPERVISOR) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Only IT admin can create company admins" });
              return;
            }
        
            user.role = nextRole;
            user.shopPermissions = getRoleShopPermissionDefaults(nextRole);
            if (nextRole === ROLE_ADMIN) {
              user.companyName = "系统";
              user.companyId = "system";
            } else if (auth.user.role !== ROLE_ADMIN && !normalizeCompanyName(user.companyName || "")) {
              user.companyName = normalizeCompanyName(auth.user.companyName || "");
              user.companyId = normalizeCompanyId(auth.user.companyId || "");
            }
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "role_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 200, {
              message: "Role updated",
              user: toPublicUser(user)
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/users/") && pathname.endsWith("/shop-permissions") && method === "PUT",
      handler: async (req, res, query, auditBase, pathname) => {
            const body = await parseJsonBody(req);
            const userId = decodeURIComponent(pathname.split("/")[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "permission_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "user.shop.permission.update")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "permission_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Forbidden" });
              return;
            }
        
            const user = authService.findUserById(userId);
            if (!user) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "permission_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 404, { message: "User not found" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && !sameCompanyEntity(user, auth.user)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "permission_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Cannot manage users from another company" });
              return;
            }
            if (auth.user.role === ROLE_SUPERVISOR && (user.role === ROLE_ADMIN || user.role === ROLE_SUPERVISOR)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "permission_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Cannot manage another admin account" });
              return;
            }
        
            if (isShopRestrictedRole(user.role)) {
              user.shopPermissions = { shopRead: false, shopCreate: false, shopToggle: false };
              saveDatabase();
              respondApi(req, res, auth.user, { ...auditBase, actionType: "permission_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 200, {
                message: "该角色固定不可见店铺管理",
                user: toPublicUser(user)
              });
              return;
            }
        
            const patch = {};
            if (body.shopRead !== undefined) patch.shopRead = parseBooleanPermission(body.shopRead);
            if (body.shopCreate !== undefined) patch.shopCreate = parseBooleanPermission(body.shopCreate);
            if (body.shopToggle !== undefined) patch.shopToggle = parseBooleanPermission(body.shopToggle);
        
            if (Object.keys(patch).length === 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "permission_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 400, { message: "At least one permission field is required" });
              return;
            }
            if (Object.values(patch).some((v) => v === null)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "permission_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 400, { message: "Permissions must be boolean" });
              return;
            }
        
            const current = getEffectiveShopPermissions(user);
            const next = {
              shopRead: patch.shopRead !== undefined ? patch.shopRead : current.shopRead,
              shopCreate: patch.shopCreate !== undefined ? patch.shopCreate : current.shopCreate,
              shopToggle: patch.shopToggle !== undefined ? patch.shopToggle : current.shopToggle
            };
        
            if ((next.shopCreate || next.shopToggle) && !next.shopRead) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "permission_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 400, { message: "shopRead is required when enabling create/toggle" });
              return;
            }
        
            user.shopPermissions = next;
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "permission_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 200, {
              message: "Shop permissions updated",
              user: toPublicUser(user)
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/users/") && pathname.endsWith("/shop-assignments") && method === "PUT",
      handler: async (req, res, query, auditBase, pathname) => {
            const body = await parseJsonBody(req);
            const userId = decodeURIComponent(pathname.split("/")[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "assignment_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "user.shop.permission.update")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "assignment_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Forbidden" });
              return;
            }
        
            const user = authService.findUserById(userId);
            if (!user) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "assignment_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 404, { message: "User not found" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && !sameCompanyEntity(user, auth.user)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "assignment_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Cannot manage users from another company" });
              return;
            }
            if (auth.user.role === ROLE_SUPERVISOR && (user.role === ROLE_ADMIN || user.role === ROLE_SUPERVISOR)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "assignment_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Cannot manage another admin account" });
              return;
            }
        
            const shopIdsRaw = Array.isArray(body.shopIds) ? body.shopIds : Array.isArray(body.shopAssignments) ? body.shopAssignments : [];
            user.shopAssignments = normalizeShopAssignments(shopIdsRaw, getDb().shops || [], auth.user.role === ROLE_ADMIN ? user : auth.user);
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "assignment_change", resourceType: "user", resourceId: userId, requestBodyMasked: maskSensitive(body) }, 200, {
              message: "Shop assignments updated",
              user: toPublicUser(user)
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/users/") && method === "DELETE",
      handler: async (req, res, query, auditBase, pathname) => {
            const userId = decodeURIComponent(pathname.split("/").pop() || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "delete", resourceType: "user", resourceId: userId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "user.delete")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "user", resourceId: userId }, 403, { message: "Forbidden" });
              return;
            }
        
            if (userId === auth.user.id) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "user", resourceId: userId }, 400, { message: "Cannot delete current user" });
              return;
            }
        
            const targetUser = authService.findUserById(userId);
            if (!targetUser) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "user", resourceId: userId }, 404, { message: "User not found" });
              return;
            }
            if (isDedicatedAdminUser(targetUser)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "user", resourceId: userId }, 403, { message: "The dedicated admin IT account cannot be deleted" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && !sameCompanyEntity(targetUser, auth.user)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "user", resourceId: userId }, 403, { message: "Cannot delete users from another company" });
              return;
            }
            if (auth.user.role === ROLE_SUPERVISOR && (targetUser.role === ROLE_ADMIN || targetUser.role === ROLE_SUPERVISOR)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "user", resourceId: userId }, 403, { message: "Cannot manage another admin account" });
              return;
            }
        
            try {
              await sqlWriters.deleteUserFromSql(userId);
            } catch (error) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "user", resourceId: userId }, 500, { message: "Failed to delete user from database" });
              return;
            }
        
            getDb().users = getDb().users.filter((u) => u.id !== userId);
        
            // Revoke all active sessions of the deleted user.
            for (const [token, session] of [...authService.sessions.entries()]) {
              if (String(session?.userId || "") === userId) {
                authService.sessions.delete(token);
                authService.removePersistedSession(token);
              }
            }
        
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "user", resourceId: userId }, 200, { message: "User deleted" });
            return;
      }
    },
  ];
}

module.exports = { createUsersRoutes };
