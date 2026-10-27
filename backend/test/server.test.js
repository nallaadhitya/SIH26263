const request = require('supertest');
const { createApp } = require('../server');
const { JsonStore } = require('../storage/json-store');

describe('backend foundation endpoints', () => {
  test('GET /api/health returns service status', async () => {
    const response = await request(createApp({store:new JsonStore()})).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'eduverify-backend' });
  });

  test('unknown routes receive a JSON 404 response', async () => {
    const response = await request(createApp({store:new JsonStore()})).get('/not-a-route');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Route not found' });
  });
});
