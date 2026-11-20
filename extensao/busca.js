// Fonte única de como o WaveMiner monta uma busca na Biblioteca de Anúncios.
//
// Antes eram três jeitos: o popup (com idioma e corte de dias), a grade (sem os
// dois) e a varredura. O mesmo termo dava resultados diferentes conforme o
// botão, e "Minerar esta busca" na grade navegava para OUTRA busca — a URL do
// minerador tinha o corte de dias e a da grade não.
//
// Carregado em três lugares: no service worker (importScripts), no popup
// (<script>) e na página da Biblioteca (content script, antes de visao.js).
// Nomes com prefixo wm: os content scripts dividem o escopo global (checar.js).

const WM_PAISES_ES = ["MX", "AR", "CO", "CL", "PE", "EC", "UY", "ES"];

// Padrões da pesquisa: os mesmos no popup e na grade.
const WM_PADROES = { minAds: 2, minDias: 3, maxAnuncios: 150, timeout: 300, paradas: 12,
                     maxAnunciantes: 8 };

// Termo entre aspas pede a frase exata, igual na própria Biblioteca.
const wmFraseExata = (termo) => /^".+"$/.test(String(termo || "").trim());

// AAAA-MM-DD de N dias atrás, no fuso de quem está usando.
function wmDiaAtras(n) {
  const d = new Date(Date.now() - n * 86400000);
  const dois = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}

// "es" | "pt": idioma escolhido ou, sem escolha, o do país.
function wmIdiomaDe(pais, idioma) {
  if (idioma) return idioma === "es" ? "es" : "pt";
  return WM_PAISES_ES.includes(pais || "BR") ? "es" : "pt";
}

function wmUrlBusca({ termo, pageId, pais = "BR", ativos = true, idioma = "", minDias = 0 }) {
  const p = [
    `active_status=${ativos ? "active" : "all"}`,
    "ad_type=all",
    `country=${encodeURIComponent(pais || "BR")}`,
    "is_targeted_country=false",
    "media_type=all",
  ];
  // Com país hispano + idioma "es" a busca deixa de trazer anúncio em inglês
  // ou português rodando no mesmo mercado.
  if (idioma) p.push(`content_languages[0]=${encodeURIComponent(idioma)}`);
  if (pageId) {
    p.push(`view_all_page_id=${encodeURIComponent(pageId)}`, "search_type=page");
  } else {
    termo = String(termo || "").trim();
    p.push(`q=${encodeURIComponent(termo)}`,
      `search_type=${wmFraseExata(termo) ? "keyword_exact_phrase" : "keyword_unordered"}`,
      // quem mais entrega primeiro: o topo da busca é o que está escalando
      "sort_data[mode]=total_impressions", "sort_data[direction]=desc");
    // O corte de dias vai na própria Biblioteca, que lê a data como "antes de":
    // (minDias - 1) dias atrás devolve o que começou há minDias ou mais.
    if (minDias > 0) p.push(`start_date[max]=${wmDiaAtras(minDias - 1)}`);
  }
  return "https://www.facebook.com/ads/library/?" + p.join("&");
}

// Mesma busca? Então não recarrega a aba: recarregar joga fora o que a página
// já carregou. Compara só o que muda o resultado.
function wmMesmaBusca(a, b) {
  try {
    const [x, y] = [new URL(a).searchParams, new URL(b).searchParams];
    const igual = (k) => (x.get(k) || "") === (y.get(k) || "");
    const chaves = ["q", "country", "active_status", "view_all_page_id", "start_date[max]",
                    "content_languages[0]"];
    if (!chaves.every(igual)) return false;
    // frase exata e palavras soltas são buscas diferentes com o mesmo `q`
    const exata = (s) => s.get("search_type") === "keyword_exact_phrase";
    return exata(x) === exata(y);
  } catch (e) {
    return false;
  }
}

// O que a busca aberta na aba pede, lido da URL — para a grade mostrar o corte.
function wmLerBusca(url) {
  let s;
  try { s = new URL(url).searchParams; } catch (e) { s = new URLSearchParams(); }
  const max = s.get("start_date[max]");
  let minDias = 0;
  if (max && /^\d{4}-\d{2}-\d{2}$/.test(max)) {
    const [a, m, d] = max.split("-").map(Number);
    minDias = Math.max(0, Math.floor((Date.now() - new Date(a, m - 1, d).getTime()) / 86400000) + 1);
  }
  return { termo: s.get("q") || "", pais: s.get("country") || "", pageId: s.get("view_all_page_id") || "",
           idioma: s.get("content_languages[0]") || "", minDias };
}

// Configuração da pesquisa a partir do que está salvo: popup e grade mandam
// exatamente o mesmo pedido ao background.
function wmConfigPesquisa(s, extra = {}) {
  const n = (v, padrao) => (v == null || v === "" || Number.isNaN(Number(v)) ? padrao : Number(v));
  return {
    pais: s.pais || "BR",
    idioma: s.idioma || "",
    minAnuncios: Math.max(1, n(s.minAds, WM_PADROES.minAds)),
    minDias: Math.max(0, n(s.minDias, WM_PADROES.minDias)),
    // 60 guardado era o padrão antigo, pequeno demais para só low ticket
    maxAnuncios: s.maxAnuncios == null || s.maxAnuncios === 60 ? WM_PADROES.maxAnuncios : n(s.maxAnuncios, WM_PADROES.maxAnuncios),
    timeoutMs: n(s.timeout, WM_PADROES.timeout) * 1000,
    paradasMax: n(s.paradas, WM_PADROES.paradas),
    varreduraProfunda: !!s.profunda,
    maxAnunciantes: n(s.maxAnunciantes, WM_PADROES.maxAnunciantes),
    usarAbaAtual: !!s.usarAbaAtual,
    abrirDashboard: !!s.abrirDashboard,
    ...extra,
  };
}

// Chaves do storage que wmConfigPesquisa lê.
const WM_CHAVES_CONFIG = ["pais", "idioma", "minAds", "minDias", "maxAnuncios", "timeout", "paradas",
                          "profunda", "maxAnunciantes", "usarAbaAtual", "abrirDashboard"];

// Sugestões de partida, voltadas a oferta de entrada. Uma lista só para o popup
// e a tela inicial da grade.
const WM_SUGESTOES = {
  pt: [
    ["Renda extra", ["renda extra em casa", "trabalhe de casa", "ganhar dinheiro online", "vendas pelo celular", "afiliado iniciante"]],
    ["Emagrecimento", ["secar barriga", "cardápio para emagrecer", "chá emagrecedor", "treino em casa", "receitas low carb"]],
    ["Receitas e confeitaria", ["apostila de receitas", "bolo no pote", "doces para vender", "marmitas fit", "pão caseiro"]],
    ["Artesanato", ["moldes de crochê", "curso de amigurumi", "costura para iniciantes", "laços de cabelo", "velas artesanais"]],
    ["Educação infantil", ["atividades para imprimir", "alfabetização em casa", "kit pedagógico", "caderno de caligrafia", "jogos educativos"]],
    ["Idiomas e concursos", ["inglês do zero", "espanhol para iniciantes", "apostila concurso", "mapas mentais", "resumos para prova"]],
    ["Fé e espiritualidade", ["devocional diário", "estudo bíblico", "oração poderosa", "planner cristão", "salmos para imprimir"]],
    ["Relacionamento", ["reconquistar o amor", "salvar o casamento", "autoestima feminina", "ansiedade e sono", "inteligência emocional"]],
    ["Gatilhos de oferta", ['"acesso imediato"', '"pagamento único"', '"por apenas r$"', '"receba no email"', '"garantia de 7 dias"']],
  ],
  es: [
    ["Ingresos extra", ["ingresos extra desde casa", "trabajar desde casa", "ganar dinero online", "vender por el celular", "afiliados para principiantes"]],
    ["Bajar de peso", ["bajar de peso rápido", "menú para adelgazar", "té para adelgazar", "rutina en casa", "recetas low carb"]],
    ["Recetas y repostería", ["recetario", "postres para vender", "pan casero", "comida saludable", "tortas para vender"]],
    ["Manualidades", ["moldes de crochet", "curso de amigurumi", "costura para principiantes", "moños para el cabello", "velas artesanales"]],
    ["Educación infantil", ["actividades para imprimir", "lectoescritura", "material didáctico", "cuadernos de caligrafía", "juegos educativos"]],
    ["Idiomas y exámenes", ["inglés desde cero", "guía de estudio", "mapas mentales", "resúmenes para examen"]],
    ["Fe y espiritualidad", ["devocional diario", "estudio bíblico", "oración poderosa", "planner cristiano"]],
    ["Relaciones", ["recuperar a tu ex", "salvar el matrimonio", "autoestima", "ansiedad y sueño"]],
    ["Gatillos de oferta", ['"acceso inmediato"', '"pago único"', '"por solo"', '"garantía de 7 días"']],
  ],
};

const wmSugestoes = (pais, idioma) => WM_SUGESTOES[wmIdiomaDe(pais, idioma)];
