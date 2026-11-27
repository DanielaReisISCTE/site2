'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, emailConfig, validate, sendResendEmail } = require('../server');

test('email configuration uses only Resend API key and contact destination', () => {
  assert.equal(emailConfig({}).active, false);
  assert.equal(emailConfig({ RESEND_API_KEY: 're_test', CONTACT_TO: 'owner@example.com' }).active, true);
  assert.equal(emailConfig({ GMAIL_USER: 'sender@example.com', GMAIL_APP_PASSWORD: 'secret', CONTACT_TO: 'owner@example.com' }).active, false);
});

test('contact fields and antispam field are validated', () => {
  assert.ok(validate({ name: 'A', email: 'x', message: 'curta', website: '' }).error);
  assert.equal(validate({ name: 'Ana Silva', email: 'ana@empresa.pt', message: 'Automatizar o relatório mensal de vendas.', website: 'spam.example' }).spam, true);
  assert.equal(validate({ name: 'Ana Silva', email: 'ana@empresa.pt', message: 'Automatizar o relatório mensal de vendas.', website: '' }).value.email, 'ana@empresa.pt');
});

test('Resend request uses HTTPS API with the expected headers and payload', async () => {
  let outbound;
  const fetchMock = async (url, options) => {
    outbound = { url, options };
    return { ok: true, status: 200 };
  };

  await sendResendEmail(
    { apiKey: 're_test_secret', to: 'owner@example.com' },
    { replyTo: 'ana@empresa.pt', subject: 'Novo pedido', text: 'Mensagem de teste' },
    fetchMock
  );

  assert.equal(outbound.url, 'https://api.resend.com/emails');
  assert.equal(outbound.options.method, 'POST');
  assert.equal(outbound.options.headers.Authorization, 'Bearer re_test_secret');
  const payload = JSON.parse(outbound.options.body);
  assert.equal(payload.from, 'onboarding@resend.dev');
  assert.deepEqual(payload.to, ['owner@example.com']);
  assert.equal(payload.reply_to, 'ana@empresa.pt');
});

test('status and contact delivery work with an injected fetch and no real request', async () => {
  let outboundCalls = 0;
  const outboundFetchMock = async () => {
    outboundCalls += 1;
    return { ok: true, status: 200 };
  };
  const env = { RESEND_API_KEY: 're_test_secret', CONTACT_TO: 'owner@example.com' };
  const server = createServer({ env, fetchImpl: outboundFetchMock });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const status = await fetch(base + '/api/contact/status').then(response => response.json());
    assert.equal(status.active, true);

    const response = await fetch(base + '/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Ana Silva',
        email: 'ana@empresa.pt',
        message: 'Automatizar o relatório mensal de vendas.',
        website: ''
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(outboundCalls, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Resend API failures return a delivery error without making a real request', async () => {
  const outboundFetchMock = async () => ({ ok: false, status: 403 });
  const env = { RESEND_API_KEY: 're_test_secret', CONTACT_TO: 'owner@example.com' };
  const server = createServer({ env, fetchImpl: outboundFetchMock });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.20' },
      body: JSON.stringify({
        name: 'Ana Silva',
        email: 'ana@empresa.pt',
        message: 'Automatizar o relatório mensal de vendas.',
        website: ''
      })
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Não foi possível enviar o pedido. Tente novamente mais tarde.' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
