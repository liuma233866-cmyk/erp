"use strict";

const { CentralCatalogService, createPublicId, normalizeCanonicalSku, normalizeVariantAttributes, productSnapshot } = require("./catalogService");
const { MysqlCentralCatalogRepository } = require("./mysqlCatalogRepository");
const { createCentralController } = require("./centralController");

module.exports = {
  CentralCatalogService,
  MysqlCentralCatalogRepository,
  createCentralController,
  createPublicId,
  normalizeCanonicalSku,
  normalizeVariantAttributes,
  productSnapshot
};
