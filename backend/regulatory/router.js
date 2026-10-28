const express = require('express');
const { requirePermission } = require('../auth/policy');
const { RegulatoryService, RegulatoryError } = require('./service');

function createRegulatoryRouter({ store, auth }) {
  const router = express.Router(); const service = new RegulatoryService({ store });
  router.use((request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.use(auth.sessionMiddleware, auth.requireAuthentication, requirePermission('regulatory:summary'));
  router.get('/summary', async (request, response) => response.json(await service.summary()));
  router.use((error, request, response, next) => error instanceof RegulatoryError ? response.status(error.status).json({ error: error.message }) : next(error));
  return router;
}
module.exports = { createRegulatoryRouter };
