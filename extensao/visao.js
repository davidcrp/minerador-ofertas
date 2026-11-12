// Visão em grade: mostra os anúncios capturados por content.js numa tela própria,
// com filtros e agrupamento, por cima da Biblioteca de Anúncios.
//
// Abrir esta tela não coleta nem envia nada: ela só desenha o que a página já
// carregou. Rolar a página e minerar continuam dependendo de clique.
//
// Shadow DOM isola o visual do CSS do Facebook. IIFE porque os content scripts
// dividem o escopo global (ver checar.js); de overlay.js vêm copiar, tudo,
// avisar, mandar, diasRodando, data e urlBiblioteca; de content.js, rolarAteJuntar.

(() => {
  if (window.top !== window || location.hash.includes("mn-contagem")) return;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .vg {
      --fundo: #04060a; --sup: #0a0f16; --sup2: #121924; --linha: #1a2430; --linha2: #2a3748;
      --txt: #edf2f8; --suave: #8b9cb0; --fraco: #5f7186; --azul: #3b8fff; --azul2: #1f6fe0;
      --azul-esc: #021226; --azul-fundo: #0c2340; --verm: #f05252;
      --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
      position: fixed; inset: 0; z-index: 2147483000;
      display: grid; grid-template-rows: auto minmax(0, 1fr);
      background: var(--fundo); color: var(--txt); color-scheme: dark;
      font: 13px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    button, input, select { font: inherit; color: inherit; }
    button { cursor: pointer; }
    :focus-visible { outline: 2px solid var(--azul); outline-offset: 2px; }

    /* ---- topo ---- */
    .topo {
      display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px;
      padding: 10px 16px 0; border-bottom: 1px solid var(--linha); background: var(--sup);
    }
    .marca { display: flex; align-items: center; gap: 8px; margin-right: 6px; font-size: 15px; font-weight: 700; letter-spacing: -.01em; white-space: nowrap; }
    .marca b { color: var(--azul); font-weight: 700; }
    .onda { display: block; flex: none; fill: none; stroke: var(--azul); stroke-width: 2.4; stroke-linecap: round; }
    .busca {
      display: flex; flex: 1 1 340px; min-width: 260px; height: 38px; padding: 3px;
      border: 1px solid var(--linha2); border-radius: 10px; background: var(--fundo);
    }
    .busca:focus-within { border-color: var(--azul); box-shadow: 0 0 0 3px rgba(59, 143, 255, .16); }
    .busca select, .busca input { height: 100%; border: 0; background: none; outline: 0; }
    .busca select { padding: 0 6px; border-right: 1px solid var(--linha); color: var(--suave); }
    .busca select option { background: var(--sup); color: var(--txt); }
    .busca input { flex: 1; min-width: 0; padding: 0 10px; }
    .busca input::placeholder { color: var(--fraco); }
    .busca button { padding: 0 14px; border: 0; border-radius: 7px; background: var(--sup2); font-weight: 600; }
    .busca button:hover { background: var(--linha2); }
    .campo { height: 34px; padding: 0 10px; border: 1px solid var(--linha); border-radius: 8px; background: var(--fundo); }
    .campo::placeholder { color: var(--fraco); }
    select.campo option { background: var(--sup); }
    .btn {
      height: 38px; padding: 0 14px; border: 1px solid var(--linha2); border-radius: 10px;
      background: none; font-weight: 600; white-space: nowrap;
    }
    .btn:hover:not(:disabled) { background: var(--sup2); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.forte { border-color: var(--azul); background: var(--azul); color: var(--azul-esc); font-weight: 700; }
    .btn.forte:hover:not(:disabled) { border-color: #5ea4ff; background: #5ea4ff; }
    .btn.parar, .btn.parar:hover:not(:disabled) { border-color: var(--verm); background: var(--verm); color: #fff; }
    .topo { position: relative; }
    .topo:has(.guias[hidden]) { padding-bottom: 10px; }
    .guias { flex: 1 0 100%; order: 1; display: flex; align-items: flex-end; gap: 4px; }
    .guia {
      display: flex; align-items: center; gap: 8px; max-width: 340px; padding: 7px 12px;
      border-bottom: 2px solid var(--azul); font-weight: 600;
    }
    .guia span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .guia .num { flex: none; color: var(--fraco); }
    .estado {
      position: absolute; right: 16px; bottom: 8px; max-width: 55%; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; color: var(--suave); font-size: 12px;
    }
    .topo:has(.guias[hidden]) .estado { position: static; flex: 1 0 100%; order: 2; max-width: none; }
    .estado.erro { color: #fca5a5; }

    /* ---- filtros ---- */
    .corpo { display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: 0; }
    .lado, .principal { scrollbar-width: thin; scrollbar-color: var(--linha2) transparent; }
    .lado { overflow-y: auto; overscroll-behavior: contain; padding: 14px 12px 24px; border-right: 1px solid var(--linha); background: var(--sup); }
    .bloco { margin-bottom: 20px; }
    .bloco:last-child { margin-bottom: 0; }
    .rot { display: block; margin-bottom: 8px; color: var(--suave); font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
    .dica { display: block; margin: -5px 0 7px; color: var(--fraco); font-size: 11px; }
    .lado .campo { width: 100%; }
    .par { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .par label { color: var(--fraco); font-size: 11px; }
    .passo { display: grid; grid-template-columns: 26px minmax(0, 1fr) 26px; margin-top: 3px; border: 1px solid var(--linha); border-radius: 8px; background: var(--fundo); }
    .passo:focus-within { border-color: var(--azul); }
    .passo button { padding: 0; border: 0; background: none; color: var(--fraco); font-size: 15px; }
    .passo button:hover { color: var(--txt); }
    .passo input {
      width: 100%; height: 32px; padding: 0; border: 0; outline: 0; background: none; text-align: center;
      font-family: var(--mono); font-size: 12px; appearance: textfield;
    }
    .passo input::-webkit-inner-spin-button { display: none; }
    .check { display: flex; gap: 8px; align-items: center; cursor: pointer; }
    .check input { flex: none; accent-color: var(--azul); }
    .bloqueios { display: grid; gap: 4px; }
    .bloqueio {
      display: grid; grid-template-columns: 18px 1fr auto; align-items: center; gap: 8px; padding: 6px 8px;
      border: 1px solid transparent; border-radius: 7px; background: none; text-align: left; font-weight: 500;
    }
    .bloqueio:hover { background: var(--sup2); }
    .bloqueio svg { display: block; width: 16px; height: 16px; color: var(--suave); fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .bloqueio small { color: var(--fraco); font: 11px var(--mono); }
    .bloqueio[aria-pressed="true"] { border-color: #5c2530; color: #fca5a5; text-decoration: line-through; }
    .bloqueio[aria-pressed="true"] svg, .bloqueio[aria-pressed="true"] small { color: #fca5a5; }
    .anunciante {
      display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px;
      border: 0; border-radius: 7px; background: none; text-align: left;
    }
    .anunciante:hover { background: var(--sup2); }
    .anunciante[aria-pressed="true"] { background: var(--azul-fundo); }
    .anunciante span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .anunciante small, .num { color: var(--fraco); font: 11px var(--mono); }
    .avatar { display: block; flex: none; border-radius: 50%; object-fit: cover; background: var(--sup2); }
    .link { width: 100%; margin-top: 4px; padding: 5px; border: 0; background: none; color: var(--azul); font-size: 12px; }
    .link:hover { text-decoration: underline; }

    /* ---- resultados ---- */
    .principal { overflow-y: auto; overscroll-behavior: contain; padding: 0 18px 60px; }
    .resumo {
      position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px;
      padding: 12px 0; background: var(--fundo);
    }
    .total { flex: 1 1 260px; color: var(--suave); }
    .total b { color: var(--txt); font: 700 20px/1.1 var(--mono); letter-spacing: -.02em; }
    .total small { display: block; margin-top: 2px; color: var(--fraco); font-size: 12px; }
    .abas { display: flex; gap: 2px; padding: 3px; border-radius: 9px; background: var(--sup); }
    .abas button { padding: 5px 10px; border: 0; border-radius: 6px; background: none; color: var(--suave); }
    .abas button:hover { color: var(--txt); }
    .abas button[aria-selected="true"] { background: var(--sup2); color: var(--txt); font-weight: 600; }
    #ordem { height: 36px; border-color: var(--linha2); }

    .grade { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; align-items: start; }
    .card { display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--linha); border-radius: 12px; background: var(--sup); transition: border-color .12s; }
    .card:hover { border-color: var(--linha2); }
    .card.quente { border-color: #1d4176; }
    .card-topo { display: flex; align-items: center; gap: 9px; padding: 9px 8px 9px 11px; }
    .card-nome { flex: 1; min-width: 0; padding: 0; border: 0; background: none; text-align: left; }
    .card-nome b, .card-nome small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-nome b { font-weight: 650; }
    .card-nome:hover:not(:disabled) b { color: var(--azul); }
    .card-nome small { color: var(--fraco); font-size: 11px; }
    .ico {
      display: inline-flex; flex: none; align-items: center; justify-content: center; width: 32px; height: 32px;
      padding: 0; border: 0; border-radius: 8px; background: none; color: var(--suave);
    }
    .ico:hover:not(:disabled) { background: var(--sup2); color: var(--txt); }
    .ico:disabled { opacity: .3; cursor: default; }
    .ico svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .ico.salvo { color: var(--azul); }
    .ico.salvo svg { fill: currentColor; }
    .midia { position: relative; aspect-ratio: 4 / 5; overflow: hidden; background: #000; }
    .midia img, .midia video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .midia video { object-fit: contain; }
    .sem-midia { display: flex; height: 100%; align-items: center; justify-content: center; color: var(--fraco); }
    .selos { position: absolute; top: 8px; left: 8px; right: 8px; display: flex; flex-wrap: wrap; gap: 4px; pointer-events: none; }
    .selo { padding: 2px 7px; border-radius: 6px; background: rgba(4, 6, 10, .84); color: #dfe7f0; font-size: 11px; font-weight: 600; }
    .selo.destaque { background: var(--azul); color: var(--azul-esc); font-weight: 700; }
    .selo.parado { background: #7f1d1d; color: #fff; }
    .play {
      position: absolute; top: 50%; left: 50%; width: 48px; height: 48px; margin: -24px 0 0 -24px;
      border: 0; border-radius: 50%; background: rgba(4, 6, 10, .78); color: #fff; font-size: 15px;
    }
    .play:hover { background: var(--azul); color: var(--azul-esc); }
    .metricas { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--linha); }
    .metrica { padding: 8px 4px 7px; text-align: center; }
    .metrica + .metrica { border-left: 1px solid var(--linha); }
    .metrica b { display: block; font: 700 16px/1.15 var(--mono); letter-spacing: -.02em; }
    .metrica span { color: var(--fraco); font-size: 10.5px; }
    .metrica.alta b { color: var(--azul); }
    .card-txt { padding: 10px 11px 8px; color: #c3cedb; }
    .copy { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; min-height: 57px; overflow-wrap: anywhere; }
    .card-pe { display: flex; align-items: center; gap: 2px; padding: 0 7px 8px 11px; }
    .copiar {
      flex: 1; min-width: 0; height: 32px; margin-right: 4px; padding: 0 6px; border: 1px solid var(--linha2);
      border-radius: 8px; background: none; font-size: 12px; font-weight: 600; white-space: nowrap;
    }
    .copiar:hover { border-color: var(--azul); background: var(--azul-fundo); }

    /* ---- estados ---- */
    .vazio { max-width: 460px; margin: 11vh auto 0; text-align: center; color: var(--suave); }
    .vazio h2 { margin: 0 0 8px; color: var(--txt); font-size: 24px; letter-spacing: -.02em; }
    .mais { display: block; margin: 22px auto 0; }
    .hero { max-width: 780px; margin: 8vh auto 0; text-align: center; color: var(--suave); }
    .hero .onda { margin: 0 auto 16px; }
    .hero h2 { margin: 0 0 8px; color: var(--txt); font-size: 34px; line-height: 1.15; letter-spacing: -.025em; }
    .cats { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; align-items: start; margin-top: 30px; text-align: left; }
    .cats details { border: 1px solid var(--linha); border-radius: 10px; background: var(--sup); }
    .cats details[open] { border-color: var(--linha2); }
    .cats summary { display: flex; justify-content: space-between; padding: 11px 13px; color: var(--txt); font-weight: 600; cursor: pointer; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 13px 13px; }
    .chips button { padding: 5px 10px; border: 1px solid var(--linha2); border-radius: 999px; background: none; font-size: 12px; }
    .chips button:hover { border-color: var(--azul); background: var(--azul-fundo); }

    @media (max-width: 760px) {
      .corpo { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .lado { max-height: 34vh; border-right: 0; border-bottom: 1px solid var(--linha); }
    }
    @media (prefers-reduced-motion: reduce) { .card { transition: none; } }
  `;

  const PAISES = [["BR", "Brasil"], ["PT", "Portugal"], ["MX", "México"], ["AR", "Argentina"],
    ["CO", "Colômbia"], ["CL", "Chile"], ["PE", "Peru"], ["EC", "Equador"], ["UY", "Uruguai"],
    ["ES", "Espanha"], ["US", "Estados Unidos"], ["ALL", "Todos"]];

  const onda = (l) => `<svg class="onda" viewBox="0 0 28 18" width="${l}" height="${l * 18 / 28}" aria-hidden="true"><path d="M2 7c4-5 7-5 10-1.500s7 3.500 14-1.500"/><path d="M2 14c4-5 7-5 10-1.500s7 3.500 14-1.500" opacity=".5"/></svg>`;
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICO = {
    salvar: svg("M6 3h12v18l-6-4-6 4z"),
    baixar: svg("M12 3v12m-5-5 5 5 5-5M4 20h16"),
    biblioteca: svg("M14 4h6v6m0-6-9 9M18 14v6H4V6h6"),
    site: svg("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"),
    copiar: svg("M9 9h11v11H9zM5 15H4V4h11v1"),
  };

  const BLOQUEIOS = [
    ["whatsapp", "WhatsApp", "M4 20l1.5-4.5A8 8 0 1 1 8.5 19z"],
    ["instagram", "Instagram", "M4 8a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM17 7h.01"],
    ["apps", "Apps", "M7 3h10v18H7zM11 18h2"],
    ["semsite", "Sem site", "M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1M4 4l16 16"],
  ];
  // Termos de partida da tela inicial, voltados a oferta de entrada.
  const CATEGORIAS = [
    ["Renda extra", ["renda extra em casa", "trabalhe de casa", "ganhar dinheiro online", "vendas pelo celular", "afiliado iniciante"]],
    ["Emagrecimento", ["secar barriga", "cardápio para emagrecer", "chá emagrecedor", "treino em casa", "receitas low carb"]],
    ["Receitas e confeitaria", ["apostila de receitas", "bolo no pote", "doces para vender", "marmitas fit", "pão caseiro"]],
    ["Artesanato", ["moldes de crochê", "curso de amigurumi", "costura para iniciantes", "laços de cabelo", "velas artesanais"]],
    ["Educação infantil", ["atividades para imprimir", "alfabetização em casa", "kit pedagógico", "caderno de caligrafia", "jogos educativos"]],
    ["Idiomas e concursos", ["inglês do zero", "espanhol para iniciantes", "apostila concurso", "mapas mentais", "resumos para prova"]],
    ["Fé e espiritualidade", ["devocional diário", "estudo bíblico", "oração poderosa", "planner cristão", "salmos para imprimir"]],
    ["Relacionamento", ["reconquistar o amor", "salvar o casamento", "autoestima feminina", "ansiedade e sono", "inteligência emocional"]],
  ];
  const ORDENS = [
    ["variacoes", "Mais anúncios no criativo"], ["dias", "Mais dias no ar"],
    ["recentes", "Mais recentes"], ["anunciante", "Anunciante com mais anúncios"],
  ];
  const ABAS = [["todos", "Todos"], ["video", "Vídeo"], ["imagem", "Imagem"], ["carrossel", "Carrossel"]];

  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const seguro = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
  const mil = (n) => Number(n).toLocaleString("pt-BR");
  const hostDe = (u) => {
    try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; }
  };

  function categoria(a) {
    const h = hostDe(a.link_url);
    if (/(^|\.)(wa\.me|whatsapp\.com)$/.test(h)) return "whatsapp";
    if (/(^|\.)instagram\.com$/.test(h)) return "instagram";
    if (/^(apps\.apple\.com|itunes\.apple\.com|play\.google\.com)$/.test(h)) return "apps";
    if (!h || /(^|\.)(facebook\.com|fb\.me|m\.me)$/.test(h)) return "semsite";
    return "";
  }

  function tipoDe(a) {
    if ((a.n_cartoes || 0) > 1) return "carrossel";
    return (a.midia || "").includes("video") ? "video" : "imagem";
  }

  // ---------------------------------------------------------------- estado

  const params = new URLSearchParams(location.search);
  const termoUrl = params.get("q") || "";
  const paisUrl = params.get("country") || "";
  const emBusca = !!(termoUrl || params.get("view_all_page_id"));

  const filtros = { texto: "", minDias: 0, maxDias: null, minVar: 1, tipo: "todos",
                    ordem: "variacoes", ocultos: [], anunciante: "", unicos: true };
  const GUARDADOS = ["minDias", "minVar", "ordem", "ocultos", "unicos"];
  let salvos = new Set();
  let verTodos = false;
  let carregando = false;
  let minerando = false;

  let host, raiz, grade;
  const cartoes = new Map();

  function guardarFiltros() {
    const f = {};
    for (const k of GUARDADOS) f[k] = filtros[k];
    chrome.storage.local.set({ visaoFiltros: f });
  }

  // ---------------------------------------------------------------- montagem

  const passo = (id, min, valor, dica) => `<div class="passo">
    <button type="button" data-passo="-1" data-alvo="${id}" aria-label="Diminuir">−</button>
    <input id="${id}" type="number" min="${min}" value="${valor}" placeholder="${dica}">
    <button type="button" data-passo="1" data-alvo="${id}" aria-label="Aumentar">+</button>
  </div>`;

  function montar() {
    host = document.createElement("div");
    host.id = "minerador-visao";
    raiz = host.attachShadow({ mode: "open" });
    const opcoes = (lista, atual) => lista.map(([v, r]) =>
      `<option value="${v}"${v === atual ? " selected" : ""}>${esc(r)}</option>`).join("");
    raiz.innerHTML = `<style>${CSS}</style>
      <div class="vg">
        <header class="topo">
          <span class="marca">${onda(26)}<span>Wave<b>Miner</b></span></span>
          <form class="busca">
            <select class="campo" id="pais" aria-label="País">${opcoes(PAISES, paisUrl || "BR")}</select>
            <input class="campo" id="termo" type="search" aria-label="Termo de busca"
                   placeholder='nicho, produto ou "frase exata"' value="${esc(termoUrl)}">
            <button class="btn" type="submit">Buscar</button>
          </form>
          <button class="btn forte" id="minerar" title="Coleta esta busca e envia ao WaveMiner. Gasta 1 uso.">Minerar esta busca</button>
          <button class="btn" id="fechar" title="Volta para a tela original da Biblioteca">Ver Biblioteca</button>
          <div class="estado" id="estado" role="status" hidden></div>
          <nav class="guias" id="guias" aria-label="Busca atual" hidden>
            <div class="guia"><span class="num">${esc(paisUrl || "BR")}</span><span>${esc(termoUrl || "Anunciante")}</span><span class="num" id="guia-n"></span></div>
            <button class="ico" id="nova" title="Nova busca em outra aba" aria-label="Nova busca em outra aba">+</button>
          </nav>
        </header>
        <div class="corpo">
          <aside class="lado" id="lado">
            <div class="bloco"><input class="campo" id="f-texto" type="search" aria-label="Filtrar resultados" placeholder="Buscar nos resultados"></div>
            <div class="bloco">
              <span class="rot">Tempo no ar (dias)</span>
              <div class="par">
                <label>Mín.${passo("f-min", 0, filtros.minDias, "")}</label>
                <label>Máx.${passo("f-max", 0, "", "∞")}</label>
              </div>
            </div>
            <div class="bloco">
              <label class="rot" for="f-var">Variações do criativo</label>
              <span class="dica">Mínimo com o mesmo criativo</span>
              ${passo("f-var", 1, filtros.minVar, "")}
            </div>
            <div class="bloco">
              <label class="check"><input id="f-unicos" type="checkbox"${filtros.unicos ? " checked" : ""}>Juntar cópias do mesmo anúncio</label>
            </div>
            <div class="bloco">
              <span class="rot">Ocultar destinos</span>
              <div class="bloqueios" id="bloqueios"></div>
            </div>
            <div class="bloco">
              <span class="rot">Anunciantes</span>
              <div id="anunciantes"></div>
            </div>
          </aside>
          <main class="principal" id="principal">
            <div class="resumo" id="resumo">
              <div class="total" id="total"></div>
              <div class="abas" id="abas" role="tablist"></div>
              <select class="campo" id="ordem" aria-label="Ordenar">${opcoes(ORDENS, filtros.ordem)}</select>
            </div>
            <div class="grade" id="grade"></div>
            <div class="vazio" id="vazio" hidden></div>
            <button class="btn mais" id="mais" hidden title="Rola a Biblioteca para carregar mais anúncios. Não envia nada ao WaveMiner.">Carregar mais 30</button>
          </main>
        </div>
      </div>`;
    grade = raiz.getElementById("grade");
    ligarEventos();
    document.body.appendChild(host);
  }

  function ligarEventos() {
    const $ = (id) => raiz.getElementById(id);

    // O Facebook tem atalhos de teclado na página: digitar aqui não pode acioná-los.
    raiz.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });

    raiz.querySelector(".busca").addEventListener("submit", (e) => {
      e.preventDefault();
      const termo = $("termo").value.trim();
      if (termo) location.href = urlBusca(termo, $("pais").value);
    });
    $("fechar").onclick = () => chrome.storage.local.set({ visaoAtiva: false });
    $("minerar").onclick = minerar;
    $("mais").onclick = carregarMais;
    $("nova").onclick = () => window.open("https://www.facebook.com/ads/library/", "_blank", "noopener");
    $("vazio").onclick = (e) => {
      const b = e.target.closest("button[data-termo]");
      if (b) location.href = urlBusca(b.dataset.termo, $("pais").value);
    };
    $("lado").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-passo]");
      if (!b) return;
      const campo = $(b.dataset.alvo);
      const min = Number(campo.min);
      const novo = (campo.value === "" ? min - 1 : Number(campo.value)) + Number(b.dataset.passo);
      // Máx. vazio é "sem limite": abaixo do mínimo volta a ficar vazio.
      campo.value = b.dataset.alvo === "f-max" && novo < min ? "" : Math.max(min, novo);
      campo.dispatchEvent(new Event("input"));
    });

    $("f-texto").oninput = (e) => { filtros.texto = e.target.value.trim().toLowerCase(); pintar(); };
    $("f-min").oninput = (e) => { filtros.minDias = Number(e.target.value) || 0; guardarFiltros(); pintar(); };
    $("f-max").oninput = (e) => { filtros.maxDias = e.target.value === "" ? null : Number(e.target.value); pintar(); };
    $("f-var").oninput = (e) => { filtros.minVar = Number(e.target.value) || 1; guardarFiltros(); pintar(); };
    $("f-unicos").onchange = (e) => { filtros.unicos = e.target.checked; guardarFiltros(); pintar(); };
    $("ordem").onchange = (e) => { filtros.ordem = e.target.value; guardarFiltros(); pintar(); };

    $("abas").onclick = (e) => {
      const b = e.target.closest("button");
      if (b) { filtros.tipo = b.dataset.tipo; pintar(); }
    };
    $("bloqueios").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const id = b.dataset.id;
      filtros.ocultos = filtros.ocultos.includes(id)
        ? filtros.ocultos.filter((x) => x !== id) : [...filtros.ocultos, id];
      guardarFiltros();
      pintar();
    };
    $("anunciantes").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.ver) verTodos = !verTodos;
      else filtros.anunciante = filtros.anunciante === b.dataset.id ? "" : b.dataset.id;
      pintar();
    };
    grade.addEventListener("click", aoClicarCard);
  }

  function urlBusca(termo, pais) {
    // Aspas pedem a frase exata, igual na Biblioteca.
    const exata = /^".+"$/.test(termo);
    const p = new URLSearchParams({
      active_status: "active", ad_type: "all", country: pais, is_targeted_country: "false",
      media_type: "all", q: termo, search_type: exata ? "keyword_exact_phrase" : "keyword_unordered",
      "sort_data[mode]": "total_impressions", "sort_data[direction]": "desc",
    });
    return "https://www.facebook.com/ads/library/?" + p;
  }

  // ---------------------------------------------------------------- filtros

  function passa(a, ignorar) {
    const d = diasRodando(a.start_date) ?? 0;
    if (d < filtros.minDias) return false;
    if (filtros.maxDias !== null && d > filtros.maxDias) return false;
    if ((a.variacoes || 1) < filtros.minVar) return false;
    if (filtros.ocultos.includes(categoria(a))) return false;
    if (ignorar !== "tipo" && filtros.tipo !== "todos" && tipoDe(a) !== filtros.tipo) return false;
    if (ignorar !== "anunciante" && filtros.anunciante && a.page_id !== filtros.anunciante) return false;
    if (filtros.texto) {
      const alvo = [a.page_name, a.texto, a.titulo, a.descricao, a.link_url].join(" ").toLowerCase();
      if (!alvo.includes(filtros.texto)) return false;
    }
    return true;
  }

  // A Biblioteca repete o mesmo criativo em vários anúncios: quatro cards iguais
  // só empurram os outros para baixo.
  function agrupar(lista) {
    const grupos = new Map();
    for (const a of lista) {
      const chave = filtros.unicos
        ? (a.collation_id || `${a.page_id}|${(a.texto || "").slice(0, 80)}|${a.titulo || ""}`)
        : a.ad_archive_id;
      const g = grupos.get(chave);
      if (g) g.copias++;
      else grupos.set(chave, { a, copias: 0 });
    }
    return [...grupos.values()];
  }

  function ordenar(grupos, porPagina) {
    const criterio = {
      variacoes: (x) => x.a.variacoes || 1,
      dias: (x) => diasRodando(x.a.start_date) ?? -1,
      recentes: (x) => x.a.start_date || 0,
      anunciante: (x) => porPagina.get(x.a.page_id)?.qtd || 0,
    }[filtros.ordem];
    // Empate decidido pelo id: a ordem não pode pular enquanto chegam anúncios.
    return grupos.sort((x, y) => (criterio(y) - criterio(x))
      || x.a.ad_archive_id.localeCompare(y.a.ad_archive_id));
  }

  // ---------------------------------------------------------------- cards

  function criarCard(a) {
    const el = document.createElement("article");
    el.className = "card";
    el.dataset.id = a.ad_archive_id;
    const d = diasRodando(a.start_date);
    const tipo = tipoDe(a);
    const site = seguro(a.link_url);
    const capa = seguro(a.midia_poster || a.midia_url);
    const video = seguro(a.midia_sd || a.midia_url);
    const variacoes = a.variacoes || 1;
    // Sinal de oferta que aguenta escala: tempo no ar e criativo muito replicado.
    const forte = d !== null && d >= 30 && variacoes >= 5;
    if (forte) el.classList.add("quente");
    const selos = [
      forte ? '<span class="selo destaque" title="30+ dias no ar e 5+ variações do criativo">Forte</span>' : "",
      tipo === "carrossel" ? `<span class="selo">Carrossel · ${a.n_cartoes}</span>` : "",
      a.is_active === false ? '<span class="selo parado">Inativo</span>' : "",
      '<span class="selo vg-copias" hidden></span>',
    ].join("");
    const avatar = seguro(a.avatar);
    el.innerHTML = `
      <div class="card-topo">
        ${avatar ? `<img class="avatar" src="${esc(avatar)}" width="32" height="32" alt="" loading="lazy">`
                 : '<span class="avatar" style="width:32px;height:32px"></span>'}
        <button class="card-nome" data-acao="pagina" title="Ver todos os anúncios de ${esc(a.page_name)}"${a.page_id ? "" : " disabled"}>
          <b>${esc(a.page_name || "Anunciante")}</b><small>${esc(hostDe(site) || "sem site")}${a.cta_text ? " · " + esc(a.cta_text) : ""}</small>
        </button>
        <button class="ico${salvos.has(a.ad_archive_id) ? " salvo" : ""}" data-acao="salvar" title="Salvar em ★ Melhores" aria-label="Salvar em Melhores">${ICO.salvar}</button>
      </div>
      <div class="midia">
        ${capa ? `<img src="${esc(capa)}" alt="" loading="lazy">` : '<div class="sem-midia">Sem prévia</div>'}
        <div class="selos">${selos}</div>
        ${tipo === "video" && video ? '<button class="play" data-acao="tocar" aria-label="Tocar vídeo">▶</button>' : ""}
      </div>
      <div class="metricas">
        <div class="metrica${d !== null && d >= 60 ? " alta" : ""}"${d !== null ? ` title="No ar desde ${esc(data(a.start_date))}"` : ""}><b>${d ?? "—"}</b><span>dias no ar</span></div>
        <div class="metrica${variacoes >= 5 ? " alta" : ""}" title="Variações do mesmo criativo"><b>×${variacoes}</b><span>variações</span></div>
        <div class="metrica" title="Anúncios deste anunciante carregados nesta busca"><b class="vg-qtd"></b><span>nesta busca</span></div>
      </div>
      <div class="card-txt"><div class="copy">${esc(a.texto || a.titulo || "Sem texto")}</div></div>
      <div class="card-pe">
        <button class="copiar" data-acao="copiar-texto">Copiar texto</button>
        <button class="ico" data-acao="copiar-tudo" title="Copiar todas as informações" aria-label="Copiar todas as informações">${ICO.copiar}</button>
        <button class="ico" data-acao="baixar" title="Abrir a mídia" aria-label="Abrir a mídia"${seguro(a.midia_url) ? "" : " disabled"}>${ICO.baixar}</button>
        <button class="ico" data-acao="site" title="Abrir o site" aria-label="Abrir o site"${site ? "" : " disabled"}>${ICO.site}</button>
        <button class="ico" data-acao="biblioteca" title="Ver na Biblioteca" aria-label="Ver na Biblioteca">${ICO.biblioteca}</button>
      </div>`;
    return el;
  }

  async function aoClicarCard(ev) {
    const b = ev.target.closest("[data-acao]");
    if (!b) return;
    const card = b.closest(".card");
    const a = window.__minerador.anuncios.get(card.dataset.id);
    if (!a) return;
    const abrir = (u) => window.open(u, "_blank", "noopener");
    const pais = params.get("country") || "BR";

    switch (b.dataset.acao) {
      case "tocar": {
        const v = document.createElement("video");
        v.src = seguro(a.midia_sd || a.midia_url);
        v.poster = seguro(a.midia_poster);
        v.controls = true;
        v.autoplay = true;
        const midia = card.querySelector(".midia");
        midia.querySelector("img, .sem-midia")?.remove();
        midia.prepend(v);
        b.remove();
        break;
      }
      case "copiar-texto": copiar(a.texto, "Texto"); break;
      case "copiar-tudo": copiar(tudo(a), "Informações"); break;
      case "baixar": abrir(seguro(a.midia_url)); break;
      case "biblioteca": abrir(urlBiblioteca(a.ad_archive_id)); break;
      case "site": abrir(seguro(a.link_url)); break;
      case "pagina":
        abrir(`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${encodeURIComponent(pais)}`
          + `&media_type=all&search_type=page&view_all_page_id=${encodeURIComponent(a.page_id)}`);
        break;
      case "salvar":
        b.disabled = true;
        try {
          const r = await mandar({ tipo: "SALVAR_UM", anuncio: a, pais });
          if (!r || !r.ok) throw new Error((r && r.erro) || "Falhou ao salvar");
          salvos.add(a.ad_archive_id);
          chrome.storage.local.set({ visaoSalvos: [...salvos].slice(-2000) });
          b.classList.add("salvo");
          avisar(r.melhores ? "Salvo em ★ Melhores" : "Salvo nos resultados");
        } catch (e) {
          avisar(e.message, true);
        } finally {
          b.disabled = false;
        }
        break;
    }
  }

  // ---------------------------------------------------------------- desenho

  function telaInicial() {
    return `${onda(56)}<h2>Qual nicho vamos garimpar?</h2>
      Busque acima ou comece por um termo. Nada é coletado até você pedir.
      <div class="cats">${CATEGORIAS.map(([nome, termos]) => `<details>
        <summary>${esc(nome)}<span class="num">${termos.length}</span></summary>
        <div class="chips">${termos.map((t) => `<button data-termo="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      </details>`).join("")}</div>`;
  }

  function pintar() {
    const $ = (id) => raiz.getElementById(id);
    const todos = [...window.__minerador.anuncios.values()];
    const vazioTotal = !todos.length;

    // sem busca e sem anúncio não há o que filtrar: só o convite para buscar
    $("lado").hidden = vazioTotal;
    $("resumo").hidden = vazioTotal;
    $("minerar").disabled = !termoUrl && !minerando;
    raiz.querySelector(".corpo").style.gridTemplateColumns = vazioTotal ? "minmax(0, 1fr)" : "";

    const visiveis = todos.filter((a) => passa(a));
    const porPagina = new Map();
    for (const a of todos.filter((x) => passa(x, "anunciante"))) {
      const g = porPagina.get(a.page_id) || { id: a.page_id, nome: a.page_name, avatar: a.avatar, qtd: 0 };
      g.qtd++;
      porPagina.set(a.page_id, g);
    }
    const contagem = new Map();
    for (const a of todos) contagem.set(a.page_id, (contagem.get(a.page_id) || 0) + 1);

    const grupos = ordenar(agrupar(visiveis), porPagina);

    // resumo
    const total = window.__minerador.total;
    const paginas = new Set(todos.map((a) => a.page_id)).size;
    const repetidos = todos.length - grupos.length;
    $("total").innerHTML = total != null
      ? `<b>${mil(total)}</b> resultados<small>${mil(todos.length)} carregados · ${mil(paginas)} anunciantes · ${mil(grupos.length)} na tela${repetidos > 0 ? ` · ${mil(repetidos)} fora da tela` : ""}</small>`
      : `<b>${mil(grupos.length)}</b> na tela<small>${mil(todos.length)} carregados · ${mil(paginas)} anunciantes</small>`;

    // abas
    const porTipo = { todos: 0, video: 0, imagem: 0, carrossel: 0 };
    for (const a of todos) if (passa(a, "tipo")) { porTipo.todos++; porTipo[tipoDe(a)]++; }
    $("abas").innerHTML = ABAS.map(([id, rot]) =>
      `<button role="tab" data-tipo="${id}" aria-selected="${filtros.tipo === id}">${rot} <span class="num">${porTipo[id]}</span></button>`).join("");

    // bloqueios
    const porCategoria = {};
    for (const a of todos) { const c = categoria(a); porCategoria[c] = (porCategoria[c] || 0) + 1; }
    $("bloqueios").innerHTML = BLOQUEIOS.map(([id, rot, icone]) => {
      const oculto = filtros.ocultos.includes(id);
      return `<button class="bloqueio" data-id="${id}" aria-pressed="${oculto}">${svg(icone)}${rot}<small>${oculto ? "oculto" : "visível"} · ${porCategoria[id] || 0}</small></button>`;
    }).join("");

    // anunciantes
    const ranking = [...porPagina.values()].sort((x, y) => y.qtd - x.qtd);
    const mostrar = verTodos ? ranking : ranking.slice(0, 15);
    $("anunciantes").innerHTML = mostrar.map((g) => {
      const av = seguro(g.avatar);
      return `<button class="anunciante" data-id="${esc(g.id)}" aria-pressed="${filtros.anunciante === g.id}">
        ${av ? `<img class="avatar" src="${esc(av)}" width="20" height="20" alt="" loading="lazy">` : '<i class="avatar" style="width:20px;height:20px"></i>'}
        <span title="${esc(g.nome)}">${esc(g.nome || g.id)}</span><small>${g.qtd}</small></button>`;
    }).join("") + (ranking.length > 15
      ? `<button class="link" data-ver="1">${verTodos ? "Ver menos" : `Ver mais ${ranking.length - 15}`}</button>` : "");

    // grade: reaproveita os cards para não recarregar imagem nem parar vídeo
    const els = grupos.map(({ a, copias }) => {
      let el = cartoes.get(a.ad_archive_id);
      if (!el) { el = criarCard(a); cartoes.set(a.ad_archive_id, el); }
      el.querySelector(".vg-qtd").textContent = contagem.get(a.page_id) || 1;
      const selo = el.querySelector(".vg-copias");
      selo.hidden = !copias;
      selo.textContent = `+${copias} ${copias === 1 ? "cópia" : "cópias"}`;
      return el;
    });
    const atuais = grade.children;
    if (els.length !== atuais.length || els.some((el, i) => el !== atuais[i])) grade.replaceChildren(...els);

    // estado vazio
    const vazio = $("vazio");
    vazio.hidden = !!els.length;
    const inicio = vazioTotal && !emBusca;
    const qual = els.length ? "" : inicio ? "inicio" : vazioTotal ? "aguardando" : "filtros";
    // Só troca quando muda de situação: repintar fecharia a categoria aberta.
    if (qual && vazio.dataset.qual !== qual) {
      vazio.dataset.qual = qual;
      vazio.className = inicio ? "hero" : "vazio";
      vazio.innerHTML = inicio ? telaInicial()
        : vazioTotal
          ? "<h2>Aguardando anúncios…</h2>A Biblioteca ainda não entregou resultados para esta busca."
          : "<h2>Nada com esses filtros</h2>Afrouxe o tempo no ar, as variações ou os destinos ocultos.";
    }
    $("guias").hidden = !emBusca;
    $("guia-n").textContent = total != null ? mil(total) : "";
    $("mais").hidden = !emBusca || vazioTotal;
    $("mais").disabled = carregando || minerando;
    $("mais").textContent = carregando ? "Carregando…" : "Carregar mais 30";
    pintarMinerar();
  }

  let pendente;
  function agendar() {
    clearTimeout(pendente);
    pendente = setTimeout(() => { if (host && !host.hidden) pintar(); }, 300);
  }

  // ---------------------------------------------------------------- ações

  async function carregarMais() {
    if (carregando) return;
    carregando = true;
    pintar();
    try {
      await rolarAteJuntar({
        alvo: window.__minerador.anuncios.size + 30, timeoutMs: 60000, paradasMax: 6,
      });
    } finally {
      carregando = false;
      pintar();
    }
  }

  // Mesmos padrões do popup, para o botão daqui e o de lá fazerem a mesma pesquisa.
  async function configuracao() {
    const s = await chrome.storage.local.get(["token", "idioma", "minAds", "minDias", "maxAnuncios",
      "timeout", "paradas", "profunda", "maxAnunciantes", "abrirDashboard"]);
    return {
      token: s.token,
      cfg: {
        termo: termoUrl, pais: params.get("country") || "BR", idioma: s.idioma || "",
        minAnuncios: s.minAds ?? 2, minDias: s.minDias ?? 3,
        maxAnuncios: (s.maxAnuncios == null || s.maxAnuncios === 60) ? 150 : s.maxAnuncios,
        timeoutMs: (s.timeout ?? 300) * 1000, paradasMax: s.paradas ?? 12,
        varreduraProfunda: !!s.profunda, maxAnunciantes: s.maxAnunciantes ?? 8,
        usarAbaAtual: false, abrirDashboard: !!s.abrirDashboard,
      },
    };
  }

  async function minerar() {
    try {
      if (minerando) return await mandar({ tipo: "PARAR_FILA" });
      const { token, cfg } = await configuracao();
      if (!token) return avisar("Entre na extensão primeiro (ícone do WaveMiner).", true);
      await mandar({ tipo: "PESQUISAR", cfg });
    } catch (e) {
      avisar(e.message, true);
    }
  }

  function pintarMinerar() {
    const b = raiz.getElementById("minerar");
    b.textContent = minerando ? "■ Parar" : "Minerar esta busca";
    b.classList.toggle("parar", minerando);
  }

  function mostrarStatus(st) {
    const el = raiz.getElementById("estado");
    const recente = st && st.texto && Date.now() - st.em < 10 * 60 * 1000;
    el.hidden = !recente;
    if (!recente) return;
    el.textContent = st.texto;
    el.classList.toggle("erro", !!st.erro);
  }

  function lerExecucao(e) {
    const valida = e && e.em && Date.now() - e.em < 10 * 60 * 1000;
    minerando = !!(valida && (e.rodando || e.filaEmCurso));
  }

  // ---------------------------------------------------------------- início

  function mostrarGrade(ativa) {
    host.hidden = !ativa;
    document.documentElement.classList.toggle("wm-grade", ativa);
  }

  async function iniciar() {
    const s = await chrome.storage.local.get(["visaoAtiva", "visaoFiltros", "visaoSalvos", "status", "execucao"]);
    for (const k of GUARDADOS) if (s.visaoFiltros && s.visaoFiltros[k] !== undefined) filtros[k] = s.visaoFiltros[k];
    salvos = new Set(s.visaoSalvos || []);
    lerExecucao(s.execucao);

    const quandoPronto = () => {
      montar();
      mostrarGrade(s.visaoAtiva !== false);
      mostrarStatus(s.status);
      pintar();
      window.__minerador.aoMudar = agendar;
    };
    // Roda em document_start: mexer no <html> antes do <body> trava a página (ver painel.js).
    if (document.body) quandoPronto();
    else document.addEventListener("DOMContentLoaded", quandoPronto, { once: true });

    chrome.storage.onChanged.addListener((mud, area) => {
      if (area !== "local" || !host) return;
      if (mud.visaoAtiva) {
        mostrarGrade(mud.visaoAtiva.newValue !== false);
        if (!host.hidden) pintar();
      }
      if (mud.status) mostrarStatus(mud.status.newValue);
      if (mud.execucao) {
        lerExecucao(mud.execucao.newValue);
        if (!host.hidden) pintar();
      }
    });
  }

  iniciar();
})();
