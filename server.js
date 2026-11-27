'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 24 * 1024;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 5;
const attempts = new Map();

function emailConfig(env = process.env) {
  const user = String(env.GMAIL_USER || '').trim();
  const pass = String(env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
  const to = String(env.CONTACT_TO || '').trim();
  return { user, pass, to, active: Boolean(user && pass && to) };
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

function smtpCommand(socket, command, expected) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => { socket.off('data', onData); socket.off('error', onError); };
    const onError = error => { cleanup(); reject(error); };
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        const code = Number(last.slice(0, 3));
        if (!expected.includes(code)) return reject(new Error(`SMTP ${code}`));
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
    if (command !== null) socket.write(command + '\r\n');
  });
}

function mimeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value), 'utf8').toString('base64')}?=`;
}

function createTransport(config) {
  return {
    async sendMail(mail) {
      const socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com', rejectUnauthorized: true });
      await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
      try {
        await smtpCommand(socket, null, [220]);
        await smtpCommand(socket, 'EHLO render.app', [250]);
        await smtpCommand(socket, 'AUTH LOGIN', [334]);
        await smtpCommand(socket, Buffer.from(config.user).toString('base64'), [334]);
        await smtpCommand(socket, Buffer.from(config.pass).toString('base64'), [235]);
        await smtpCommand(socket, `MAIL FROM:<${config.user}>`, [250]);
        await smtpCommand(socket, `RCPT TO:<${config.to}>`, [250, 251]);
        await smtpCommand(socket, 'DATA', [354]);
        const safeBody = String(mail.text || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
        const message = [
          `From: ${mail.from}`,
          `To: ${mail.to}`,
          `Reply-To: ${mail.replyTo}`,
          `Subject: ${mimeHeader(mail.subject)}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          safeBody,
          '.'
        ].join('\r\n');
        await smtpCommand(socket, message, [250]);
        await smtpCommand(socket, 'QUIT', [221]);
      } finally {
        socket.end();
      }
    }
  };
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
  const transportFactory = options.transportFactory || createTransport;
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
        const transport = transportFactory(config);
        await transport.sendMail({
          from: `Site Daniela Reis <${config.user}>`,
          to: config.to,
          replyTo: `${safeHeader(name)} <${safeHeader(email)}>`,
          subject: `Novo pedido de orçamento de ${safeHeader(name)}`,
          text: `Nome: ${name}\nEmail: ${email}\n\nTarefa a automatizar:\n${message}\n`
        });
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

module.exports = { createServer, emailConfig, validate };
