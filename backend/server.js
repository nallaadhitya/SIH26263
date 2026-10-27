require('dotenv').config();

const express = require('express');
const { createStorage } = require('./storage');
const { StorageError } = require('./storage/mysql-store');
const { createAuth } = require('./auth');
const { createStudentRouter } = require('./students/router');
const { createComplianceRouter } = require('./compliance/router');
const { createMlRouter } = require('./ml/router');
const { createVerificationRouter } = require('./verification/router');
const { AccessError } = require('./auth/policy');

function createApp({ store = createStorage(), authOptions = {}, studentOptions = {}, complianceOptions = {}, mlOptions = {}, verificationOptions = {} } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (request, response) => {
    response.status(200).json({ status: 'ok', service: 'eduverify-backend' });
  });

  const auth = createAuth({ store, ...authOptions });
  app.use('/api/auth', auth.router);
  app.use('/api/v1/students', createStudentRouter({ store, auth, ...studentOptions }));
  app.use('/api/v1/compliance', createComplianceRouter({ store, auth, ...complianceOptions }));
  app.use('/api/v1/ml', createMlRouter({ store, auth, ...mlOptions }));
  app.use('/api/v1/verification', createVerificationRouter({ store, auth, ...verificationOptions }));

  app.use((request, response) => {
    response.status(404).json({ error: 'Route not found' });
  });

  app.use((error, request, response, next) => {
    if (error instanceof StorageError) return response.status(error.status).json({error:error.message});
    if (error instanceof AccessError) return response.status(error.status).json({ error: error.message });
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return response.status(400).json({ error: 'Invalid JSON request body' });
    }

    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'Request body is too large' });
    }

    return response.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT, 10) || 5000;
  (async()=>{
    const store=createStorage();
    try {
      if(store.ready)await store.ready();
      const server=createApp({store}).listen(port,'127.0.0.1',()=>console.log(`EduVerify backend listening on port ${port}`));
      const stop=()=>server.close(async()=>{if(store.close)await store.close();process.exit(0);});
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
    } catch {if(store.close)await store.close();throw new Error('Storage startup failed');}
  })().catch(()=>{console.error('Backend startup failed. Configure storage explicitly and apply database migrations.');process.exitCode=1;});
}

module.exports = { createApp };
