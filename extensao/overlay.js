// Aba de contagem aberta pela varredura profunda: nada de interface nela.
// Nome prefixado de propósito — content scripts do mesmo world dividem o
// escopo global, e um `const` repetido derruba o arquivo seguinte.
const mnOverlayEmContagem = location.hash.includes("mn-contagem");

// Barra de cópia em cima de cada anúncio da Biblioteca de Anúncios.
//
// Os dados vêm do que o content.js já capturou do GraphQL (window.__minerador),
// não do DOM: o texto do cartão vem truncado com "Ver mais" e sem link_url. O
// DOM serve só para achar o cartão e o identificador dele.

// pt: "Identificação da biblioteca:"  es: "Identificador de la biblioteca:"
// en: "Library ID:"  — o trecho do meio varia, o número é o que importa.
const RE_ID = /(?:identifica[^:]{0,30}biblioteca|library id)\s*[:：]?\s*(\d{6,})/i;

// Texto de metadado do próprio cartão — nunca é a copy do anúncio.
const RE_META = /identifica\w*\s+d[ae]|library id|veicula[çc]|plataformas|patrocinad|ver detalhes|an[úu]ncios? usam|este an[úu]ncio/i;

const ICONES = {
  baixar: '<svg viewBox="0 0 16 16"><path d="M8 1v8.2l3-3 1 1.1-4.7 4.6L2.6 7.3l1-1.1 3 3V1h1.4zM2 13.2h12V15H2z"/></svg>',
  copiar: '<svg viewBox="0 0 16 16"><path d="M5.5 1h7A1.5 1.5 0 0 1 14 2.5v9h-1.6v-9h-7V1zM3.5 3.5h6A1.5 1.5 0 0 1 11 5v9a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 2 14V5a1.5 1.5 0 0 1 1.5-1.5z"/></svg>',
  salvar: '<svg viewBox="0 0 16 16"><path d="M8 1.5 9.9 5.6l4.5.5-3.3 3 .9 4.4L8 11.3 4 13.5l.9-4.4-3.3-3 4.5-.5z"/></svg>',
  painel: '<svg viewBox="0 0 16 16"><path d="M1.5 2h13v2.4h-13zm0 3.8h13v2.4h-13zm0 3.8h13V12h-13z"/></svg>',
};

// rótulo -> como montar o texto a partir do anúncio normalizado
const ITENS = [
  ["Texto principal", (a) => a.texto],
  ["Título", (a) => a.titulo],
  ["Descrição", (a) => a.descricao],
  ["URL do site", (a) => a.link_url],
  ["Chamada para ação", (a) => a.cta_text],
  ["URL do anúncio na Biblioteca", (a) => urlBiblioteca(a.ad_archive_id)],
  ["Todas as informações", (a) => tudo(a)],
];

const urlBiblioteca = (id) => `https://www.facebook.com/ads/library/?id=${id}`;

function data(epoch) {
  if (!epoch) return "";
  return new Date(epoch * 1000).toLocaleDateString("pt-BR");
}

const diasRodando = (epoch) =>
  (epoch ? Math.max(0, Math.floor((Date.now() / 1000 - epoch) / 86400)) : null);

// "há 3 meses (94 dias)" — o número cru é o que serve para comparar ofertas.
function tempoRodando(a) {
  const d = diasRodando(a.start_date);
  if (d === null) return "";
  if (d < 30) return `${d} dia${d === 1 ? "" : "s"}`;
  const meses = Math.floor(d / 30);
  return `${d} dias · ${meses} ${meses === 1 ? "mês" : "meses"}`;
}

function tudo(a) {
  return [
    ["Anunciante", a.page_name],
    ["Identificador", a.ad_archive_id],
    ["Ativo", a.is_active ? "sim" : "não"],
    ["Veiculação desde", data(a.start_date)],
    ["Tempo rodando", tempoRodando(a)],
    ["Variações do criativo", a.variacoes],
    ["Plataformas", a.plataformas],
    ["Mídia", a.midia],
    ["Título", a.titulo],
    ["Descrição", a.descricao],
    ["Chamada para ação", a.cta_text],
    ["URL do site", a.link_url],
    ["URL na Biblioteca", urlBiblioteca(a.ad_archive_id)],
    ["Texto principal", "\n" + (a.texto || "")],
  ].filter(([, v]) => v !== "" && v != null)
    .map(([r, v]) => `${r}: ${v}`).join("\n");
}

// ------------------------------------------------------------------ avisos

let aviso;
function avisar(texto, erro = false) {
  if (!aviso) {
    aviso = document.createElement("div");
    aviso.className = "mn-aviso";
    document.body.appendChild(aviso);
  }
  aviso.textContent = texto;
  aviso.classList.toggle("mn-erro", erro);
  aviso.classList.add("mn-visivel");
  clearTimeout(aviso.__t);
  aviso.__t = setTimeout(() => aviso.classList.remove("mn-visivel"), 1600);
}

// Depois que a extensão é recarregada, a aba antiga continua com o script
// velho: qualquer chrome.runtime.* estoura com "Extension context invalidated"
// e o clique não faz absolutamente nada. Sem esta checagem o botão parece
// quebrado, quando o que falta é dar F5 na página.
const extensaoViva = () => {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
};

async function mandar(msg) {
  if (!extensaoViva()) {
    throw new Error("A extensão foi recarregada — atualize esta página (F5).");
  }
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    if (/context invalidated|Receiving end does not exist/i.test(e.message || "")) {
      throw new Error("A extensão foi recarregada — atualize esta página (F5).");
    }
    throw e;
  }
}

async function copiar(texto, rotulo) {
  if (!texto) return avisar(`${rotulo}: esse anúncio não tem`, true);
  try {
    await navigator.clipboard.writeText(texto);
    avisar(`${rotulo} copiado`);
  } catch (e) {
    // clipboard bloqueado (aba sem foco): cai no caminho antigo
    const ta = document.createElement("textarea");
    ta.value = texto;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    avisar(ok ? `${rotulo} copiado` : "Não consegui copiar", !ok);
  }
}

// ------------------------------------------------------------------ cartões

const capturado = (id) => (window.__minerador && window.__minerador.anuncios.get(id)) || null;

// Destino real por trás do redirecionador do Facebook (l.facebook.com/l.php?u=…).
function limparLink(href) {
  try {
    const u = new URL(href, location.href);
    if (/(^|\.)facebook\.com$/.test(u.hostname) && u.searchParams.get("u")) {
      return u.searchParams.get("u").split("?fbclid")[0];
    }
    return /(^|\.)facebook\.com$/.test(u.hostname) ? "" : u.href;
  } catch (e) {
    return "";
  }
}

// Cartão que ainda não apareceu numa resposta GraphQL (rolagem rápida, aba
// aberta antes da extensão): dá para tirar do próprio DOM o essencial.
function doCartao(cartao, id) {
  const textos = [...cartao.querySelectorAll("div, span")]
    .map((e) => (e.childElementCount === 0 ? (e.textContent || "").trim() : ""))
    .filter((t) => t.length > 40 && !RE_META.test(t));
  const links = [...cartao.querySelectorAll("a[href]")]
    .map((a) => limparLink(a.getAttribute("href"))).filter(Boolean);
  const cta = [...cartao.querySelectorAll('div[role="button"], a[role="button"]')]
    .map((e) => (e.textContent || "").trim())
    .find((t) => t && t.length < 30);
  return {
    ad_archive_id: id,
    page_name: (cartao.querySelector("a[href*='/profile'], strong, h3") || {}).textContent || "",
    texto: textos.sort((a, b) => b.length - a.length)[0] || "",
    titulo: "", descricao: "", legenda: "",
    link_url: links[0] || "",
    cta_text: cta || "",
    plataformas: "", midia: "", midia_url: "",
    is_active: true, start_date: null, variacoes: 1,
    parcial: true,
  };
}

const anuncioDe = (id, cartao) => capturado(id) || (cartao ? doCartao(cartao, id) : null);

// Sobe do texto "Identificador da biblioteca: N" até o elemento que embrulha o
// anúncio inteiro: o último ancestral que ainda contém um único identificador.
function cartaoDe(no) {
  let el = no.parentElement;
  let melhor = null;
  for (let i = 0; el && i < 14; i++, el = el.parentElement) {
    const ids = (el.innerText || "").match(/\d{6,}/g) || [];
    const unicos = new Set(ids);
    if (unicos.size > 1) break;
    if (el.offsetHeight > 150) melhor = el;
  }
  return melhor;
}

function textosComId() {
  const achados = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (RE_ID.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) achados.push(n);
  return achados;
}

function montarBarra(id, cartao) {
  const barra = document.createElement("div");
  barra.className = "mn-barra";
  barra.innerHTML = `
    <button class="mn-btn" data-mn="baixar" title="Abrir a mídia em outra aba">${ICONES.baixar}</button>
    <button class="mn-btn mn-verde" data-mn="copiar">${ICONES.copiar}COPIAR</button>
    <button class="mn-btn" data-mn="salvar" title="Salvar este anúncio no minerador">${ICONES.salvar}</button>
    <button class="mn-btn" data-mn="painel" title="Abrir o painel">${ICONES.painel}</button>
    <span class="mn-tempo" hidden></span>
    <div class="mn-menu"></div>`;

  // Quanto tempo este anúncio já roda: a Biblioteca mostra a data de início,
  // não o tempo decorrido, que é o que interessa para julgar a oferta.
  const selo = barra.querySelector(".mn-tempo");
  const anuncio = anuncioDe(id, cartao);
  const d = anuncio && diasRodando(anuncio.start_date);
  if (d !== null && d !== undefined) {
    selo.hidden = false;
    selo.textContent = tempoRodando(anuncio);
    selo.title = `no ar desde ${data(anuncio.start_date)}`;
    selo.classList.toggle("mn-veterano", d >= 60);
  }

  const menu = barra.querySelector(".mn-menu");
  menu.innerHTML = ITENS.map(([rot], i) => `<button data-i="${i}">${rot}</button>`).join("");

  barra.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();

    if (btn.dataset.i !== undefined) {
      const [rot, pegar] = ITENS[Number(btn.dataset.i)];
      menu.classList.remove("mn-aberto");
      return copiar(String(pegar(anuncioDe(id, cartao)) || ""), rot);
    }

    const acao = btn.dataset.mn;
    if (acao === "copiar") return menu.classList.toggle("mn-aberto");
    menu.classList.remove("mn-aberto");

    if (acao === "painel") {
      return mandar({ tipo: "ABRIR_PAINEL" }).catch((e) => avisar(e.message, true));
    }
    const a = anuncioDe(id, cartao);
    if (acao === "baixar") {
      // A URL da mídia só vem no JSON do GraphQL; o <img> do cartão é recorte.
      if (!a.midia_url) return avisar("Mídia ainda não capturada — recarregue a página", true);
      return window.open(a.midia_url, "_blank", "noopener");
    }
    if (acao === "salvar") {
      const pais = new URLSearchParams(location.search).get("country") || "BR";
      avisar("Salvando…");
      try {
        const r = await mandar({ tipo: "SALVAR_UM", anuncio: a, pais });
        if (!r || !r.ok) return avisar((r && r.erro) || "Falhou ao salvar", true);
        avisar(r.melhores ? "Salvo em ★ Melhores"
                          : "Salvo nos resultados (sem anunciante para Melhores)");
      } catch (e) {
        avisar(e.message, true);
      }
    }
  });

  return barra;
}

function marcar() {
  for (const no of textosComId()) {
    const id = (no.data.match(RE_ID) || [])[1];
    if (!id) continue;
    const cartao = cartaoDe(no);
    // A Biblioteca re-renderiza: sem esta guarda o mesmo anúncio ganharia uma
    // segunda barra num ancestral diferente.
    if (!cartao || cartao.dataset.mnId
        || cartao.closest("[data-mn-id]") || cartao.querySelector("[data-mn-id]")) continue;
    cartao.dataset.mnId = id;
    cartao.classList.add("mn-cartao");
    cartao.appendChild(montarBarra(id, cartao));
  }
}

// A Biblioteca recicla os cartões enquanto você rola: reagir a mutação, mas
// no máximo uma varredura a cada 600ms.
let agendado = false;
function agendar() {
  if (agendado) return;
  agendado = true;
  setTimeout(() => { agendado = false; marcar(); }, 600);
}

document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".mn-barra")) {
    document.querySelectorAll(".mn-menu.mn-aberto").forEach((m) => m.classList.remove("mn-aberto"));
  }
}, true);

function iniciar() {
  marcar();
  new MutationObserver(agendar).observe(document.body, { childList: true, subtree: true });
}

if (!mnOverlayEmContagem) {
  if (document.body) iniciar();
  else document.addEventListener("DOMContentLoaded", iniciar);
}
