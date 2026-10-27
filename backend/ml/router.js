const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { requirePermission, requireInstitution } = require('../auth/policy');
const { MlError, MlClient } = require('./client');
const { MlService } = require('./service');

function createMlRouter({ store, auth, client = new MlClient(), now, evaluationLimit = 10 }) {
  const router = express.Router();
  const service = new MlService({ store, client, now });
  router.use((request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.use(auth.sessionMiddleware, auth.requireAuthentication, auth.requireCsrf);
  router.use(requirePermission('ml:evaluate:own'), requireInstitution((request) => request.user.institutionId));
  router.post('/evaluate', rateLimit({ windowMs: 15 * 60 * 1000, limit: evaluationLimit,
    standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many ML requests; try again later' } }),
  async (request, response, next) => {
    if (Object.keys(request.query).length) throw new MlError(400, 'ML evaluation does not accept query parameters');
    request.mlInstitutionId = request.user.institutionId;
    request.mlResult = await service.evaluate(request.user, request.body);
    next();
  }, auth.requireAuthentication, requirePermission('ml:evaluate:own'),
  requireInstitution((request) => request.mlInstitutionId),
  (request, response) => response.json(request.mlResult));
  router.use((error, request, response, next) => {
    if (error instanceof MlError) return response.status(error.status).json({ error: error.message });
    return next(error);
  });
  return router;
}

module.exports = { createMlRouter };
