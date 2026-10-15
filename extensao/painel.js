// Aba de contagem aberta pela varredura profunda: nada de interface nela.
// Nome prefixado: ver a nota igual em overlay.js sobre o escopo compartilhado.
const mnpEmContagem = location.hash.includes("mn-contagem");

// Painel flutuante do minerador dentro da própria Biblioteca de Anúncios.
//
// O conteúdo é o popup.html de sempre, dentro de um <iframe>: assim a interface
// tem uma fonte de verdade só. Este arquivo cuida da moldura — arrastar,
// redimensionar, recolher, opacidade, encostar na borda — e guarda tudo em
// chrome.storage.local para o painel reabrir do jeito que você deixou.

const PADRAO = { x: null, y: 84, w: 300, h: 560, recolhido: false, opacidade: 1, fechado: false };
const MIN_L = 250;
const MIN_A = 160;

let estado = { ...PADRAO };
let painel, cabeca, fab;

const limites = () => ({ maxX: innerWidth - 60, maxY: innerHeight - 40 });

async function ler() {
  const s = await chrome.storage.local.get(["painelFlutuante", "painelGeo"]);
  return { ligado: s.painelFlutuante !== false, geo: { ...PADRAO, ...(s.painelGeo || {}) } };
}

let gravando;
function gravar() {
  clearTimeout(gravando);
  gravando = setTimeout(() => chrome.storage.local.set({ painelGeo: estado }), 250);
}

function aplicar() {
  const x = estado.x === null ? Math.max(12, innerWidth - estado.w - 24) : estado.x;
  painel.style.left = Math.min(Math.max(0, x), limites().maxX) + "px";
  painel.style.top = Math.min(Math.max(0, estado.y), limites().maxY) + "px";
  painel.style.width = Math.max(MIN_L, estado.w) + "px";
  painel.style.height = estado.recolhido ? "auto" : Math.max(MIN_A, estado.h) + "px";
  painel.style.opacity = estado.opacidade;
  painel.classList.toggle("mnp-recolhido", estado.recolhido);
  painel.hidden = estado.fechado;
  fab.hidden = !estado.fechado;
}

// ------------------------------------------------------------------ arrastar / redimensionar

function mexer(ev, aoMover) {
  ev.preventDefault();
  painel.classList.add("mnp-mexendo");
  const inicio = { px: ev.clientX, py: ev.clientY, ...estado };
  const mover = (e) => { aoMover(e.clientX - inicio.px, e.clientY - inicio.py, inicio); aplicar(); };
  const soltar = () => {
    painel.classList.remove("mnp-mexendo", "mnp-arrastando");
    removeEventListener("pointermove", mover);
    removeEventListener("pointerup", soltar);
    gravar();
  };
  addEventListener("pointermove", mover);
  addEventListener("pointerup", soltar);
}

function ligarArrastar() {
  cabeca.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("button")) return;
    cabeca.classList.add("mnp-arrastando");
    const esq = painel.getBoundingClientRect().left;
    mexer(ev, (dx, dy, ini) => {
      estado.x = Math.min(Math.max(0, esq + dx), limites().maxX);
      estado.y = Math.min(Math.max(0, ini.y + dy), limites().maxY);
    });
  });
  cabeca.addEventListener("dblclick", (ev) => {
    if (!ev.target.closest("button")) recolher();
  });
}

function ligarRedimensionar(pega) {
  pega.addEventListener("pointerdown", (ev) => mexer(ev, (dx, dy, ini) => {
    estado.w = Math.max(MIN_L, ini.w + dx);
    estado.h = Math.max(MIN_A, ini.h + dy);
  }));
}

// ------------------------------------------------------------------ ações do cabeçalho

function recolher() {
  estado.recolhido = !estado.recolhido;
  aplicar();
  gravar();
}

function alternarOpacidade() {
  const passos = [1, 0.85, 0.6];
  estado.opacidade = passos[(passos.indexOf(estado.opacidade) + 1) % passos.length] || 1;
  aplicar();
  gravar();
}

// Encosta à direita, depois à esquerda: útil para não cobrir o anúncio que você
// está lendo.
function encostar() {
  const naDireita = estado.x !== null && estado.x > innerWidth / 2;
  estado.x = naDireita ? 12 : Math.max(12, innerWidth - estado.w - 24);
  estado.y = 84;
  aplicar();
  gravar();
}

function fechar(sim) {
  estado.fechado = sim;
  aplicar();
  gravar();
}

// ------------------------------------------------------------------ montagem

function montar(geo) {
  estado = geo;

  painel = document.createElement("div");
  painel.className = "mnp-painel";
  painel.innerHTML = `
    <div class="mnp-cabeca">
      <span class="mnp-titulo">⛏️ minerador<b>.ofertas</b></span>
      <button data-mnp="encostar" title="Encostar na outra borda">⇄</button>
      <button data-mnp="opacidade" title="Transparência">◐</button>
      <button data-mnp="recolher" title="Recolher (ou dê dois cliques no topo)">–</button>
      <button data-mnp="fechar" title="Fechar">✕</button>
    </div>
    <div class="mnp-corpo"><iframe title="Minerador de Ofertas" allow="clipboard-write"></iframe></div>
    <div class="mnp-pega" title="Arraste para redimensionar"></div>`;

  // src só depois de estar no DOM: evita o iframe carregar duas vezes
  document.body.appendChild(painel);
  painel.querySelector("iframe").src = chrome.runtime.getURL("popup.html?embutido=1");

  fab = document.createElement("button");
  fab.className = "mnp-fab";
  fab.textContent = "⛏️ Minerador";
  fab.onclick = () => fechar(false);
  document.body.appendChild(fab);

  cabeca = painel.querySelector(".mnp-cabeca");
  cabeca.addEventListener("click", (ev) => {
    const acao = ev.target.closest("button")?.dataset.mnp;
    if (acao === "recolher") recolher();
    if (acao === "opacidade") alternarOpacidade();
    if (acao === "encostar") encostar();
    if (acao === "fechar") fechar(true);
  });

  // O popup embutido avisa que subiu. Sem aviso, o iframe foi barrado (CSP da
  // página) e o painel mostra um caminho alternativo em vez de um quadro vazio.
  let vivo = false;
  addEventListener("message", (ev) => {
    if (ev.data && ev.data.mn === "popup-pronto") vivo = true;
  });
  setTimeout(() => {
    if (vivo) return;
    painel.querySelector(".mnp-corpo").innerHTML =
      '<div class="mnp-aviso">O Facebook bloqueou a janela embutida aqui.'
      + ' Use o ícone da extensão na barra do Chrome — o resto (barra de cópia'
      + ' nos anúncios e coleta automática) continua funcionando.'
      + '<button data-mnp="painel-web">Abrir o painel web</button></div>';
    painel.querySelector('[data-mnp="painel-web"]').onclick = () => {
      try {
        chrome.runtime.sendMessage({ tipo: "ABRIR_PAINEL" });
      } catch (e) {
        painel.querySelector(".mnp-aviso").textContent =
          "A extensão foi recarregada — atualize esta página (F5).";
      }
    };
  }, 4000);

  ligarArrastar();
  ligarRedimensionar(painel.querySelector(".mnp-pega"));
  addEventListener("resize", aplicar);
  aplicar();
}

// O content script roda em document_start: montar um <iframe> dentro de <html>
// antes de o parser criar o <body> trava o carregamento da página. Espera.
function quandoTiverCorpo(fn) {
  if (document.body) return fn();
  document.addEventListener("DOMContentLoaded", fn, { once: true });
}

// Só no frame de cima: dentro do próprio iframe do painel isto se montaria de
// novo, e cada cópia criaria mais uma — recursão infinita.
if (window.top === window && !mnpEmContagem) {
  ler().then(({ ligado, geo }) => {
    if (ligado) quandoTiverCorpo(() => montar(geo));
  });
} else if (mnpEmContagem && window.top === window) {
  // Se você cair nesta aba, ela precisa dizer o que é: sem isso parece que a
  // extensão saiu pesquisando nomes aleatórios sozinha.
  quandoTiverCorpo(() => {
    const aviso = document.createElement("div");
    aviso.className = "mnp-fundo";
    aviso.textContent = "⛏️ Aba de contagem do Minerador — fecha sozinha ao terminar";
    document.body.appendChild(aviso);
  });
}
