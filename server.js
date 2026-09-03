"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { randomUUID } = crypto;

function loadLocalEnvironment() {
  const envFile = path.join(__dirname, ".env");
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnvironment();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "database.json");
const QUEUE_CONCURRENCY = Math.max(1, Number(process.env.QUEUE_CONCURRENCY || 4));
const RATE_LIMIT_PER_MINUTE = Math.max(1, Number(process.env.META_RATE_LIMIT_PER_MINUTE || 60));
const SESSION_COOKIE = "live_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WEBHOOK_LOG_LIMIT = 40;
const PUBLIC_ASSETS = new Set(["login.html", "styles.css"]);
let workerRunning = false;
let sentInWindow = [];
const webhookLogs = [];

function isConfigured(value) {
  return Boolean(value && !/COLE_|CRIE_|GERE_|SEU-DOMINIO/i.test(value));
}

function dashboardPasswordConfigured() {
  return isConfigured(process.env.DASHBOARD_PASSWORD);
}

function sessionSecret() {
  return crypto.createHash("sha256").update(`live-session:${process.env.DASHBOARD_PASSWORD || "unprotected"}`).digest();
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return cookies;
}

function createSessionToken() {
  const payload = String(Date.now() + SESSION_TTL_MS);
  const signature = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

function sessionIsValid(token) {
  if (!token || !token.includes(".")) return false;
  const separator = token.lastIndexOf(".");
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function isDashboardAuthorized(req) {
  return !dashboardPasswordConfigured() || sessionIsValid(parseCookies(req)[SESSION_COOKIE]);
}

function authStatus(req) {
  const required = dashboardPasswordConfigured();
  return { required, authenticated: !required || sessionIsValid(parseCookies(req)[SESSION_COOKIE]) };
}

function cookieFlags() {
  const secure = String(process.env.APP_PUBLIC_URL || "").startsWith("https");
  return `HttpOnly; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieFlags()}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${cookieFlags()}; Max-Age=0`);
}

function passwordMatches(input) {
  const expected = crypto.createHash("sha256").update(String(process.env.DASHBOARD_PASSWORD)).digest();
  const received = crypto.createHash("sha256").update(String(input || "")).digest();
  return crypto.timingSafeEqual(expected, received);
}

function previewPayload(value, limit = 8000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…[truncado]` : text;
}

function pushWebhookLog(entry) {
  webhookLogs.unshift({ id: randomUUID(), at: new Date().toISOString(), ...entry });
  if (webhookLogs.length > WEBHOOK_LOG_LIMIT) webhookLogs.length = WEBHOOK_LOG_LIMIT;
}

function metaConfiguration() {
  const required = ["META_APP_ID", "META_APP_SECRET", "META_VERIFY_TOKEN", "META_IG_USER_ID", "META_ACCESS_TOKEN"];
  const missing = required.filter((key) => !isConfigured(process.env[key]));
  return {
    mode: missing.length ? "SIMULATION" : "META",
    ready: missing.length === 0,
    missing,
    webhookUrl: process.env.META_WEBHOOK_CALLBACK_URL || "",
    apiVersion: process.env.META_GRAPH_API_VERSION || "v25.0",
    scopes: (process.env.META_OAUTH_SCOPES || "").split(",").filter(Boolean),
    subscriptions: (process.env.META_WEBHOOK_SUBSCRIPTIONS || "live_comments").split(",").filter(Boolean)
  };
}

function seed() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    products: [
      { id: randomUUID(), name: "Bolsa Aurora", trigger: "QUERO", checkoutUrl: "https://checkout.exemplo.com/bolsa-aurora", priceCents: 15990, status: "ACTIVE", createdAt: now, updatedAt: now },
      { id: randomUUID(), name: "Óculos Solar", trigger: "QUERO", checkoutUrl: "https://checkout.exemplo.com/oculos-solar", priceCents: 8990, status: "INACTIVE", createdAt: now, updatedAt: now }
    ],
    leads: [], deliveries: [], jobs: []
  };
}

function normalizeDatabase(data) {
  data.schemaVersion = 2;
  data.products = Array.isArray(data.products) ? data.products : [];
  data.leads = Array.isArray(data.leads) ? data.leads : [];
  data.deliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
  data.jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return data;
}

function ensureDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) writeDatabase(seed());
}

function readDatabase() {
  ensureDatabase();
  return normalizeDatabase(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
}

function writeDatabase(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(normalizeDatabase(data), null, 2), "utf8");
  fs.renameSync(temporaryFile, DB_FILE);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function readJsonRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new Error("Payload maior que 1 MB.")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      try { resolve({ raw, body: raw.length ? JSON.parse(raw.toString("utf8")) : {} }); }
      catch (error) { error.raw = raw; reject(error); }
    });
    req.on("error", reject);
  });
}

function cleanText(value) { return String(value || "").normalize("NFKC").trim(); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function hasExactKeyword(comment, keyword) {
  const trigger = cleanText(keyword);
  if (!trigger) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(trigger)}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(cleanText(comment));
}
function formatBRL(cents) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100); }
function buildMessage({ username, productName, checkoutUrl, priceCents }) {
  const template = process.env.DM_MESSAGE_TEMPLATE || "Olá @{{username}}, aqui está seu link para garantir {{productName}} ({{price}}): {{checkoutUrl}}";
  return template.replaceAll("{{username}}", username).replaceAll("{{productName}}", productName).replaceAll("{{checkoutUrl}}", checkoutUrl).replaceAll("{{price}}", formatBRL(priceCents));
}

function isSimulationLead(lead) {
  return lead?.source === "SIMULATION" || String(lead?.commentId || "").startsWith("sim-");
}

function isLiveCommentChange(change) {
  if (!change?.field) return false;
  if (change.field === "live_comments") return true;
  if (change.field === "comments") {
    const type = String(change.value?.media?.media_product_type || "").toUpperCase();
    return type === "LIVE" || type === "LIVE_REPLAY";
  }
  return false;
}

function extractLiveCommentEvents(body) {
  const payloads = Array.isArray(body) ? body : [body];
  const events = [];
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") continue;
    for (const entry of payload.entry || []) {
      const changes = Array.isArray(entry.changes) && entry.changes.length
        ? entry.changes
        : (entry.field && entry.value ? [{ field: entry.field, value: entry.value }] : []);
      for (const change of changes) {
        if (!isLiveCommentChange(change)) continue;
        const value = change.value || {};
        events.push({
          accountId: entry.id,
          field: change.field,
          commentId: value.comment_id || value.id,
          instagramUserId: value.from?.id,
          username: value.from?.username || value.username,
          text: value.text
        });
      }
    }
  }
  return events;
}

function createJob(db, leadId, forceError = false) {
  if (db.jobs.some((job) => job.leadId === leadId && ["PENDING", "PROCESSING"].includes(job.status))) return;
  const now = new Date().toISOString();
  db.jobs.push({ id: randomUUID(), leadId, status: "PENDING", forceError, attempts: 0, availableAt: now, createdAt: now, updatedAt: now, lastError: null });
}

function processLiveComment({ commentId, instagramUserId, username, text: commentText, forceError = false, source = "WEBHOOK" }) {
  if (!commentId || !instagramUserId || !username || !cleanText(commentText)) return { matched: false, reason: "Evento de comentário incompleto." };
  const db = readDatabase();
  const activeProduct = db.products.find((product) => product.status === "ACTIVE");
  if (!activeProduct) return { matched: false, reason: "Nenhum produto está ativo na live." };
  if (!hasExactKeyword(commentText, activeProduct.trigger)) return { matched: false, reason: `O comentário não contém o gatilho ativo: ${activeProduct.trigger}.` };
  const duplicate = db.leads.find((lead) => lead.commentId === String(commentId));
  if (duplicate) return { matched: true, duplicate: true, lead: duplicate };

  const now = new Date().toISOString();
  const cleanUsername = cleanText(username).replace(/^@/, "");
  const origin = source === "SIMULATION" ? "SIMULATION" : "WEBHOOK";
  const lead = {
    id: randomUUID(), commentId: String(commentId), instagramUserId: String(instagramUserId), username: cleanUsername,
    commentText: cleanText(commentText), productId: activeProduct.id, productName: activeProduct.name,
    checkoutUrlSent: activeProduct.checkoutUrl,
    message: buildMessage({ username: cleanUsername, productName: activeProduct.name, checkoutUrl: activeProduct.checkoutUrl, priceCents: activeProduct.priceCents }),
    status: "PENDING", errorMessage: null, metaMessageId: null, source: origin, receivedAt: now, sentAt: null
  };
  db.leads.unshift(lead);
  createJob(db, lead.id, forceError);
  writeDatabase(db);
  setImmediate(runPendingJobs);
  return { matched: true, duplicate: false, lead };
}

function claimNextJob() {
  const db = readDatabase();
  const now = new Date();
  const job = db.jobs.find((item) => item.status === "PENDING" && new Date(item.availableAt) <= now);
  if (!job) return null;
  job.status = "PROCESSING";
  job.attempts += 1;
  job.updatedAt = now.toISOString();
  writeDatabase(db);
  return { ...job };
}
function scheduleRetry(jobId, reason, delayMs) {
  const db = readDatabase();
  const job = db.jobs.find((item) => item.id === jobId);
  if (!job) return;
  job.status = "PENDING"; job.lastError = reason; job.availableAt = new Date(Date.now() + delayMs).toISOString(); job.updatedAt = new Date().toISOString();
  writeDatabase(db);
}
function finishJob(jobId, status, error = null) {
  const db = readDatabase();
  const job = db.jobs.find((item) => item.id === jobId);
  if (!job) return;
  job.status = status; job.lastError = error; job.updatedAt = new Date().toISOString();
  writeDatabase(db);
}
function updateLeadAndAddDelivery(leadId, values, delivery) {
  const db = readDatabase();
  const lead = db.leads.find((item) => item.id === leadId);
  if (!lead) return;
  Object.assign(lead, values);
  db.deliveries.unshift({ id: randomUUID(), leadId, createdAt: new Date().toISOString(), ...delivery });
  writeDatabase(db);
}
function retryDelay(attempt) { return Math.min(15 * 60_000, 2000 * Math.pow(2, Math.min(attempt, 8))); }
function remainingRateWindowMs() {
  const now = Date.now();
  sentInWindow = sentInWindow.filter((time) => time > now - 60_000);
  return sentInWindow.length < RATE_LIMIT_PER_MINUTE ? 0 : Math.max(1000, 60_000 - (now - sentInWindow[0]));
}

async function deliverJob(job) {
  const db = readDatabase();
  const lead = db.leads.find((item) => item.id === job.leadId);
  if (!lead || lead.status === "SENT") return finishJob(job.id, "DONE");
  const waitForRate = remainingRateWindowMs();
  if (waitForRate) return scheduleRetry(job.id, "Limite local de envio: aguardando janela.", waitForRate);

  const meta = metaConfiguration();
  const simulated = isSimulationLead(lead) || !meta.ready;
  if (simulated) {
    if (job.forceError) {
      updateLeadAndAddDelivery(lead.id, { status: "ERROR", errorMessage: "Falha simulada no envio da DM." }, { channel: "Instagram Direct", mode: "SIMULATED", status: "ERROR", detail: "Falha simulada" });
      return finishJob(job.id, "FAILED", "Falha simulada");
    }
    const detail = isSimulationLead(lead)
      ? "Comentário de teste: DM registrada localmente, sem chamada à Meta"
      : "Credenciais Meta ainda não configuradas";
    updateLeadAndAddDelivery(lead.id, { status: "SENT", sentAt: new Date().toISOString(), errorMessage: null }, { channel: "Instagram Direct", mode: "SIMULATED", status: "SENT", detail });
    return finishJob(job.id, "DONE");
  }

  try {
    sentInWindow.push(Date.now());
    const response = await fetch(`https://graph.instagram.com/${meta.apiVersion}/${process.env.META_IG_USER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { comment_id: lead.commentId }, message: { text: lead.message } }),
      signal: AbortSignal.timeout(12_000)
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      updateLeadAndAddDelivery(lead.id, { status: "SENT", sentAt: new Date().toISOString(), errorMessage: null, metaMessageId: body.message_id || null }, { channel: "Instagram Direct", mode: "META", status: "SENT", detail: "Resposta privada enviada", metaStatus: response.status });
      return finishJob(job.id, "DONE");
    }
    const detail = body.error?.message || `Resposta Meta HTTP ${response.status}`;
    if (response.status === 429 || response.status >= 500) return scheduleRetry(job.id, detail, Number(response.headers.get("retry-after") || 0) * 1000 || retryDelay(job.attempts));
    updateLeadAndAddDelivery(lead.id, { status: "ERROR", errorMessage: detail }, { channel: "Instagram Direct", mode: "META", status: "ERROR", detail, metaStatus: response.status });
    return finishJob(job.id, "FAILED", detail);
  } catch (error) {
    const detail = error.name === "TimeoutError" ? "Tempo esgotado ao chamar a Meta." : error.message;
    if (job.attempts >= 6) {
      updateLeadAndAddDelivery(lead.id, { status: "ERROR", errorMessage: detail }, { channel: "Instagram Direct", mode: "META", status: "ERROR", detail });
      return finishJob(job.id, "FAILED", detail);
    }
    return scheduleRetry(job.id, detail, retryDelay(job.attempts));
  }
}

async function runPendingJobs() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    await Promise.all(Array.from({ length: QUEUE_CONCURRENCY }, async () => {
      while (true) { const job = claimNextJob(); if (!job) return; await deliverJob(job); }
    }));
  } finally { workerRunning = false; }
}

function validSignature(raw, signature) {
  const secret = process.env.META_APP_SECRET;
  if (!isConfigured(secret) || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function productInput(body) {
  const name = cleanText(body.name);
  const trigger = cleanText(body.trigger).toUpperCase();
  const checkoutUrl = cleanText(body.checkoutUrl);
  const priceCents = Math.round(Number(body.price) * 100);
  if (!name || !trigger || !checkoutUrl || !Number.isInteger(priceCents) || priceCents < 0) throw new Error("Preencha nome, gatilho, link de checkout e preço corretamente.");
  try { new URL(checkoutUrl); } catch { throw new Error("Informe um link de checkout válido."); }
  return { name, trigger, checkoutUrl, priceCents };
}

function publicDashboard(req) {
  const db = readDatabase();
  const activeProduct = db.products.find((product) => product.status === "ACTIVE") || null;
  return {
    products: db.products.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    leads: db.leads.slice(0, 100),
    deliveries: db.deliveries.slice(0, 100),
    activeProduct,
    meta: metaConfiguration(),
    auth: authStatus(req),
    webhookLogs: webhookLogs.slice(0, 20),
    stats: { total: db.leads.length, pending: db.leads.filter((lead) => lead.status === "PENDING").length, sent: db.leads.filter((lead) => lead.status === "SENT").length, errors: db.leads.filter((lead) => lead.status === "ERROR").length }
  };
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  if (req.method === "GET" && pathname === "/api/auth-status") return json(res, 200, authStatus(req));
  if (req.method === "POST" && pathname === "/api/login") {
    const parsed = await readJsonRequest(req);
    if (!dashboardPasswordConfigured()) return json(res, 200, { ok: true, required: false });
    if (!passwordMatches(parsed.body?.password)) return json(res, 401, { error: "Senha incorreta." });
    setSessionCookie(res, createSessionToken());
    return json(res, 200, { ok: true, required: true });
  }
  if (req.method === "POST" && pathname === "/api/logout") {
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && pathname === "/api/health") return json(res, 200, { ok: true, queueRunning: workerRunning, meta: metaConfiguration().mode });
  if (!isDashboardAuthorized(req)) return json(res, 401, { error: "Faça login para acessar o painel." });
  if (req.method === "GET" && pathname === "/api/dashboard") return json(res, 200, publicDashboard(req));
  if (req.method === "POST" && pathname === "/api/products") {
    const { body } = await readJsonRequest(req);
    try {
      const db = readDatabase(); const now = new Date().toISOString();
      const product = { id: randomUUID(), ...productInput(body), status: "INACTIVE", createdAt: now, updatedAt: now };
      db.products.unshift(product); writeDatabase(db); return json(res, 201, product);
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  const productRoute = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productRoute && req.method === "PATCH") {
    const { body } = await readJsonRequest(req);
    try {
      const db = readDatabase(); const product = db.products.find((item) => item.id === productRoute[1]);
      if (!product) return json(res, 404, { error: "Produto não encontrado." });
      Object.assign(product, productInput(body), { updatedAt: new Date().toISOString() }); writeDatabase(db); return json(res, 200, product);
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (productRoute && req.method === "DELETE") {
    const db = readDatabase(); const product = db.products.find((item) => item.id === productRoute[1]);
    if (!product) return json(res, 404, { error: "Produto não encontrado." });
    db.products = db.products.filter((item) => item.id !== product.id); writeDatabase(db); return json(res, 200, { ok: true });
  }
  const activation = pathname.match(/^\/api\/products\/([^/]+)\/activate$/);
  if (req.method === "POST" && activation) {
    const db = readDatabase(); const product = db.products.find((item) => item.id === activation[1]);
    if (!product) return json(res, 404, { error: "Produto não encontrado." });
    const now = new Date().toISOString(); db.products.forEach((item) => { item.status = item.id === product.id ? "ACTIVE" : "INACTIVE"; item.updatedAt = now; }); writeDatabase(db); return json(res, 200, product);
  }
  const deactivation = pathname.match(/^\/api\/products\/([^/]+)\/deactivate$/);
  if (req.method === "POST" && deactivation) {
    const db = readDatabase(); const product = db.products.find((item) => item.id === deactivation[1]);
    if (!product) return json(res, 404, { error: "Produto não encontrado." });
    product.status = "INACTIVE"; product.updatedAt = new Date().toISOString(); writeDatabase(db); return json(res, 200, product);
  }
  if (req.method === "POST" && pathname === "/api/simulate-comment") {
    const { body } = await readJsonRequest(req); const username = cleanText(body.username).replace(/^@/, ""); const commentText = cleanText(body.text);
    if (!username || !commentText) return json(res, 400, { error: "Informe o usuário e o comentário para simular." });
    return json(res, 200, processLiveComment({ commentId: `sim-${randomUUID()}`, instagramUserId: `ig-${randomUUID()}`, username, text: commentText, forceError: Boolean(body.forceError), source: "SIMULATION" }));
  }
  const retryRoute = pathname.match(/^\/api\/leads\/([^/]+)\/retry$/);
  if (req.method === "POST" && retryRoute) {
    const db = readDatabase(); const lead = db.leads.find((item) => item.id === retryRoute[1]);
    if (!lead) return json(res, 404, { error: "Lead não encontrado." });
    lead.status = "PENDING"; lead.errorMessage = null; createJob(db, lead.id); writeDatabase(db); setImmediate(runPendingJobs); return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && pathname === "/api/reset-demo") { writeDatabase(seed()); return json(res, 200, { ok: true }); }
  return json(res, 404, { error: "Rota não encontrada." });
}

async function handleWebhook(req, res, url) {
  const meta = metaConfiguration();
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const accepted = mode === "subscribe" && isConfigured(process.env.META_VERIFY_TOKEN) && token === process.env.META_VERIFY_TOKEN;
    pushWebhookLog({ method: "GET", accepted, mode, hasChallenge: Boolean(challenge), tokenMatched: Boolean(process.env.META_VERIFY_TOKEN) && token === process.env.META_VERIFY_TOKEN });
    console.log(`[webhook] verificação GET accepted=${accepted} mode=${mode || "—"}`);
    if (accepted) return text(res, 200, challenge || "");
    return text(res, 403, "Verificação recusada.");
  }
  if (req.method !== "POST") return text(res, 405, "Método não permitido.");

  let raw;
  let body;
  try {
    ({ raw, body } = await readJsonRequest(req));
  } catch (error) {
    const preview = previewPayload(error.raw ? error.raw.toString("utf8") : error.message);
    pushWebhookLog({ method: "POST", accepted: false, reason: "JSON inválido", payload: preview });
    console.log("[webhook] JSON inválido", preview);
    return json(res, 400, { error: "JSON inválido." });
  }

  const signature = req.headers["x-hub-signature-256"];
  const signatureValid = validSignature(raw, signature);
  const payloadPreview = previewPayload(body);
  if (meta.ready && !signatureValid) {
    pushWebhookLog({ method: "POST", accepted: false, reason: "Assinatura inválida", signaturePresent: Boolean(signature), payload: payloadPreview });
    console.log("[webhook] assinatura inválida", payloadPreview);
    return json(res, 403, { error: "Assinatura do webhook inválida." });
  }

  const events = extractLiveCommentEvents(body);
  let processed = 0;
  let skippedAccount = 0;
  const results = [];
  for (const event of events) {
    if (meta.ready && event.accountId && String(event.accountId) !== String(process.env.META_IG_USER_ID)) {
      skippedAccount += 1;
      continue;
    }
    const result = processLiveComment({
      commentId: event.commentId,
      instagramUserId: event.instagramUserId,
      username: event.username,
      text: event.text,
      source: "WEBHOOK"
    });
    processed += 1;
    results.push({ field: event.field, commentId: event.commentId, matched: result.matched, reason: result.reason || null, duplicate: Boolean(result.duplicate) });
  }

  pushWebhookLog({
    method: "POST",
    accepted: true,
    signaturePresent: Boolean(signature),
    signatureChecked: meta.ready,
    events: events.length,
    processed,
    skippedAccount,
    results,
    payload: payloadPreview
  });
  console.log(`[webhook] POST events=${events.length} processed=${processed} skippedAccount=${skippedAccount}`, payloadPreview);
  return json(res, 200, { received: true, processed, events: events.length });
}

function contentType(file) { return file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "application/octet-stream"; }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname === "/webhook") return await handleWebhook(req, res, url);
    if (req.method !== "GET") return text(res, 405, "Método não permitido.");
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!isDashboardAuthorized(req) && !PUBLIC_ASSETS.has(requested)) return redirect(res, "/login.html");
    const file = path.resolve(PUBLIC_DIR, requested);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return text(res, 404, "Página não encontrada.");
    return text(res, 200, fs.readFileSync(file), contentType(file));
  } catch (error) { console.error(error); return json(res, 500, { error: error.message || "Erro interno." }); }
});

ensureDatabase();
setInterval(runPendingJobs, 1_000).unref();
server.listen(PORT, "0.0.0.0", () => console.log(`Aplicação disponível em http://localhost:${PORT}`));
