const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { requirePermission, requireInstitution } = require('../auth/policy');
const { VerificationService } = require('./service');
const { VerificationError } = require('./crypto');

function createVerificationRouter({ store, auth, verificationLimit = 60, mutationLimit = 20, ...options }) {
  const router = express.Router();
  const service = new VerificationService({ store, ...options });
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (Object.keys(request.query).length) return next(new VerificationError(400, 'Query parameters are not supported'));
    return next();
  });
  const limiter = limit => rateLimit({ windowMs: 15 * 60 * 1000, limit,
    standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many verification requests; try later' } });
  // Public read-only check: no cookies, session, CSRF or record browsing required.
  router.post('/verify', limiter(verificationLimit), async (request, response) => response.json(await service.verify(request.body)));
  router.use(auth.sessionMiddleware, auth.requireAuthentication, auth.requireCsrf,
    requireInstitution(request => request.user.institutionId), limiter(mutationLimit));
  router.post('/issue', requirePermission('verification:issue:own'),
    async (request, response) => response.status(201).json(await service.issue(request.user, request.body)));
  router.post('/revoke', requirePermission('verification:revoke:own'),
    async (request, response) => response.json(await service.revoke(request.user, request.body)));
  router.use((error, request, response, next) => error instanceof VerificationError
    ? response.status(error.status).json({ error: error.message }) : next(error));
  return router;
}

module.exports = { createVerificationRouter };
