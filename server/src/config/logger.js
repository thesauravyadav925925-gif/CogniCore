/**
 * LOGGER
 * A deliberately small wrapper around console.* that adds timestamps and
 * levels. This is NOT a production observability stack - there's no log
 * shipping, no structured JSON output, no APM integration. For a project
 * at this scale that's the right trade-off; DEPLOYMENT.md documents what
 * a real production deployment would add on top of this (see "Monitoring"
 * section there).
 */
function ts() {
  return new Date().toISOString();
}

const logger = {
  info(msg, meta) {
    console.log(`[${ts()}] INFO  ${msg}`, meta ? JSON.stringify(meta) : '');
  },
  warn(msg, meta) {
    console.warn(`[${ts()}] WARN  ${msg}`, meta ? JSON.stringify(meta) : '');
  },
  error(msg, meta) {
    console.error(`[${ts()}] ERROR ${msg}`, meta ? JSON.stringify(meta) : '');
  },
  // morgan's `stream` option wants an object with a .write(str) method.
  morganStream: {
    write(str) {
      process.stdout.write(`[${ts()}] HTTP  ${str}`);
    },
  },
};

module.exports = logger;
