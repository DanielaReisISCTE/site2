'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, emailConfig, validate } = require('../server');

test('email configuration is inactive without secrets', () => {
  assert.equal(emailConfig({}).active, false);
});

test('contact fields are validated', () => {
  assert.ok(validate({ name: 'A', email: 'x', message: 'curta' }).error);
  assert.deepEqual(validate({ name: 'Ana Silva', email: 'ana@empresa.pt', message: 'Automatizar o relatório mensal de vendas.' }).value.email, 'ana@empresa.pt');
});

test('status and delivery work with an injected mail transport', async () => {
  let sent;
  const env = { GMAIL_USER: 'sender@example.com', GMAIL_APP_PASSWORD: 'secret', CONTACT_TO: 'owner@example.com' };
  const server = createServer({ env, transportFactory: () => ({ sendMail: async mail => { sent = mail; } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await fetch(base + '/api/contact/status').then(r => r.json());
  assert.equal(status.active, true);
  const response = await fetch(base + '/api/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ana Silva', email: 'ana@empresa.pt', message: 'Automatizar o relatório mensal de vendas.', website: '' }) });
  assert.equal(response.status, 200);
  assert.equal(sent.to, 'owner@example.com');
  server.close();
});
