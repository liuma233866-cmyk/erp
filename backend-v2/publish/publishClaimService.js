"use strict";
// V2 阶段 2：刊登占用（publish_claims）状态机。
//
// 契约来自 DEVELOPMENT_PRODUCT_PUBLISH_V2.md §12.4：
//   状态值：held / probe_required / released（leased 不是业务状态，租约用 lease_until 表示）
//   - 唯一约束 (company_id, platform, shop_id, business_key) 是并发兜底；唯一冲突时返回已有占用；
//   - 在任何外部刊登请求之前获取占用；
//   - succeeded / 平台明确 failed / 用户取消且确认无外部请求时，才在事务内释放；
//   - external_processing、attempt unknown、超时、Worker 崩溃后的恢复探测期间必须保持 held/probe_required；
//   - 租约到期不等于可安全重试：恢复流程把过期 held 转成 probe_required；
//   - 只有 probe 明确终态或人工确认平台没建商品，才允许从 probe_required 释放。

const { ERROR_CODES, V2Error } = require("../core/errorCodes");
const { parseUtcDate, toMysqlDatetime } = require("../core/dateTime");

const CLAIM_STATUS = Object.freeze({
  HELD: "held",
  PROBE_REQUIRED: "probe_required",
  RELEASED: "released"
});

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

function requireCompanyId(companyId) {
  const value = String(companyId || "").trim();
  if (!value) throw new V2Error(ERROR_CODES.TENANT_REQUIRED, "A company tenant is required");
  return value;
}

function requireText(value, field, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, `${field} is required`);
  if (text.length > maxLength) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, `${field} is too long`);
  return text;
}

// MySQL DATETIME 无时区标记，V2 约定为 UTC；必须用 parseUtcDate 解析，
// 否则 new Date("YYYY-MM-DD HH:mm:ss.SSS") 会按本地时区解释，租约判定会整体偏移。
function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined || value === "") return 0;
  const parsed = parseUtcDate(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLeaseExpired(claim, nowMs) {
  const leaseUntil = toMillis(claim?.leaseUntil);
  if (!leaseUntil) return true;
  return leaseUntil <= nowMs;
}

class PublishClaimService {
  constructor({ repository, clock = () => new Date() } = {}) {
    if (!repository) throw new TypeError("A publish repository is required");
    this.repository = repository;
    this.clock = clock;
  }

  _now() {
    return this.clock();
  }

  _leaseUntil(leaseMs) {
    const ms = Math.max(1000, Number(leaseMs) || DEFAULT_LEASE_MS);
    return toMysqlDatetime(new Date(this._now().getTime() + ms));
  }

  /**
   * 获取占用。返回 reused 表示命中已有占用；leaseExpired / probeRequired 时调用方必须先探测平台现状，
   * 不得直接重新刊登。
   */
  async acquire({ companyId, platform, shopId, businessKey, publishJobId = null, leaseMs = DEFAULT_LEASE_MS } = {}) {
    const tenant = requireCompanyId(companyId);
    const platformName = requireText(platform, "platform", 32).toLowerCase();
    const shop = requireText(shopId, "shopId", 64);
    const key = requireText(businessKey, "businessKey", 255);

    const existing = await this.repository.findClaim(tenant, platformName, shop, key);
    const nowMs = this._now().getTime();
    const now = toMysqlDatetime(this._now());

    if (existing) {
      const status = String(existing.status || "").toLowerCase();
      if (status === CLAIM_STATUS.RELEASED) {
        const reacquired = await this.repository.updateClaim(existing.id, {
          status: CLAIM_STATUS.HELD,
          publishJobId: publishJobId === null ? null : String(publishJobId),
          leaseUntil: this._leaseUntil(leaseMs),
          updatedAt: now
        });
        return { claim: reacquired, reused: false, reacquired: true };
      }
      if (status === CLAIM_STATUS.PROBE_REQUIRED) {
        return { claim: existing, reused: true, probeRequired: true, leaseExpired: false };
      }
      return { claim: existing, reused: true, leaseExpired: isLeaseExpired(existing, nowMs), probeRequired: false };
    }

    const claim = await this.repository.createClaim({
      companyId: tenant,
      platform: platformName,
      shopId: shop,
      businessKey: key,
      publishJobId: publishJobId === null ? null : String(publishJobId),
      status: CLAIM_STATUS.HELD,
      leaseUntil: this._leaseUntil(leaseMs),
      createdAt: now,
      updatedAt: now
    });
    return { claim, reused: false, leaseExpired: false, probeRequired: false };
  }

  /**
   * 续租。占用已不是 held（例如已被恢复流程转为 probe_required）时续租失败，并把状态钉在 probe_required。
   */
  async renew({ companyId, claimId, leaseMs = DEFAULT_LEASE_MS } = {}) {
    requireCompanyId(companyId);
    const id = requireText(claimId, "claimId", 64);
    const claim = await this.repository.findClaimById(id);
    if (!claim) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Publish claim not found", { claimId: id });
    const status = String(claim.status || "").toLowerCase();
    if (status !== CLAIM_STATUS.HELD) {
      const pinned = status === CLAIM_STATUS.PROBE_REQUIRED
        ? claim
        : await this.repository.updateClaim(claim.id, { status: CLAIM_STATUS.PROBE_REQUIRED, updatedAt: toMysqlDatetime(this._now()) });
      return { claim: pinned, renewed: false, probeRequired: true };
    }
    const renewed = await this.repository.updateClaim(claim.id, {
      leaseUntil: this._leaseUntil(leaseMs),
      updatedAt: toMysqlDatetime(this._now())
    });
    return { claim: renewed, renewed: true, probeRequired: false };
  }

  /** 明确进入探测态（例如 attempt 结果 unknown）。 */
  async markProbeRequired({ companyId, claimId } = {}) {
    requireCompanyId(companyId);
    const id = requireText(claimId, "claimId", 64);
    const claim = await this.repository.findClaimById(id);
    if (!claim) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Publish claim not found", { claimId: id });
    const updated = await this.repository.updateClaim(claim.id, {
      status: CLAIM_STATUS.PROBE_REQUIRED,
      updatedAt: toMysqlDatetime(this._now())
    });
    return { claim: updated };
  }

  /**
   * 仅在确认终态后释放。probe_required 的占用也能释放，但调用方必须已确认平台没有产生商品。
   */
  async releaseTerminal({ companyId, claimId } = {}) {
    requireCompanyId(companyId);
    const id = requireText(claimId, "claimId", 64);
    const claim = await this.repository.findClaimById(id);
    if (!claim) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Publish claim not found", { claimId: id });
    const status = String(claim.status || "").toLowerCase();
    if (status === CLAIM_STATUS.RELEASED) return { claim, released: false, alreadyReleased: true };
    const updated = await this.repository.updateClaim(claim.id, {
      status: CLAIM_STATUS.RELEASED,
      leaseUntil: null,
      updatedAt: toMysqlDatetime(this._now())
    });
    return { claim: updated, released: true, alreadyReleased: false };
  }

  /**
   * 恢复流程：把租约过期的 held 占用转成 probe_required（绝不直接释放）。
   */
  async recoverExpiredLeases() {
    const now = this._now();
    const expired = await this.repository.listExpiredHeldClaims(toMysqlDatetime(now));
    const recovered = [];
    for (const claim of Array.isArray(expired) ? expired : []) {
      const updated = await this.repository.updateClaim(claim.id, {
        status: CLAIM_STATUS.PROBE_REQUIRED,
        updatedAt: toMysqlDatetime(now)
      });
      recovered.push(updated || claim);
    }
    return { recovered, count: recovered.length };
  }
}

module.exports = {
  CLAIM_STATUS,
  DEFAULT_LEASE_MS,
  PublishClaimService,
  isLeaseExpired,
  toMillis
};
