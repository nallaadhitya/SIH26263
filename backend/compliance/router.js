const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { requirePermission, requireInstitution } = require('../auth/policy');
const { ComplianceService, ComplianceError } = require('./service');

function createComplianceRouter({ store, auth, now, evaluationLimit = 10 }) {
  const router = express.Router();
  const service = new ComplianceService({ store, now });
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.use(auth.sessionMiddleware, auth.requireAuthentication, auth.requireCsrf);
  router.use(requireInstitution((request) => request.user.institutionId));
  router.post('/evaluate', requirePermission('compliance:evaluate:own'),
    rateLimit({ windowMs: 15 * 60 * 1000, limit: evaluationLimit,
      standardHeaders: 'draft-8', legacyHeaders: false,
      message: { error: 'Too many compliance evaluations; try again later' } }),
    async (request, response) => {
      if (Object.keys(request.query).length) throw new ComplianceError(400, 'Evaluation does not accept query parameters');
      response.json(await service.evaluate(request.user, request.body));
    });
  router.get('/findings', requirePermission('compliance:read:own'),
    async (request, response) => response.json(await service.list(request.user, request.query)));
  router.get('/findings/:id', requirePermission('compliance:read:own'),
    async (request, response) => response.json(await service.detail(request.user, request.params.id, request.query)));
  router.get('/summary', requirePermission('compliance:read:own'),
    async (request, response) => response.json(await service.summary(request.user, request.query)));
  router.use((error, request, response, next) => {
    if (error instanceof ComplianceError) return response.status(error.status).json({ error: error.message });
    return next(error);
  });
  return router;
}

module.exports = { createComplianceRouter };
