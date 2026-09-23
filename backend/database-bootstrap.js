function resolveInitialDatabase(persistedDatabases, dependencies) {
  const { createDefaultDatabase, normalizeDatabase } = dependencies;
  if (Array.isArray(persistedDatabases) && persistedDatabases.length > 0) {
    return { database: normalizeDatabase(persistedDatabases[0]), created: false };
  }
  return { database: normalizeDatabase(createDefaultDatabase()), created: true };
}

module.exports = { resolveInitialDatabase };
