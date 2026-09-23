"use strict";

const { ERROR_CODES, V2Error } = require("../core/errorCodes");

class TenantAdapter {
  constructor({ resolveCompanyId } = {}) {
    this.resolveCompanyId = typeof resolveCompanyId === "function"
      ? resolveCompanyId
      : (user) => user?.companyId ?? user?.company_id ?? "";
  }

  resolve(user, requestedCompanyId = "") {
    const companyId = String(this.resolveCompanyId(user) || "").trim();
    if (!companyId) throw new V2Error(ERROR_CODES.TENANT_REQUIRED, "A company tenant is required");
    const requested = String(requestedCompanyId || "").trim();
    if (requested && requested !== companyId && !user?.isPlatformAdmin) {
      throw new V2Error(ERROR_CODES.TENANT_FORBIDDEN, "The user cannot access this company tenant");
    }
    return requested || companyId;
  }
}

module.exports = { TenantAdapter };
