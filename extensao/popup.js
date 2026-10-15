const $ = (s) => document.querySelector(s);

// Aberto dentro do painel flutuante da Biblioteca: sem largura fixa.
if (location.search.includes("embutido")) {
  document.body.classList.add("embutido");
  // avisa o painel que o iframe subiu (ele mostra um plano B se não vier)
  try { parent.postMessage({ mn: "popup-pronto" }, "*"); } catch (e) { /* sem parent */ }
}
const PADRAO_API = "https://minerador-ofertas-umber.vercel.app";

// Fora do Chrome (abrindo popup.html direto para conferir layout) não existe
// chrome.storage/runtime. Stub mínimo em localStorage para a tela não quebrar.
if (typeof chrome === "undefined" || !chrome.storage) {
  const mem = JSON.parse(localStorage.getItem("__minerador") || "{}");
  const salvar = () => localStorage.setItem("__minerador", JSON.stringify(mem));
  window.chrome = {
    storage: { local: {
      get: async (ks) => (Array.isArray(ks) ? Object.fromEntries(ks.map((k) => [k, mem[k]])) : { [ks]: mem[ks] }),
      set: async (o) => { Object.assign(mem, o); salvar(); },
      remove: async (ks) => { for (const k of [].concat(ks)) delete mem[k]; salvar(); },
    } },
    runtime: { sendMessage: (_m, cb) => cb && cb(null), onMessage: { addListener: () => {} } },
    tabs: { create: ({ url }) => window.open(url, "_blank") },
    permissions: { request: async () => true },
  };
}

const SUGESTOES_PT = [
  "receitas fit", "planilha financeira", "ebook", "curso online", "método",
  "artesanato", "crochê", "adestramento", "manual", "combo digital",
  "pacote de", "aula ao vivo", "guia completo", "templates canva",
];

const SUGESTOES_ES = [
  "recetas saludables", "plantilla excel", "ebook", "curso online", "método",
  "manualidades", "crochet", "adiestramiento canino", "manual", "combo digital",
  "pack de", "clase en vivo", "guía completa", "plantillas canva",
  "bajar de peso", "ganar dinero desde casa",
];

// Mercados de língua espanhola — usados para escolher as sugestões de termo.
const PAISES_ES = ["MX", "AR", "CO", "CL", "PE", "EC", "UY", "ES"];

function sugestoes(s) {
  const es = s.idioma === "es" || (!s.idioma && PAISES_ES.includes(s.pais || "BR"));
  return es ? SUGESTOES_ES : SUGESTOES_PT;
}

// ------------------------------------------------------------------ estado

async function ler() {
  return chrome.storage.local.get([
    "token", "apiUrl", "usuario", "usos", "auto",
    "minAds", "minDias", "pais", "idioma", "profunda", "maxAnunciantes",
    "maxAnuncios", "timeout", "termo", "abrirSozinho", "painelFlutuante", "usarAbaAtual", "abrirDashboard", "fila", "paradas", "autoRolar",
    "ideia", "ideiasTermos", "ideiasFonte", "ideiasGrupos", "ideiasInterp",
  ]);
}

function apiUrl(s) {
  return (s.apiUrl || PADRAO_API).replace(/\/$/, "");
}

async function mostrar() {
  const s = await ler();
  const logado = !!s.token;
  $("#tela-login").hidden = logado;
  $("#tela-main").hidden = !logado;

  $("#login-api").value = s.apiUrl || PADRAO_API;
  if (!logado) return;

  $("#usos").textContent = s.usos ?? "—";
  $("#termo").value = s.termo || "";
  $("#auto").checked = !!s.auto;
  $("#auto-rolar").checked = !!s.autoRolar;
  $("#pais").value = s.pais || "BR";
  $("#idioma").value = s.idioma || "";
  pintarChips(s);
  pintarFila(s.fila || []);
  $("#ideia").value = s.ideia || "";
  pintarIdeias(s.ideiasTermos || [], s.ideiasFonte, s.ideiasGrupos, s.ideiasInterp);
  $("#profunda").checked = !!s.profunda;   // desligada por padrão: abre aba extra
  $("#abrir-sozinho").checked = s.abrirSozinho !== false;
  $("#painel-flutuante").checked = s.painelFlutuante !== false;
  $("#usar-aba").checked = !!s.usarAbaAtual;
  $("#abrir-painel").checked = !!s.abrirDashboard;
  $("#max-anunciantes").value = s.maxAnunciantes ?? 8;
  // Só low ticket entra: a maior parte da busca é descartada, então 60 era
  // pouco (o anúncio bom estava na posição 74). 60 guardado = padrão antigo.
  $("#max-anuncios").value = (s.maxAnuncios == null || s.maxAnuncios === 60) ? 150 : s.maxAnuncios;
  $("#timeout").value = s.timeout ?? 300;
  $("#paradas").value = s.paradas ?? 12;
  $("#api-url").value = apiUrl(s);
  par("min-ads", s.minAds ?? 2);
  par("min-dias", s.minDias ?? 3);

  atualizarUsos();
}

// Slider e caixa numérica sempre com o mesmo valor.
function par(id, valor) {
  $("#" + id).value = valor;
  $("#" + id + "-n").value = valor;
}

function ligarPar(id, chave) {
  const range = $("#" + id), num = $("#" + id + "-n");
  const sync = (v) => {
    range.value = v; num.value = v;
    chrome.storage.local.set({ [chave]: Number(v) });
  };
  range.oninput = () => sync(range.value);
  num.oninput = () => sync(num.value);
}

async function atualizarUsos() {
  const s = await ler();
  try {
    const r = await fetch(apiUrl(s) + "/api/me", {
      headers: { Authorization: "Bearer " + s.token },
    });
    if (r.status === 401) { await chrome.storage.local.remove("token"); return mostrar(); }
    const j = await r.json();
    $("#usos").textContent = j.usos_restantes;
    await chrome.storage.local.set({ usos: j.usos_restantes });
  } catch (e) {
    $("#status").textContent = "Servidor offline (" + apiUrl(s) + ")";
    $("#status").classList.add("erro");
  }
}

// ------------------------------------------------------------------ login

$("#btn-entrar").onclick = async () => {
  const base = ($("#login-api").value || PADRAO_API).replace(/\/$/, "");
  $("#login-erro").hidden = true;

  // Servidor fora do localhost precisa de permissão de host explícita.
  if (!/^https?:\/\/(127\.0\.0\.1|localhost):/.test(base)) {
    try {
      const ok = await chrome.permissions.request({ origins: [new URL(base).origin + "/*"] });
      if (!ok) throw new Error("permissão negada");
    } catch (e) {
      $("#login-erro").textContent = "Permissão para " + base + " negada.";
      $("#login-erro").hidden = false;
      return;
    }
  }

  try {
    const r = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("#login-user").value, password: $("#login-pass").value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.erro || "falha no login");
    await chrome.storage.local.set({
      token: j.token, apiUrl: base, usuario: j.usuario, usos: j.usos_restantes,
    });
    mostrar();
  } catch (e) {
    $("#login-erro").textContent = e.message;
    $("#login-erro").hidden = false;
  }
};

$("#btn-sair").onclick = async () => {
  await chrome.storage.local.remove(["token", "usuario", "usos"]);
  mostrar();
};

// ------------------------------------------------------------------ interface

for (const [botao, painel] of [
  ["#tg-filtro", "#painel-filtro"],
  ["#tg-pesquisa", "#painel-pesquisa"],
  ["#tg-sugestoes", "#painel-sugestoes"],
]) {
  $(botao).onclick = () => { $(painel).hidden = !$(painel).hidden; };
}

function pintarChips(s) {
  $("#chips").innerHTML = sugestoes(s).map((t) => `<button>${t}</button>`).join("");
}

$("#chips").onclick = (e) => {
  if (e.target.tagName !== "BUTTON") return;
  $("#termo").value = e.target.textContent;
  chrome.storage.local.set({ termo: e.target.textContent });
};

$("#termo").oninput = (e) => {
  chrome.storage.local.set({ termo: e.target.value });
  atualizarBotao();
};
$("#auto").onchange = (e) => chrome.storage.local.set({ auto: e.target.checked });
$("#auto-rolar").onchange = (e) => chrome.storage.local.set({ autoRolar: e.target.checked });
$("#pais").onchange = async (e) => {
  await chrome.storage.local.set({ pais: e.target.value });
  pintarChips(await ler());
};
$("#idioma").onchange = async (e) => {
  await chrome.storage.local.set({ idioma: e.target.value });
  pintarChips(await ler());
};
$("#profunda").onchange = (e) => chrome.storage.local.set({ profunda: e.target.checked });
$("#usar-aba").onchange = (e) => chrome.storage.local.set({ usarAbaAtual: e.target.checked });
$("#abrir-painel").onchange = (e) => chrome.storage.local.set({ abrirDashboard: e.target.checked });
$("#abrir-sozinho").onchange = (e) => chrome.storage.local.set({ abrirSozinho: e.target.checked });
$("#painel-flutuante").onchange = (e) =>
  chrome.storage.local.set({ painelFlutuante: e.target.checked });
$("#max-anunciantes").oninput = (e) => chrome.storage.local.set({ maxAnunciantes: Number(e.target.value) });
$("#max-anuncios").oninput = (e) => chrome.storage.local.set({ maxAnuncios: Number(e.target.value) });
$("#timeout").oninput = (e) => chrome.storage.local.set({ timeout: Number(e.target.value) });
$("#paradas").oninput = (e) => chrome.storage.local.set({ paradas: Number(e.target.value) });
$("#api-url").onchange = (e) => chrome.storage.local.set({ apiUrl: e.target.value.replace(/\/$/, "") });

ligarPar("min-ads", "minAds");
ligarPar("min-dias", "minDias");

$("#ir-dashboard").onclick = async () => {
  const s = await ler();
  chrome.tabs.create({ url: apiUrl(s) + "/" });
};
$("#ir-config").onclick = () => { $("#painel-pesquisa").hidden = !$("#painel-pesquisa").hidden; };
$("#btn-planos").onclick = async () => {
  const s = await ler();
  chrome.tabs.create({ url: apiUrl(s) + "/#planos" });
};
$("#rodape").onclick = async () => {
  const s = await ler();
  chrome.tabs.create({ url: apiUrl(s) + "/" });
};

// ------------------------------------------------------------------ fila de termos

function pintarFila(fila) {
  $("#fila-caixa").hidden = fila.length === 0;
  $("#fila-n").textContent = fila.length;
  $("#fila-chips").innerHTML = fila.map((t, i) =>
    `<button data-i="${i}" title="Tirar da fila">${t}</button>`).join("");
  atualizarBotao(fila);
}

// O botão precisa dizer o que vai acontecer: com termos guardados na fila,
// PESQUISAR roda todos eles, não só o que está no campo.
async function atualizarBotao(fila) {
  if (!fila) fila = (await ler()).fila || [];
  const digitado = $("#termo").value.trim();
  const total = fila.length + (digitado ? 1 : 0);
  $("#btn-pesquisar").textContent = total > 1
    ? `▶ PESQUISAR ${total} TERMOS` : "▶ PESQUISAR";
  $("#btn-pesquisar").title = total > 1
    ? "Roda em sequência: " + [...fila, ...(digitado ? [digitado] : [])].join(" · ")
    : "";
}

async function mudarFila(fn) {
  const s = await ler();
  const fila = fn([...(s.fila || [])]);
  await chrome.storage.local.set({ fila });
  pintarFila(fila);
  return fila;
}

$("#btn-add-fila").onclick = async () => {
  // aceita "um, dois, três" de uma vez — colar lista é o caso comum
  const novos = $("#termo").value.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean);
  if (!novos.length) { estado("Digite um termo para adicionar.", true); return; }
  await mudarFila((f) => [...f, ...novos.filter((t) => !f.includes(t))]);
  $("#termo").value = "";
  chrome.storage.local.set({ termo: "" });
};

$("#fila-chips").onclick = (e) => {
  const b = e.target.closest("button[data-i]");
  if (b) mudarFila((f) => f.filter((_, i) => i !== Number(b.dataset.i)));
};

$("#btn-limpar-fila").onclick = () => mudarFila(() => []);

$("#btn-parar").onclick = () => {
  chrome.runtime.sendMessage({ tipo: "PARAR_FILA" });
  estado("Parando a coleta…");
};

// ------------------------------------------------------------------ ideia -> palavras-chave

// A ideia ("produtos para o natal") vira termos que o anunciante escreve na
// copy; você desmarca o que não quer e manda o resto para a fila.
const escHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const chip = (t) => `<button class="on" title="Clique para marcar/desmarcar">${escHtml(t)}</button>`;

// Agrupado por tema ("Dia das Crianças", "Halloween"…): clicar no nome do tema
// marca/desmarca o tema inteiro.
function pintarIdeias(termos, fonte, grupos, interpretacao) {
  $("#ideias-caixa").hidden = !termos.length;
  $("#ideias-chips").innerHTML = (grupos && grupos.length)
    ? grupos.map((g) => `<div class="tema"><div class="tema-nome" title="Marcar/desmarcar o tema">${escHtml(g.tema)}</div>`
        + `<div class="chips">${g.termos.map(chip).join("")}</div></div>`).join("")
    : termos.map(chip).join("");
  $("#ideias-fonte").textContent = fonte === "ia"
    ? (interpretacao ? "IA: " + interpretacao : "Geradas por IA a partir da sua ideia.")
    : "Geradas por regras (a IA não respondeu agora — tente ✨ de novo).";
  contarIdeias();
}

function contarIdeias() {
  $("#ideias-n").textContent = document.querySelectorAll("#ideias-chips button.on").length;
}

async function gerarIdeias() {
  const ideia = $("#ideia").value.trim();
  if (!ideia) { estado("Escreva uma ideia, ex: produtos para o natal.", true); return; }
  const s = await ler();
  const pais = $("#pais").value;
  const idioma = $("#idioma").value || (PAISES_ES.includes(pais) ? "es" : "pt");
  $("#btn-ideia").disabled = true;
  estado("Gerando palavras-chave…");
  try {
    const r = await fetch(apiUrl(s) + "/api/ideias", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.token },
      body: JSON.stringify({ ideia, idioma }),
    });
    if (r.status === 401) { await chrome.storage.local.remove("token"); return mostrar(); }
    if (!r.ok) throw new Error("servidor respondeu " + r.status);
    const j = await r.json();
    pintarIdeias(j.termos || [], j.fonte, j.grupos, j.interpretacao);
    await chrome.storage.local.set({ ideia, ideiasTermos: j.termos || [], ideiasFonte: j.fonte,
                                     ideiasGrupos: j.grupos || [], ideiasInterp: j.interpretacao || "" });
    estado(`${(j.termos || []).length} palavras-chave. Desmarque as que não quiser e adicione à fila.`);
  } catch (e) {
    estado("Não deu para gerar: " + e.message, true);
  } finally {
    $("#btn-ideia").disabled = false;
  }
}

$("#btn-ideia").onclick = gerarIdeias;
$("#ideia").onkeydown = (e) => { if (e.key === "Enter") gerarIdeias(); };
$("#ideias-chips").onclick = (e) => {
  const nome = e.target.closest(".tema-nome");
  if (nome) {
    const botoes = [...nome.parentElement.querySelectorAll("button")];
    const ligar = !botoes.every((b) => b.classList.contains("on"));
    botoes.forEach((b) => b.classList.toggle("on", ligar));
  } else if (e.target.tagName === "BUTTON") {
    e.target.classList.toggle("on");
  }
  contarIdeias();
};
$("#btn-ideias-fila").onclick = async () => {
  const marcados = [...document.querySelectorAll("#ideias-chips button.on")].map((b) => b.textContent);
  if (!marcados.length) { estado("Marque pelo menos uma palavra-chave.", true); return; }
  const fila = await mudarFila((f) => [...f, ...marcados.filter((t) => !f.includes(t))]);
  $("#ideias-caixa").hidden = true;
  await chrome.storage.local.set({ ideiasTermos: [], ideiasGrupos: [] });
  estado(`${marcados.length} na fila (${fila.length} no total). Clique em PESQUISAR.`);
};

// ------------------------------------------------------------------ pesquisa

function configuracao(extra) {
  return {
    pais: $("#pais").value,
    idioma: $("#idioma").value,
    minAnuncios: Number($("#min-ads-n").value || 1),
    minDias: Number($("#min-dias-n").value || 0),
    maxAnuncios: Number($("#max-anuncios").value || 150),
    timeoutMs: Number($("#timeout").value || 300) * 1000,
    paradasMax: Number($("#paradas").value || 12),
    varreduraProfunda: $("#profunda").checked,
    maxAnunciantes: Number($("#max-anunciantes").value || 8),
    usarAbaAtual: $("#usar-aba").checked,
    abrirDashboard: $("#abrir-painel").checked,
    ...extra,
  };
}

$("#btn-pesquisar").onclick = async () => {
  const s = await ler();
  const digitado = $("#termo").value.trim();
  // Fila na frente: se há termos guardados, o campo digitado entra como mais um.
  const fila = [...(s.fila || []), ...(digitado ? [digitado] : [])];

  if (!fila.length) { estado("Digite um nicho ou adicione termos à fila.", true); return; }

  $("#btn-pesquisar").disabled = true;
  $("#btn-parar").hidden = false;
  sincronizando = true;
  estado(fila.length > 1 ? `Iniciando fila de ${fila.length} termos…` : "Iniciando…");

  const unico = fila.length === 1;
  // Só dispara: quem acompanha o andamento é o sincronizarEstado, via STATUS.
  // Esperar a resposta final aqui dava "message channel closed" sempre que o
  // service worker dormia ou o painel era recriado pela navegação.
  chrome.runtime.sendMessage({
    tipo: unico ? "PESQUISAR" : "PESQUISAR_FILA",
    cfg: configuracao(unico ? { termo: fila[0] } : { termos: fila }),
  }, () => {
    if (chrome.runtime.lastError) { /* worker reiniciou: o STATUS resolve */ }
    sincronizarEstado();
  });
};

$("#auto-min").onchange = (e) => chrome.storage.local.set({ autoMin: Number(e.target.value) });
chrome.storage.local.get("autoMin").then((s) => { if (s.autoMin) $("#auto-min").value = String(s.autoMin); });

$("#btn-auto").onclick = () => {
  const minutos = Number($("#auto-min").value || 10);
  $("#btn-pesquisar").disabled = true;
  $("#btn-auto").disabled = true;
  $("#btn-parar").hidden = false;
  estado(`Mineração automática por ${minutos} min começando…`);
  chrome.runtime.sendMessage({
    tipo: "MINERAR_AUTO",
    cfg: configuracao({ minutos }),
  }, () => {
    if (chrome.runtime.lastError) { /* worker reiniciou: o STATUS resolve */ }
    sincronizarEstado();
  });
};

$("#btn-fotos").onclick = () => {
  $("#btn-pesquisar").disabled = true;
  $("#btn-parar").hidden = false;
  estado("Buscando anunciantes sem foto…");
  chrome.runtime.sendMessage({
    tipo: "RECUPERAR_FOTOS",
    cfg: { soLow: $("#fotos-low").checked, max: 30 },
  }, () => {
    if (chrome.runtime.lastError) { /* worker reiniciou: o STATUS resolve */ }
    sincronizarEstado();
  });
};

function estado(texto, erro = false) {
  const el = $("#status");
  el.textContent = texto;
  el.classList.toggle("erro", !!erro);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tipo === "PROGRESSO") estado(msg.estado.texto, msg.estado.erro);
});

// Estado real vem do background, não da memória desta janela: assim o PARAR
// aparece mesmo se o popup (ou o painel flutuante) tiver sido recriado no meio
// da pesquisa.
let sincronizando = false;

function sincronizarEstado() {
  chrome.runtime.sendMessage({ tipo: "STATUS" }, (st) => {
    if (chrome.runtime.lastError || !st) return;
    const ativo = !!(st.rodando || st.filaEmCurso);
    $("#btn-parar").hidden = !ativo;
    $("#btn-pesquisar").disabled = ativo;
    $("#btn-fotos").disabled = ativo;
    $("#btn-auto").disabled = ativo;
    if (st.texto && Date.now() - st.em < 10 * 60 * 1000) estado(st.texto, st.erro);
    sincronizando = ativo;
  });
}

sincronizarEstado();
setInterval(sincronizarEstado, 1500);

mostrar();
