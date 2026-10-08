/**
 * SCHEMA READER
 * Pulls the raw, dynamically-discovered schema from whatever adapter
 * is backing a dataset. Contains zero domain knowledge.
 */
async function readSchema(adapter) {
  await adapter.connect();
  try {
    const schema = await adapter.getSchema();
    const metadata = await adapter.getMetadata();
    return { schema, metadata };
  } finally {
    await adapter.disconnect();
  }
}

module.exports = { readSchema };
