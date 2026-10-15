// Content script (world ISOLATED) na Biblioteca de Anúncios.
// Recebe os corpos GraphQL do hook.js, extrai os anúncios e, quando o
// background pede, faz o scroll de paginação até juntar o alvo.

const anuncios = new Map();

// overlay.js roda no mesmo world isolado e lê daqui os dados já normalizados —
// é o que alimenta os botões de cópia em cima de cada anúncio.
window.__minerador = { anuncios };

// ------------------------------------------------------------------ captura

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.__minerador !== "graphql") return;
  for (const obj of parseCorpos(d.corpo)) coletarDaArvore(obj);
});

function parseCorpos(texto) {
  let t = String(texto || "").trim();
  if (t.startsWith("for (;;);")) t = t.slice(9);
  const objs = [];
  try {
    objs.push(JSON.parse(t));
    return objs;
  } catch (e) {}
  for (const linha of t.split("\n")) {
    const l = linha.trim();
    if (!l) continue;
    try { objs.push(JSON.parse(l)); } catch (e) {}
  }
  return objs;
}

// Anda a árvore inteira do JSON atrás de qualquer nó com ad_archive_id.
// Assim mudanças de schema da Meta não quebram a coleta.
function coletarDaArvore(no) {
  if (!no || typeof no !== "object") return;
  if (Array.isArray(no)) {
    for (const item of no) coletarDaArvore(item);
    return;
  }
  if (no.ad_archive_id) {
    const norm = normalizar(no);
    if (norm.ad_archive_id) {
      const antigo = anuncios.get(norm.ad_archive_id);
      if (!antigo) agendarEnvio();
      // Mantém a versão mais completa (às vezes o mesmo ad vem em 2 respostas).
      anuncios.set(norm.ad_archive_id, antigo ? Object.assign({}, antigo, limparVazios(norm)) : norm);
    }
  }
  for (const k in no) coletarDaArvore(no[k]);
}

// ------------------------------------------------------------------ envio contínuo

// A pesquisa automática (passiva) antes tirava uma "foto" única 2,5s depois do
// carregamento, disparada por um evento do Chrome que às vezes nem chegava:
// recarregar às vezes não mandava nada, e o que aparecia rolando a página ou
// trocando a busca nunca era enviado. Agora a própria página avisa o
// background sempre que surgem anúncios novos; o background decide se manda
// (pesquisa automática ligada, nenhuma pesquisa ativa cuidando disso).
const enviados = new Set();
let timerEnvio = null;
const ABA_DE_TRABALHO = location.hash.includes("mn-contagem");

function agendarEnvio() {
  if (ABA_DE_TRABALHO) return;          // a aba de fundo é da varredura, que envia sozinha
  clearTimeout(timerEnvio);
  timerEnvio = setTimeout(enviarNovos, 3000);
}

async function enviarNovos() {
  const novos = [...anuncios.values()].filter((a) => !enviados.has(a.ad_archive_id)).slice(0, 200);
  if (!novos.length) return;
  let r;
  try {
    r = await chrome.runtime.sendMessage({ tipo: "CAPTURADOS", anuncios: novos, url: location.href });
  } catch (e) {
    return;                              // extensão recarregada: a próxima leva tenta de novo
  }
  if (r && r.marcar) for (const a of novos) enviados.add(a.ad_archive_id);
  if (anuncios.size > enviados.size && r && r.marcar) agendarEnvio();   // sobrou além dos 200
}

function limparVazios(o) {
  const saida = {};
  for (const k in o) if (o[k] !== "" && o[k] != null) saida[k] = o[k];
  return saida;
}

function txt(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

// A mídia mora em snapshot.videos[], snapshot.images[] ou snapshot.cards[]
// (carrossel), com os mesmos nomes de campo nos três. Procura na ordem pedida.
function primeiro(snap, campos) {
  const fontes = [].concat(snap.videos || [], snap.images || [], snap.cards || []);
  for (const campo of campos) {
    for (const fonte of fontes) {
      if (fonte && typeof fonte[campo] === "string" && fonte[campo]) return fonte[campo];
    }
  }
  return "";
}

function normalizar(bruto) {
  const snap = bruto.snapshot || {};
  let corpo = "";
  if (snap.body && typeof snap.body === "object") {
    corpo = snap.body.text || (snap.body.markup && snap.body.markup.__html) || "";
  } else if (typeof snap.body === "string") {
    corpo = snap.body;
  }
  corpo = txt(String(corpo).replace(/<[^>]+>/g, " "));

  // Anúncio de catálogo: a copy vem como molde ("{{product.brand}}") e o texto
  // de verdade mora em cada cartão.
  const cartoes = snap.cards || [];
  if (corpo.includes("{{")) {
    const c = cartoes.find((x) => x && (x.body || x.title));
    corpo = c ? txt(String(c.body || c.title).replace(/<[^>]+>/g, " ")) : "";
  }

  // Vídeo de catálogo também chega em cards[] — antes virava "imagem".
  const temVideo = (snap.videos && snap.videos.length)
    || cartoes.some((x) => x && (x.video_sd_url || x.video_hd_url));
  const midia = [];
  if (temVideo) midia.push("video");
  if ((snap.images && snap.images.length) || cartoes.some((x) => x && x.resized_image_url)) midia.push("imagem");

  let plats = bruto.publisher_platform || snap.publisher_platform || [];
  if (typeof plats === "string") plats = [plats];

  return {
    ad_archive_id: String(bruto.ad_archive_id || ""),
    page_id: String(bruto.page_id || snap.page_id || ""),
    page_name: txt(bruto.page_name || snap.page_name),
    is_active: bruto.is_active !== false,
    start_date: Number(bruto.start_date || 0) || null,
    end_date: Number(bruto.end_date || 0) || null,
    plataformas: plats.map((p) => String(p).toLowerCase()).join(","),
    cta_text: txt(snap.cta_text),
    link_url: snap.link_url || "",
    titulo: txt(snap.title),
    legenda: txt(snap.caption),
    descricao: txt(snap.link_description),
    // três URLs por anúncio: a boa para baixar (hd), a leve para a capa em
    // vídeo (sd) e o quadro de pré-visualização (poster). Todas assinadas e
    // com validade curta — o backend copia para o Blob.
    midia_url: primeiro(snap, ["video_hd_url", "video_sd_url",
                               "original_image_url", "resized_image_url"]),
    midia_sd: primeiro(snap, ["video_sd_url", "video_hd_url"]),
    midia_poster: primeiro(snap, ["video_preview_image_url",
                                  "resized_image_url", "original_image_url"]),
    texto: corpo.slice(0, 1500),
    midia: midia.join("+"),
    variacoes: Number(bruto.collation_count || bruto.total || 1) || 1,
  };
}

// A primeira leva de anúncios não vem por GraphQL: o Facebook embute o JSON em
// <script> no próprio HTML. Sem varrer isso, os primeiros cartões da página
// ficam de fora da coleta (e sem dados para a barra de cópia).
function varrerScripts() {
  for (const s of document.querySelectorAll("script")) {
    const t = s.textContent || "";
    if (t.length < 80 || t.indexOf("ad_archive_id") === -1) continue;
    for (const obj of parseCorpos(t)) coletarDaArvore(obj);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", varrerScripts);
} else {
  varrerScripts();
}
// O React ainda injeta script depois do DOMContentLoaded.
setTimeout(varrerScripts, 2500);

// ------------------------------------------------------------------ paginação

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// A rolagem automática pode durar minutos. Enquanto ela roda, a página mostra
// quem está mexendo nela e um botão de parar; e qualquer gesto seu de rolagem
// (roda do mouse, teclas, toque) interrompe na hora — quem pegou a barra de
// rolagem de volta é você.
let coletando = false;
let pedidoParar = false;
let faixa;

function mostrarFaixa(texto) {
  if (!faixa) {
    faixa = document.createElement("div");
    faixa.className = "mn-coleta";
    faixa.innerHTML = '<span class="mn-coleta-txt"></span>'
      + '<button type="button" class="mn-coleta-parar">parar</button>';
    faixa.querySelector("button").onclick = () => { pedidoParar = true; };
    document.body.appendChild(faixa);
  }
  faixa.querySelector(".mn-coleta-txt").textContent = texto;
  faixa.hidden = false;
}

function esconderFaixa() {
  if (faixa) faixa.hidden = true;
}

// O freio por gesto precisa ser deliberado. Abortar em qualquer wheel/tecla
// fazia a coleta morrer no meio só porque você mexeu na roda do mouse — parecia
// travamento. Agora só para em: rolar PARA CIMA (você está brigando com a
// rolagem), Esc/PageUp/Home, ou o botão da faixa.
addEventListener("wheel", (ev) => {
  if (coletando && ev.deltaY < 0) pedidoParar = true;
}, { passive: true });

addEventListener("keydown", (ev) => {
  if (coletando && ["Escape", "PageUp", "Home"].includes(ev.key)) pedidoParar = true;
}, { passive: true });

async function rolarAteJuntar({ alvo, timeoutMs, paradasMax = 12 }) {
  const inicio = Date.now();
  let parados = 0;
  let anterior = -1;
  coletando = true;
  pedidoParar = false;

  try {
    // `paradasMax` é quantas rodadas sem anúncio novo antes de desistir. Com 5
    // (o valor antigo) uma pesquisa de 5 minutos morria em ~10 segundos: basta a
    // Biblioteca demorar para paginar.
    while (anuncios.size < alvo && parados < paradasMax && !pedidoParar
           && Date.now() - inicio < timeoutMs) {
      const restam = Math.ceil((timeoutMs - (Date.now() - inicio)) / 1000);
      mostrarFaixa(`Minerador coletando… ${anuncios.size} anúncios · ${restam}s`
        + " — role para cima ou Esc para parar");
      window.scrollTo(0, document.body.scrollHeight);
      // Alguns layouts paginam num container interno em vez do body.
      for (const el of document.querySelectorAll('div[style*="overflow"]')) {
        if (el.scrollHeight > el.clientHeight + 200) el.scrollTop = el.scrollHeight;
      }
      await esperar(1800);
      if (anuncios.size === anterior) parados++;
      else parados = 0;
      anterior = anuncios.size;
    }
  } finally {
    coletando = false;
    esconderFaixa();
  }
  return [...anuncios.values()];
}

function fecharAvisos() {
  const textos = [/recusar cookies opcionais/i, /decline optional cookies/i];
  for (const b of document.querySelectorAll('div[role="button"], button')) {
    const t = (b.innerText || "").trim();
    if (textos.some((re) => re.test(t))) { b.click(); return; }
  }
  const fechar = document.querySelector('[aria-label="Fechar"], [aria-label="Close"]');
  if (fechar) fechar.click();
}

// ------------------------------------------------------------------ mensagens

chrome.runtime.onMessage.addListener((msg, _remetente, responder) => {
  if (msg.tipo === "PING") { responder({ pronto: true, coletados: anuncios.size }); return; }

  if (msg.tipo === "ZERAR") { anuncios.clear(); enviados.clear(); responder({ ok: true }); return; }

  // Freio de mão: para a rolagem em andamento, venha de onde vier.
  if (msg.tipo === "PARAR_COLETA") {
    pedidoParar = true;
    responder({ ok: true, estava: coletando });
    return;
  }

  if (msg.tipo === "COLETAR") {
    (async () => {
      await esperar(2500);
      fecharAvisos();
      // `rolar: false` é o modo passivo: pega o que a página já carregou e não
      // encosta na barra de rolagem. É assim que a pesquisa automática deve se
      // comportar — quem está lendo a Biblioteca não pediu para ser rolado.
      const lista = msg.rolar === false
        ? [...anuncios.values()]
        : await rolarAteJuntar({
          alvo: msg.alvo || 50,
          timeoutMs: msg.timeoutMs || 300000,
          paradasMax: msg.paradasMax || 12,
        });
      responder({ anuncios: lista });
    })();
    return true; // resposta assíncrona
  }
});
