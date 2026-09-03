const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const byId = (id) => document.getElementById(id);
let latestDashboard;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.replace("/login.html");
    throw new Error(body.error || "Faça login para acessar o painel.");
  }
  if (!response.ok) throw new Error(body.error || "Não foi possível concluir a ação.");
  return body;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

function statusLabel(status) {
  return ({ SENT: "ENVIADO", ERROR: "ERRO", PENDING: "NA FILA", ACTIVE: "ATIVO", INACTIVE: "INATIVO" })[status] || status;
}

function sourceLabel(lead) {
  return lead.source === "WEBHOOK" ? "Live" : "Teste local";
}

function formatLogTime(value) {
  try { return new Date(value).toLocaleString("pt-BR"); }
  catch { return value; }
}

function renderMeta(data) {
  const meta = data.meta;
  const real = meta.ready;
  byId("meta-badge").innerHTML = `<span></span> ${real ? "Meta conectada" : "Modo de simulação"}`;
  byId("connection-status").textContent = real ? "PRONTO" : "PENDENTE";
  byId("connection-status").className = `pill ${real ? "connected" : "inactive"}`;
  const required = meta.missing.length
    ? `<p>Preencha no arquivo <code>.env</code>: <strong>${meta.missing.join(", ")}</strong>.</p>`
    : `<p>Credenciais carregadas. Webhooks assinados e envio real de DM estão ativos. Comentários do botão “Processar comentário” continuam só no painel.</p>`;
  const authNote = data.auth?.required
    ? "<p>Painel protegido por senha.</p>"
    : "<p class=\"warn\">O painel está aberto. Defina <code>DASHBOARD_PASSWORD</code> no <code>.env</code> antes de expor a URL publicamente.</p>";
  byId("integration-details").innerHTML = `${required}${authNote}<p>Escopos: <code>${meta.scopes.join(", ") || "não configurados"}</code></p><p>Assinatura de webhook: ${real ? "validada via X-Hub-Signature-256" : "liberada apenas para testes locais"}.</p>`;
  byId("webhook-url").textContent = meta.webhookUrl || "Configure META_WEBHOOK_CALLBACK_URL no .env";
  byId("logout").hidden = !data.auth?.required;

  const logs = data.webhookLogs || [];
  byId("webhook-logs").innerHTML = logs.length
    ? logs.map((log) => `
      <article class="log-row">
        <div class="log-head">
          <strong>${escapeHtml(log.method)}</strong>
          <span class="status ${log.accepted ? "sent" : "error"}">${log.accepted ? "ACEITO" : "RECUSADO"}</span>
          <span class="row-meta">${escapeHtml(formatLogTime(log.at))}</span>
        </div>
        <p class="row-meta">${escapeHtml(log.reason || `eventos ${log.events ?? 0} · processados ${log.processed ?? 0}`)}</p>
        ${log.payload ? `<pre>${escapeHtml(log.payload)}</pre>` : ""}
      </article>`).join("")
    : `<p class="empty">Nenhum webhook ainda. Os GET/POST da Meta em <code>/webhook</code> aparecem aqui e no terminal.</p>`;
}

function render(data) {
  latestDashboard = data;
  byId("metric-total").textContent = data.stats.total;
  byId("metric-pending").textContent = data.stats.pending;
  byId("metric-sent").textContent = data.stats.sent;
  byId("metric-errors").textContent = data.stats.errors;
  renderMeta(data);

  const active = data.activeProduct;
  byId("active-status").textContent = active ? "ATIVO" : "SEM PRODUTO";
  byId("active-status").className = `pill ${active ? "connected" : "inactive"}`;
  byId("active-product").innerHTML = active
    ? `<div class="product-title">${escapeHtml(active.name)}</div><div class="price">${money.format(active.priceCents / 100)}</div><span class="trigger">Gatilho: ${escapeHtml(active.trigger)}</span><p class="checkout">${escapeHtml(active.checkoutUrl)}</p>`
    : `<p class="empty">Ative um produto do catálogo antes de receber comentários.</p>`;

  byId("products").innerHTML = data.products.length ? data.products.map((product) => `
    <div class="product-row ${product.status === "ACTIVE" ? "active" : ""}">
      <div class="row-content"><div class="row-title">${escapeHtml(product.name)}</div><div class="row-meta">${money.format(product.priceCents / 100)} · gatilho: ${escapeHtml(product.trigger)}</div></div>
      <div class="row-actions"><span class="status ${product.status.toLowerCase()}">${statusLabel(product.status)}</span>
      <button data-action="${product.status === "ACTIVE" ? "deactivate" : "activate"}" data-id="${product.id}">${product.status === "ACTIVE" ? "Pausar" : "Ativar"}</button><button data-action="edit" data-id="${product.id}">Editar</button><button data-action="delete" data-id="${product.id}" class="danger">Excluir</button></div>
    </div>`).join("") : `<p class="empty">Cadastre o primeiro produto da Live.</p>`;

  byId("leads").innerHTML = data.leads.length ? data.leads.map((lead) => `
    <div class="lead-row"><div class="lead-main"><div class="row-title">@${escapeHtml(lead.username)} <span class="row-meta">· ${escapeHtml(lead.productName)} · ${sourceLabel(lead)}</span></div><div class="lead-message">${escapeHtml(lead.message)}</div>${lead.errorMessage ? `<div class="error-detail">${escapeHtml(lead.errorMessage)}</div>` : ""}</div><div class="lead-status"><span class="status ${lead.status.toLowerCase()}">${statusLabel(lead.status)}</span>${lead.status === "ERROR" ? `<button data-retry="${lead.id}">Tentar novamente</button>` : ""}</div></div>`).join("") : `<p class="empty">Nenhum lead ainda. Simule um comentário contendo o gatilho ativo.</p>`;
}

async function refresh() { render(await api("/api/dashboard")); }

byId("comment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = byId("simulation-result");
  result.className = "result";
  result.textContent = "Registrando comentário de teste. Nenhuma DM real será enviada.";
  try {
    const response = await api("/api/simulate-comment", { method: "POST", body: JSON.stringify({ username: byId("comment-username").value, text: byId("comment-text").value, forceError: byId("force-error").checked }) });
    result.className = `result ${response.matched ? "ok" : "bad"}`;
    result.textContent = response.duplicate ? "Este comentário já havia sido processado." : response.matched ? "Lead de teste criado. A DM ficou só no histórico local." : response.reason;
    await refresh();
  } catch (error) { result.className = "result bad"; result.textContent = error.message; }
});

byId("product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/products", { method: "POST", body: JSON.stringify({ name: byId("product-name").value, trigger: byId("product-trigger").value, checkoutUrl: byId("product-url").value, price: byId("product-price").value }) });
    event.target.reset();
    await refresh();
  } catch (error) { alert(error.message); }
});

byId("products").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const product = latestDashboard.products.find((item) => item.id === button.dataset.id);
  try {
    if (button.dataset.action === "delete") {
      if (!confirm(`Excluir “${product.name}”? O histórico de leads será preservado.`)) return;
      await api(`/api/products/${product.id}`, { method: "DELETE" });
    } else if (button.dataset.action === "edit") {
      const name = prompt("Nome do produto", product.name); if (name === null) return;
      const trigger = prompt("Gatilho", product.trigger); if (trigger === null) return;
      const checkoutUrl = prompt("Link de pagamento", product.checkoutUrl); if (checkoutUrl === null) return;
      const price = prompt("Preço em R$", (product.priceCents / 100).toFixed(2)); if (price === null) return;
      await api(`/api/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ name, trigger, checkoutUrl, price }) });
    } else {
      await api(`/api/products/${product.id}/${button.dataset.action}`, { method: "POST" });
    }
    await refresh();
  } catch (error) { alert(error.message); }
});

byId("leads").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-retry]");
  if (!button) return;
  await api(`/api/leads/${button.dataset.retry}/retry`, { method: "POST" });
  await refresh();
});

byId("copy-webhook").addEventListener("click", async () => {
  const value = byId("webhook-url").textContent;
  if (!value || value.startsWith("Configure")) return alert("Defina a URL pública no .env primeiro.");
  await navigator.clipboard.writeText(value);
  byId("copy-webhook").textContent = "Copiado";
  setTimeout(() => { byId("copy-webhook").textContent = "Copiar"; }, 1500);
});

byId("reset-demo").addEventListener("click", async () => {
  if (!confirm("Restaurar os produtos de demonstração e apagar todos os leads de teste?")) return;
  await api("/api/reset-demo", { method: "POST" });
  byId("simulation-result").textContent = "Demonstração restaurada.";
  await refresh();
});

byId("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  window.location.replace("/login.html");
});

refresh().catch((error) => { document.body.innerHTML = `<p style="padding:30px">Erro ao carregar: ${escapeHtml(error.message)}</p>`; });
setInterval(() => refresh().catch(() => {}), 3000);
