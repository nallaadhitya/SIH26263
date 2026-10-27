const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { requirePermission, requireInstitution } = require('../auth/policy');
const { StudentService, publicStudent } = require('./service');
const { StudentError } = require('./errors');
const { parseCsv, MAX_FILE_BYTES } = require('./csv');

function createStudentRouter({ store, auth, importLimit = 20, now }) {
  const router = express.Router();
  const service = new StudentService({ store, now });
  router.use(auth.sessionMiddleware, auth.requireAuthentication, auth.requireCsrf);
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  // Even list/create/preview operations must pass the central institution policy.
  router.use(requireInstitution((request) => request.user.institutionId));
  const importLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: importLimit,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many import requests; try again later' } });
  const upload = multer({ storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 1 },
    fileFilter: (request, file, callback) => {
      const allowed = file.originalname.toLowerCase().endsWith('.csv')
        && ['text/csv', 'application/csv', 'application/vnd.ms-excel'].includes(file.mimetype);
      callback(allowed ? null : new StudentError(415, 'Upload a CSV file in the file field'), allowed);
    } }).single('file');

  router.post('/import/preview', requirePermission('student:import:own'), importLimiter, upload,
    async (request, response) => {
      if (!request.file) throw new StudentError(400, 'A CSV file is required');
      response.json(await service.preview(request.user, request.sessionID, parseCsv(request.file.buffer)));
    });
  router.post('/import/commit', requirePermission('student:import:own'), importLimiter,
    async (request, response) => response.status(201)
      .json(await service.commit(request.user, request.sessionID, request.body)));
  router.get('/', requirePermission('student:read:own'), async (request, response) => {
    response.json(await service.list(request.user, request.query));
  });
  router.post('/', requirePermission('student:write:own'), async (request, response) => {
    response.status(201).json({ student: await service.save(request.user, request.body) });
  });
  router.param('id', (request, response, next, id) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return next(new StudentError(400, 'Invalid student record ID'));
    }
    return next();
  });
  // Load an institution-filtered record first; cross-institution IDs look absent.
  const loadRecord = async (request, response, next) => {
    request.student = await service.get(request.user, request.params.id);
    next();
  };
  router.get('/:id', requirePermission('student:read:own'), loadRecord,
    requireInstitution((request) => request.student.institutionId),
    (request, response) => response.json({ student: publicStudent(request.student) }));
  router.patch('/:id', requirePermission('student:write:own'), loadRecord,
    requireInstitution((request) => request.student.institutionId), async (request, response) => {
      response.json({ student: await service.save(request.user, request.body, request.params.id) });
    });
  router.use((error, request, response, next) => {
    if (error instanceof StudentError) {
      return response.status(error.status).json({ error: error.message, ...(error.details && { details: error.details }) });
    }
    if (error instanceof multer.MulterError) {
      return response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        .json({ error: 'Invalid CSV upload or upload limit exceeded' });
    }
    return next(error);
  });
  return router;
}

module.exports = { createStudentRouter };
