'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const RESEND_API_URL = 'https://api.resend.com/emails';
const RESEND_FROM = 'onboarding@resend.dev';
const MAX_BODY_BYTES = 24 * 1024;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 5;
const attempts = new Map();

function emailConfig(env = process.env) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const to = String(env.CONTACT_TO || '').trim();
  return { apiKey, to, active: Boolean(apiKey && to) };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function limited(ip, now = Date.now()) {
  const current = attempts.get(ip) || [];
  const fresh = current.filter(t => now - t < WINDOW_MS);
  if (fresh.length >= MAX_REQUESTS) {
    attempts.set(ip, fresh);
    return true;
  }
  fresh.push(now);
  attempts.set(ip, fresh);
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('too_large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(Object.assign(new Error('invalid_json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validate(body) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const message = String(body.message || '').trim();
  const website = String(body.website || '').trim();
  if (website) return { spam: true };
  if (name.length < 2 || name.length > 100) return { error: 'Indique um nome válido.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 160) return { error: 'Indique um email válido.' };
  if (message.length < 10 || message.length > 3000) return { error: 'Descreva a tarefa em 10 a 3000 caracteres.' };
  return { value: { name, email, message } };
}

function safeHeader(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

async function sendResendEmail(config, mail, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('HTTPS fetch is unavailable');

  const response = await fetchImpl(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [config.to],
      reply_to: mail.replyTo,
      subject: mail.subject,
      text: mail.text
    })
  });

  if (!response.ok) {
    const error = new Error(`Resend API returned HTTP ${response.status}`);
    error.status = 502;
    throw error;
  }
}

function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return json(res, 400, { error: 'Pedido inválido.' }); }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'Acesso recusado.' });
  fs.readFile(filePath, (err, data) => {
    if (err) return json(res, 404, { error: 'Página não encontrada.' });
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  });
}

function createServer(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  return http.createServer(async (req, res) => {
    securityHeaders(res);
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/api/contact/status') {
      return json(res, 200, { active: emailConfig(env).active });
    }
    if (req.method === 'POST' && req.url === '/api/contact') {
      const config = emailConfig(env);
      if (!config.active) return json(res, 503, { error: 'O formulário está temporariamente indisponível.' });
      if (limited(clientIp(req))) return json(res, 429, { error: 'Foram enviados vários pedidos. Tente novamente dentro de alguns minutos.' });
      try {
        const body = await readJson(req);
        const result = validate(body);
        if (result.spam) return json(res, 200, { ok: true });
        if (result.error) return json(res, 400, { error: result.error });
        const { name, email, message } = result.value;
        await sendResendEmail(config, {
          replyTo: safeHeader(email),
          subject: `Novo pedido de orçamento de ${safeHeader(name)}`,
          text: `Nome: ${name}\nEmail: ${email}\n\nTarefa a automatizar:\n${message}\n`
        }, fetchImpl);
        return json(res, 200, { ok: true });
      } catch (error) {
        console.error('Contact delivery failed:', error && error.message ? error.message : error);
        return json(res, error.status || 502, { error: 'Não foi possível enviar o pedido. Tente novamente mais tarde.' });
      }
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Método não permitido.' });
    return serveStatic(req, res);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, '0.0.0.0', () => console.log(`Site ativo na porta ${port}`));
}

module.exports = { createServer, emailConfig, validate, sendResendEmail };
