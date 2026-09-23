"use strict";

const { ERROR_CODES, V2Error } = require("../core/errorCodes");

function readBearerToken(request) {
  const raw = String(request?.headers?.authorization || request?.headers?.Authorization || "").trim();
  if (!raw) return "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

class AuthAdapter {
  constructor({ verifyToken }) {
    if (typeof verifyToken !== "function") throw new TypeError("verifyToken must be a function");
    this.verifyToken = verifyToken;
  }

  async authenticate(request) {
    const token = readBearerToken(request);
    if (!token) throw new V2Error(ERROR_CODES.AUTH_REQUIRED, "Authentication is required");
    let user;
    try {
      user = await this.verifyToken(token, request);
    } catch (error) {
      throw new V2Error(ERROR_CODES.AUTH_INVALID, "Authentication token is invalid", undefined, { cause: error });
    }
    if (!user || !user.id) throw new V2Error(ERROR_CODES.AUTH_INVALID, "Authentication token is invalid");
    const isPlatformAdmin = user.isPlatformAdmin === true || user.role === "admin" || user.permissions === "*";
    return Object.freeze(isPlatformAdmin ? { ...user, isPlatformAdmin: true } : { ...user });
  }
}

module.exports = { AuthAdapter, readBearerToken };
