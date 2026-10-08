const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config/env');
const logger = require('./config/logger');

const uploadRoute = require('./api/routes/upload');
const connectionsRoute = require('./api/routes/connections');
const datasetsRoute = require('./api/routes/datasets');
const schemaRoute = require('./api/routes/schema');
const chatRoute = require('./api/routes/chat');
const healthRoute = require('./api/routes/health');
const toolsRoute = require('./api/routes/tools');
const authRoute = require('./api/routes/auth');
const adminRoute = require('./api/routes/admin');
const { errorHandler, notFoundHandler } = require('./api/middleware/errorHandler');

/**
 * Builds a fully-configured Express app WITHOUT starting an HTTP listener.
 * index.js (the real entrypoint) calls app.listen() on this; tests import
 * this directly and drive it with their own ephemeral listener instead,
 * so the test suite never fights over a fixed port.
 */
function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  if (config.env !== 'test') {
    app.use(morgan(config.env === 'development' ? 'dev' : 'combined', { stream: logger.morganStream }));
  }

  app.use('/api/upload', uploadRoute);
  app.use('/api/connections', connectionsRoute);
  app.use('/api/datasets', datasetsRoute);
  app.use('/api/schema', schemaRoute);
  app.use('/api/chat', chatRoute);
  app.use('/api/health', healthRoute);
  app.use('/api/tools', toolsRoute);
  app.use('/api/auth', authRoute);
  app.use('/api/admin', adminRoute);
  app.use('/api/analytics', require('./api/routes/analytics'));
  app.use('/api/policies', require('./api/routes/policies'));
  app.use('/api/knowledge', require('./api/routes/knowledge'));
  app.use('/api/actions', require('./api/routes/actions'));
  app.use('/api/preferences', require('./api/routes/preferences'));
  app.use('/api/traces', require('./api/routes/traces'));

  app.get('/', (req, res) => {
    res.json({ name: 'CogniCore API', version: '1.0.0', phase: 'Phase 7 - Production' });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
