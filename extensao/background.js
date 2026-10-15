// Service worker: orquestra a pesquisa (abrir aba -> coletar -> varrer
// anunciantes -> enviar pro backend) e guarda o estado pro popup ler.

const PADRAO_API = "https://minerador-ofertas-umber.vercel.app";

// ------------------------------------------------------------------ estado

async function cfg() {
  const s = await chrome.storage.local.get(["apiUrl", "token", "auto", "abrirSozinho",
                                          "painelFlutuante", "autoRolar"]);
  return {
    apiUrl: (s.apiUrl || PADRAO_API).replace(/\/$/, ""),
    token: s.token || "",
    auto: !!s.auto,
    abrirSozinho: s.abrirSozinho !== false,  // ligado por padrão
    painelFlutuante: s.painelFlutuante !== false,
    autoRolar: !!s.autoRolar,   // automática não rola sem você pedir
  };
}

// O service worker do MV3 é encerrado quando fica ocioso — e uma pesquisa de
// 5 minutos passa por vários desses momentos. Estado em memória some junto:
// era por isso que o PARAR não fazia nada e o popup recebia "message channel
// closed". Agora o estado vive no storage.
const EXEC = "execucao";

async function lerExecucao() {
  const e = (await chrome.storage.local.get(EXEC))[EXEC] || {};
  // marca velha demais é de um worker que morreu no meio: não pode travar a UI
  if (e.em && Date.now() - e.em > 10 * 60 * 1000) return {};
  return e;
}

async function marcarExecucao(dados) {
  const atual = (await chrome.storage.local.get(EXEC))[EXEC] || {};
  await chrome.storage.local.set({ [EXEC]: { ...atual, ...dados, em: Date.now() } });
}

// Chamada periódica de API da extensão segura o worker vivo durante o trabalho;
// timer sozinho não conta como atividade para o Chrome.
let batida;
function manterVivo(ligar) {
  clearInterval(batida);
  if (ligar) {
    batida = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
      marcarExecucao({});          // renova o carimbo de tempo
    }, 20000);
  }
}

async function pediramParar() {
  return !!(await lerExecucao()).pedidoParar;
}

// Parar não é erro: quem apertou PARAR não pode ver "Erro: …" em vermelho.
const INTERROMPIDA = "Coleta interrompida.";
const foiInterrompida = (e) => e && e.message === INTERROMPIDA;

async function status(texto, extra = {}) {
  const estado = { texto, em: Date.now(), ...extra };
  await chrome.storage.local.set({ status: estado });
  chrome.runtime.sendMessage({ tipo: "PROGRESSO", estado }).catch(() => {});
}

// ------------------------------------------------------------------ utilitários de aba

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function montarUrl({ termo, pageId, pais = "BR", ativos = true, idioma = "" }) {
  const p = [
    `active_status=${ativos ? "active" : "all"}`,
    "ad_type=all",
    `country=${pais}`,
    "media_type=all",
  ];
  // Filtro de idioma da Biblioteca: com país hispano + idioma "es" a busca
  // deixa de trazer anúncio em inglês/português rodando no mesmo mercado.
  if (idioma) p.push(`content_languages[0]=${encodeURIComponent(idioma)}`);
  if (pageId) p.push(`view_all_page_id=${encodeURIComponent(pageId)}`, "search_type=page");
  else p.push(`q=${encodeURIComponent(termo || "")}`, "search_type=keyword_unordered");
  return "https://www.facebook.com/ads/library/?" + p.join("&");
}

// Mesma busca? Então não recarrega a aba: recarregar joga fora o que a página
// já tinha carregado e faz a Biblioteca começar do zero.
function mesmaBusca(a, b) {
  try {
    const [x, y] = [new URL(a).searchParams, new URL(b).searchParams];
    return ["q", "country", "active_status", "view_all_page_id"]
      .every((k) => (x.get(k) || "") === (y.get(k) || ""));
  } catch (e) {
    return false;
  }
}

// Depois de trocar a URL, a página ANTIGA continua respondendo ao PING até a
// navegação começar de fato. Sem esperar a aba chegar na URL nova e terminar
// de carregar, a coleta ia para a página que estava morrendo, falhava na hora
// e a fila pulava para o próximo termo — a mineração automática queimava a
// lista inteira em segundos sem coletar nada.
async function esperarNavegacao(tabId, url, limiteMs = 30000) {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    await esperar(500);
    let aba;
    try { aba = await chrome.tabs.get(tabId); } catch (e) { throw new Error("A aba da Biblioteca foi fechada."); }
    const destino = aba.pendingUrl || aba.url || "";
    if (aba.status === "complete" && mesmaBusca(destino, url)) return;
  }
  throw new Error("A Biblioteca de Anúncios demorou demais para abrir a busca.");
}

async function abrirAba(url, { navegar = true } = {}) {
  const [aba] = await chrome.tabs.query({ url: "*://*.facebook.com/ads/library*" });
  if (aba) {
    if (!navegar || mesmaBusca(aba.url, url)) return aba.id;
    await chrome.tabs.update(aba.id, { url, active: true });
    await esperarNavegacao(aba.id, url);
    return aba.id;
  }
  // Só chega aqui sem nenhuma aba da Biblioteca aberta: a coleta precisa de uma
  // e o aviso explica de onde ela veio.
  await status("Nenhuma aba da Biblioteca aberta — abrindo uma.");
  const nova = await chrome.tabs.create({ url, active: true });
  await esperarNavegacao(nova.id, url);
  return nova.id;
}

// A varredura profunda visita a página de cada anunciante. Isso acontece numa
// aba de segundo plano, para não arrastar a aba que você está lendo.
// O #mn-contagem marca a aba: os scripts de página leem isso e não montam
// painel nem barra de cópia lá — assim ninguém confunde a aba de trabalho com
// a sua.
const MARCA_FUNDO = "#mn-contagem";

async function abaDeFundo(url) {
  const aba = await chrome.tabs.create({ url: url + MARCA_FUNDO, active: false });
  return aba.id;
}

async function esperarPronto(tabId, tentativas = 40) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { tipo: "PING" });
      if (r && r.pronto) return true;
    } catch (e) {
      /* content script ainda não subiu */
    }
    await esperar(700);
  }
  throw new Error("A aba da Biblioteca de Anúncios não respondeu. Faça login no Facebook e tente de novo.");
}

async function coletarNaAba(tabId, alvo, timeoutMs, paradasMax, rolar = true) {
  const r = await chrome.tabs.sendMessage(tabId,
    { tipo: "COLETAR", alvo, timeoutMs, paradasMax, rolar });
  return (r && r.anuncios) || [];
}

// ------------------------------------------------------------------ backend

async function api(caminho, corpo, metodo = "POST") {
  const { apiUrl, token } = await cfg();
  const resp = await fetch(apiUrl + caminho, {
    method: metodo,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (resp.status === 401) {
    // Token de um banco que não existe mais (troca de provedor) ou expirado:
    // apagar aqui faz o popup abrir direto na tela de login em vez de repetir
    // o erro a cada clique.
    await chrome.storage.local.remove(["token", "usuario", "usos"]);
    throw new Error("Sessão encerrada — entre de novo na extensão (botão ENTRAR).");
  }
  if (resp.status === 503) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.erro || "Servidor indisponível no momento.");
  }
  if (!resp.ok) throw new Error(`Backend respondeu ${resp.status}`);
  return resp.json();
}

async function moerFila(pendentes, maxRodadas = 40) {
  for (let i = 0; i < maxRodadas && pendentes > 0; i++) {
    if (await pediramParar()) break;
    await status(`Resolvendo destinos… faltam ${pendentes}`);
    try {
      const j = await api("/api/enriquecer?limite=8", {});
      if (!j.processados) break;
      pendentes = j.pendentes;
    } catch (e) {
      console.warn("enriquecimento falhou", e);
      break;
    }
  }
}

// A URL de mídia que a Biblioteca entrega é assinada e vence em horas: copiar
// para o Blob tem que acontecer agora, logo depois de coletar, não quando o
// painel for aberto amanhã.
async function moerMidias(pendentes, maxRodadas = 60) {
  for (let i = 0; i < maxRodadas && pendentes > 0; i++) {
    if (await pediramParar()) break;
    await status(`Copiando vídeos e capas… faltam ${pendentes}`);
    try {
      const j = await api("/api/midias?limite=4", {});
      if (!j.processados) break;
      pendentes = j.pendentes;
    } catch (e) {
      console.warn("cópia de mídia falhou", e);
      break;
    }
  }
}

// ------------------------------------------------------------------ só low ticket

// O minerador guarda só oferta de entrada. Preço e checkout o servidor descobre
// visitando o site; aqui sai antes o que nunca vai ter: anúncio sem link e link
// para app, perfil ou conversa. Mesma lista do backend (lowticket.NAO_VENDE).
const NAO_VENDE = new Set([
  "facebook.com", "instagram.com", "linktr.ee", "google.com", "api.whatsapp.com", "wa.me",
  "apps.apple.com", "play.google.com", "fb.me", "beacons.ai", "bio.link", "linkr.bio",
  "itunes.apple.com", "m.me", "web.whatsapp.com",
]);

function podeSerLow(a) {
  try {
    const u = new URL(a.link_url || "");
    if (!/^https?:$/.test(u.protocol)) return false;
    return !NAO_VENDE.has(u.hostname.replace(/^www\./, "").toLowerCase());
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------------ pesquisa

const dias = (epoch) => (epoch ? Math.max(0, Math.floor((Date.now() / 1000 - epoch) / 86400)) : 0);

let rodando = false;

async function pesquisar(p) {
  if (rodando) throw new Error("Já existe uma pesquisa rodando.");
  rodando = true;
  // Dentro da fila o pedido de parar vale para todos os termos: zerar aqui
  // fazia o próximo termo começar mesmo depois do PARAR.
  await marcarExecucao(p.emFila ? { rodando: true } : { rodando: true, pedidoParar: false });
  manterVivo(true);
  try {
    // "Usar a busca aberta": nada de navegar — coleta o que já está na tela e
    // tira o termo/país da própria URL, para a pesquisa ser salva com o rótulo
    // certo.
    const alvo = montarUrl({ termo: p.termo, pais: p.pais, idioma: p.idioma, ativos: true });

    // Termo digitado sempre ganha: "usar a busca aberta" vale para quando você
    // não pediu termo nenhum. Antes a opção sequestrava a pesquisa e coletava
    // outra coisa sem avisar.
    const lerDaAba = p.usarAbaAtual && !String(p.termo || "").trim();
    await status(lerDaAba ? "Lendo a busca que já está aberta…"
                          : `Abrindo a biblioteca: "${p.termo}"`);
    const tabId = await abrirAba(alvo, { navegar: !lerDaAba });

    if (lerDaAba) {
      const aba = await chrome.tabs.get(tabId);
      const busca = new URL(aba.url).searchParams;
      p = { ...p, termo: busca.get("q") || p.termo, pais: busca.get("country") || p.pais };
    }
    await esperarPronto(tabId);

    await status("Coletando anúncios…");
    if (await pediramParar()) {
      await status(INTERROMPIDA + " Nada foi coletado.", { concluido: true });
      throw new Error(INTERROMPIDA);
    }
    const brutos = await coletarNaAba(tabId, p.maxAnuncios, p.timeoutMs, p.paradasMax);
    // Parou no meio da rolagem: o que já veio é salvo, o resto do trabalho não.
    const parou = await pediramParar();
    if (parou && !brutos.length) {
      await status(INTERROMPIDA + " Nada foi coletado.", { concluido: true });
      throw new Error(INTERROMPIDA);
    }

    // Filtro de tempo mínimo já aqui, para não gastar varredura com anúncio novo.
    const passaram = brutos.filter((a) => dias(a.start_date) >= p.minDias);
    await status(`${brutos.length} anúncios · ${passaram.length} com ${p.minDias}+ dias`);

    // Agrupa por anunciante e ranqueia pelos que mais aparecem.
    const porPagina = new Map();
    for (const a of passaram) {
      if (!a.page_id) continue;
      const g = porPagina.get(a.page_id) || { page_id: a.page_id, page_name: a.page_name, qtd: 0 };
      g.qtd++;
      porPagina.set(a.page_id, g);
    }
    const candidatos = [...porPagina.values()].sort((x, y) => y.qtd - x.qtd);

    let todos = passaram;
    const anunciantes = [];

    if (p.varreduraProfunda && candidatos.length) {
      const limite = Math.min(candidatos.length, p.maxAnunciantes);
      let abaFundo = null;
      try {
        for (let i = 0; i < limite; i++) {
          const c = candidatos[i];
          await status(`Contando anúncios de ${c.page_name || c.page_id} (${i + 1}/${limite})`);
          if (await pediramParar()) break;
          const url = montarUrl({ pageId: c.page_id, pais: p.pais });
          try {
            // primeira volta abre a aba de fundo; as seguintes só trocam a URL
            if (abaFundo === null) abaFundo = await abaDeFundo(url);
            else await chrome.tabs.update(abaFundo, { url: url + MARCA_FUNDO });
            await esperar(1500);
            await esperarPronto(abaFundo);
            await chrome.tabs.sendMessage(abaFundo, { tipo: "ZERAR" });
            const doAnunciante = await coletarNaAba(abaFundo, 400,
              Math.min(p.timeoutMs || 300000, 120000));
            const ativos = doAnunciante.filter((a) => a.is_active);
            anunciantes.push({
              page_id: c.page_id,
              page_name: c.page_name,
              total_ativos: ativos.reduce((s, a) => s + (a.variacoes || 1), 0),
            });
            todos = todos.concat(doAnunciante);
          } catch (e) {
            console.warn("varredura falhou em", c.page_id, e);
          }
        }
      } finally {
        if (abaFundo !== null) await chrome.tabs.remove(abaFundo).catch(() => {});
      }
    }

    // Dedup final por ad_archive_id.
    const mapa = new Map();
    for (const a of todos) mapa.set(a.ad_archive_id, a);
    const coletados = mapa.size;
    const lista = [...mapa.values()].filter(podeSerLow);

    await status(`Enviando ${lista.length} anúncios…`);
    const r = await api("/api/anuncios", {
      anuncios: lista, termo: p.termo, pais: p.pais,
      min_anuncios: p.minAnuncios, min_dias: p.minDias,
    });
    if (anunciantes.length) await api("/api/anunciantes", { anunciantes });

    // O backend roda em serverless: não há worker em background resolvendo os
    // destinos. Quem acabou de ingerir puxa a fila em lotes.
    if (parou) {
      await status(`Coleta interrompida: ${r.novos} novos de ${r.recebidos} salvos.`,
        { concluido: true, usos: r.usos_restantes });
      throw new Error(INTERROMPIDA);
    }
    await moerFila(r.pendentes);
    // Na fila, copiar mídia à exaustão entre um termo e outro parece travamento:
    // lote curto agora, o resto no fim da fila.
    await moerMidias(r.midias_pendentes, p.emFila ? 12 : 60);

    await status(`Pronto: ${r.novos} novos de ${r.recebidos} com cara de low ticket`
      + ` (${coletados - lista.length} sem link de venda descartados). ${r.usos_restantes} usos restantes.`, {
      concluido: true, usos: r.usos_restantes,
    });

    // Abrir o painel numa aba nova a cada pesquisa atrapalha quem está lendo a
    // Biblioteca: agora é opção, desligada por padrão.
    if (p.abrirDashboard) {
      const { apiUrl } = await cfg();
      chrome.tabs.create({ url: apiUrl + "/", active: true });
    }
    return r;
  } finally {
    rodando = false;
    await marcarExecucao({ rodando: false });
    if (!filaEmCurso) manterVivo(false);
  }
}

// ------------------------------------------------------------------ fila de termos

let pararFila = false;
let filaEmCurso = false;

// Vários nichos em sequência: terminou um, começa o próximo na hora. Cada termo
// é uma pesquisa completa (coleta + varredura + envio + mídia), então a fila é
// serial de propósito — duas coletas ao mesmo tempo brigariam pela mesma aba.
async function pesquisarFila(conf) {
  const termos = (conf.termos || []).map((t) => String(t).trim()).filter(Boolean);
  if (!termos.length) throw new Error("Nenhum termo na fila.");

  pararFila = false;
  filaEmCurso = true;
  await marcarExecucao({ filaEmCurso: true, pedidoParar: false });
  manterVivo(true);
  const feitos = [];
  for (let i = 0; i < termos.length; i++) {
    if (pararFila || await pediramParar()) {
      await status(`Fila interrompida em ${i} de ${termos.length}.`, { concluido: true });
      break;
    }
    await status(`Fila ${i + 1}/${termos.length}: "${termos[i]}"`);
    try {
      const r = await pesquisar({ ...conf, termo: termos[i], abrirDashboard: false,
                                  emFila: true,
                                  // navegar é obrigatório entre termos: cada um é outra busca
                                  usarAbaAtual: false });
      feitos.push({ termo: termos[i], novos: r.novos, recebidos: r.recebidos });
    } catch (e) {
      if (foiInterrompida(e)) break;
      feitos.push({ termo: termos[i], erro: e.message });
      await status(`"${termos[i]}" falhou: ${e.message}`, { erro: true });
    }
  }

  filaEmCurso = false;
  await marcarExecucao({ filaEmCurso: false });
  if (pararFila || await pediramParar()) {
    manterVivo(false);
    await status(`Fila interrompida: ${feitos.length} de ${termos.length} termo(s) feitos.`,
      { concluido: true });
    return { feitos, interrompida: true };
  }

  // sobrou mídia dos termos anteriores: termina agora, sem atrapalhar a coleta
  try {
    const pend = (await api("/api/anuncios", { anuncios: [] })).midias_pendentes;
    if (pend) await moerMidias(pend);
  } catch (e) {
    console.warn("cópia final de mídia falhou", e);
  }
  manterVivo(false);
  const novos = feitos.reduce((s, f) => s + (f.novos || 0), 0);
  const comErro = feitos.filter((f) => f.erro).length;
  await status(`Fila terminada: ${feitos.length} termo(s), ${novos} anúncios novos`
    + (comErro ? `, ${comErro} com erro` : "") + ".", { concluido: true });

  if (conf.abrirDashboard) {
    const { apiUrl } = await cfg();
    chrome.tabs.create({ url: apiUrl + "/", active: true });
  }
  return { feitos, novos };
}

// ------------------------------------------------------------------ pesquisa automática

// Com o toggle ligado, qualquer visita manual à Biblioteca de Anúncios é
// coletada em segundo plano — sem scroll agressivo, só o que carregar.
chrome.tabs.onUpdated.addListener(async (tabId, info, aba) => {
  if (info.status !== "complete") return;
  if (!aba.url || !aba.url.includes("/ads/library")) return;
  const { auto, token, abrirSozinho, painelFlutuante, autoRolar } = await cfg();

  // Abre o popup junto com a Biblioteca. Só funciona com a janela em foco e a
  // partir do Chrome 127 — quando não rola, a barra de cópia do overlay.js já
  // aparece no anúncio de qualquer jeito.
  // Com o painel flutuante na página, abrir também o popup da barra seria a
  // mesma interface duas vezes.
  if (abrirSozinho && !painelFlutuante && aba.active && chrome.action.openPopup) {
    try {
      await chrome.action.openPopup({ windowId: aba.windowId });
    } catch (e) {
      console.debug("openPopup recusado", e.message);
    }
  }

  // O envio em si é contínuo (mensagem CAPTURADOS do content.js). Aqui só
  // entra o "deixar rolar": a rolagem carrega mais anúncios e eles chegam pelo
  // mesmo caminho.
  if (!auto || !token || !autoRolar || rodando || filaEmCurso) return;
  if ((aba.url || "").includes("mn-contagem")) return;
  try {
    await esperarPronto(tabId, 10);
    await coletarNaAba(tabId, 60, 40000, 8, true);
  } catch (e) {
    console.warn("rolagem automática falhou", e);
  }
});

// Pesquisa automática (passiva): o que a página carregou e ainda não foi mandado.
let enviandoCapturados = Promise.resolve();
async function receberCapturados(msg) {
  const { auto, token } = await cfg();
  // Pesquisa ativa já envia o que coleta: marca como enviado para não duplicar.
  if (rodando || filaEmCurso) return { marcar: true, ignorado: "pesquisa ativa" };
  if (!auto || !token) return { marcar: false, ignorado: "pesquisa automática desligada" };
  const lista = (msg.anuncios || []).filter(podeSerLow);
  if (!lista.length) return { marcar: true, enviados: 0 };
  let busca;
  try { busca = new URL(msg.url).searchParams; } catch (e) { busca = new URLSearchParams(); }
  const r = await api("/api/anuncios", {
    anuncios: lista, termo: busca.get("q") || "",
    // O país vem da própria URL que você abriu — não adianta assumir BR.
    pais: busca.get("country") || "BR",
    passivo: true,                         // não conta como pesquisa nem gasta uso
  });
  await status(`Pesquisa automática: +${lista.length} anúncio(s) enviados ao minerador`
    + ` (${r.novos} novos).`);
  // a URL da mídia vence e o destino precisa ser analisado: um pouco agora
  if (r.pendentes) moerFila(r.pendentes, 3);
  if (r.midias_pendentes) moerMidias(r.midias_pendentes, 3);
  return { marcar: true, enviados: lista.length };
}

// ------------------------------------------------------------------ mineração automática

// Fica X minutos buscando sozinho com palavras-chave que costumam achar low
// ticket (lista montada no servidor: o que já rendeu + datas que vêm aí +
// gatilhos de copy). Termo usado nas últimas 24h vai para o fim da fila, então
// rodadas seguidas exploram termos novos.
const HIST_AUTO = "autoHist";
const DIA = 24 * 60 * 60 * 1000;

async function minerarAuto(conf) {
  if (rodando || filaEmCurso) throw new Error("Já existe uma pesquisa rodando.");
  const fim = Date.now() + (conf.minutos || 10) * 60000;
  filaEmCurso = true;
  pararFila = false;
  await marcarExecucao({ filaEmCurso: true, pedidoParar: false });
  manterVivo(true);
  let buscas = 0, novos = 0, lowAntes = null, falhasSeguidas = 0, ultimoErro = "";
  try {
    const idioma = conf.idioma || (["MX", "AR", "CO", "CL", "PE", "EC", "UY", "ES"]
      .includes(conf.pais) ? "es" : "pt");
    await status("Mineração automática: montando palavras-chave…");
    const [lista, resumo] = await Promise.all([
      api(`/api/auto/termos?idioma=${idioma}`, null, "GET"),
      api("/api/resumo", null, "GET").catch(() => null),
    ]);
    lowAntes = resumo ? resumo.low_ticket : null;

    const hist = (await chrome.storage.local.get(HIST_AUTO))[HIST_AUTO] || {};
    const agora = Date.now();
    for (const t in hist) if (agora - hist[t] > 7 * DIA) delete hist[t];
    const termos = (lista.termos || []).slice()
      .sort((a, b) => (agora - (hist[a] || 0) < DIA) - (agora - (hist[b] || 0) < DIA));
    if (!termos.length) throw new Error("O servidor não mandou palavras-chave.");

    for (const termo of termos) {
      const resta = fim - Date.now();
      if (resta < 45000 || pararFila || await pediramParar()) break;
      const min = Math.ceil(resta / 60000);
      await status(`🤖 Automático · faltam ${min} min · busca ${buscas + 1}: "${termo}"`);
      try {
        const r = await pesquisar({
          ...conf, termo, emFila: true, usarAbaAtual: false, abrirDashboard: false,
          varreduraProfunda: false,                 // contagem profunda come o tempo todo
          timeoutMs: Math.min(conf.timeoutMs || 300000, Math.max(30000, resta - 30000), 150000),
        });
        buscas++;
        novos += r.novos || 0;
        falhasSeguidas = 0;
      } catch (e) {
        if (foiInterrompida(e)) break;
        console.warn("busca automática falhou em", termo, e);
        ultimoErro = e.message;
        if (++falhasSeguidas >= 3) {
          throw new Error(`3 buscas seguidas falharam (${ultimoErro}). `
            + "Confira se o Facebook está logado e a aba da Biblioteca abre normalmente.");
        }
        await status(`🤖 "${termo}" falhou: ${ultimoErro} — tentando o próximo termo…`);
        await esperar(4000);
      }
      hist[termo] = Date.now();
      await chrome.storage.local.set({ [HIST_AUTO]: hist });
    }

    const depois = await api("/api/resumo", null, "GET").catch(() => null);
    const ganhou = depois && lowAntes != null ? depois.low_ticket - lowAntes : null;
    const parou = pararFila || await pediramParar();
    await status(`🤖 ${parou ? "Mineração automática interrompida" : "Mineração automática terminada"}: `
      + `${buscas} busca(s), ${novos} anúncios novos`
      + (ganhou != null ? `, +${Math.max(0, ganhou)} low ticket no minerador (total ${depois.low_ticket}).`
                        : "."), { concluido: true });
  } finally {
    filaEmCurso = false;
    await marcarExecucao({ filaEmCurso: false });
    manterVivo(false);
  }
}

// ------------------------------------------------------------------ recuperar fotos

// Capa morta = URL da Meta que venceu antes da cópia. Não tem como baixar de
// novo: só a Biblioteca entrega URL fresca. Então visita a página de cada
// anunciante sem foto numa aba de fundo, coleta poucos anúncios e reenvia — o
// /api/anuncios copia a capa (quadro do vídeo inclusive) na mesma chamada.
// Termo vazio: não gasta uso.
async function recuperarFotos(conf) {
  if (rodando) throw new Error("Já existe uma pesquisa rodando.");
  rodando = true;
  await marcarExecucao({ rodando: true, pedidoParar: false });
  manterVivo(true);
  let abaFundo = null, salvas = 0, feitos = 0;
  try {
    const filtro = conf.soLow ? "&low=1" : "";
    const j = await api(`/api/sem-foto?limite=${conf.max || 30}${filtro}`, null, "GET");
    const lista = j.anunciantes || [];
    if (!lista.length) {
      await status("Nenhum anunciante sem foto. 🎉", { concluido: true });
      return;
    }
    for (const a of lista) {
      if (await pediramParar()) break;
      feitos++;
      await status(`Recuperando fotos: ${a.page_name || a.page_id} (${feitos}/${lista.length})`);
      const url = montarUrl({ pageId: a.page_id, pais: a.pais || "BR" });
      try {
        if (abaFundo === null) abaFundo = await abaDeFundo(url);
        else await chrome.tabs.update(abaFundo, { url: url + MARCA_FUNDO });
        await esperar(1500);
        await esperarPronto(abaFundo);
        await chrome.tabs.sendMessage(abaFundo, { tipo: "ZERAR" });
        // poucos anúncios bastam: qualquer um com mídia fresca vira a capa
        const anuncios = await coletarNaAba(abaFundo, 8, 30000, 4);
        if (anuncios.length) {
          const r = await api("/api/anuncios", { anuncios, termo: "", pais: a.pais || "BR" });
          salvas += r.capas_guardadas || 0;
        }
      } catch (e) {
        console.warn("recuperar foto falhou em", a.page_id, e);
      }
    }
    const resto = j.total - feitos;
    if (await pediramParar()) {
      await status(`Recuperação interrompida: ${salvas} capas salvas.`, { concluido: true });
      return;
    }
    await status(`Fotos: ${salvas} capas salvas em ${feitos} anunciantes.`
      + (resto > 0 ? ` Faltam ${resto} — clique de novo para continuar.` : ""), { concluido: true });
  } finally {
    if (abaFundo !== null) await chrome.tabs.remove(abaFundo).catch(() => {});
    rodando = false;
    await marcarExecucao({ rodando: false });
    manterVivo(false);
  }
}

// ------------------------------------------------------------------ ponte com o popup

chrome.runtime.onMessage.addListener((msg, _rem, responder) => {
  // Botão de salvar da barra que o overlay.js põe em cima de cada anúncio.
  if (msg.tipo === "SALVAR_UM") {
    (async () => {
      try {
        const r = await api("/api/anuncios", {
          anuncios: [msg.anuncio], termo: "", pais: msg.pais || "BR",
        });

        // Ingerir não basta: um anúncio sozinho dá 1 ativo e o filtro padrão do
        // painel (2+ anúncios) o esconde. Salvar pela ★ é intenção explícita,
        // então ele vai para Melhores, que ignora filtro.
        let melhores = false;
        if (msg.anuncio && msg.anuncio.page_id) {
          try {
            await api("/api/favoritos", { page_id: String(msg.anuncio.page_id) });
            melhores = true;
          } catch (e) {
            console.warn("não deu para salvar em Melhores", e);
          }
        }

        if (r.pendentes) moerFila(r.pendentes, 3);
        if (r.midias_pendentes) moerMidias(r.midias_pendentes, 5);
        responder({ ok: true, novos: r.novos, melhores });
      } catch (e) {
        responder({ ok: false, erro: e.message });
      }
    })();
    return true;
  }

  if (msg.tipo === "ABRIR_PAINEL") {
    cfg().then(({ apiUrl }) => chrome.tabs.create({ url: apiUrl + "/", active: true }));
    return false;
  }

  // Responde já e trabalha depois: segurar o canal aberto durante a pesquisa
  // rende "message channel closed" toda vez que o worker dorme ou o popup some.
  // O andamento o popup lê por STATUS.
  if (msg.tipo === "PESQUISAR_FILA") {
    pesquisarFila(msg.cfg).catch(async (e) => {
      if (foiInterrompida(e)) return;    // o status de "interrompida" já foi dado
      await status("Erro: " + e.message, { erro: true });
    });
    responder({ ok: true, iniciado: true });
    return false;
  }

  if (msg.tipo === "PARAR_FILA") {
    pararFila = true;
    (async () => {
      let abas = [];
      try {
        await marcarExecucao({ pedidoParar: true });
        // não basta parar entre termos: a rolagem em andamento tem que parar já
        abas = await chrome.tabs.query({ url: "*://*.facebook.com/ads/library*" });
        for (const aba of abas) {
          chrome.tabs.sendMessage(aba.id, { tipo: "PARAR_COLETA" }).catch(() => {});
        }
        await status("Parando… salvando o que já foi coletado.");
      } catch (e) {
        console.warn("parar falhou", e);
      }
      responder({ ok: true, abas: abas.length });
    })();
    return true;
  }

  if (msg.tipo === "CAPTURADOS") {
    // Em fila: dois envios ao mesmo tempo da mesma aba duplicariam a contagem.
    enviandoCapturados = enviandoCapturados
      .then(() => receberCapturados(msg))
      .then(responder, (e) => { console.warn("envio passivo falhou", e); responder({ marcar: false }); });
    return true;
  }

  if (msg.tipo === "MINERAR_AUTO") {
    minerarAuto(msg.cfg || {}).catch(async (e) => {
      if (foiInterrompida(e)) return;
      await status("Erro: " + e.message, { erro: true });
    });
    responder({ ok: true, iniciado: true });
    return false;
  }

  if (msg.tipo === "RECUPERAR_FOTOS") {
    recuperarFotos(msg.cfg || {}).catch(async (e) => {
      if (foiInterrompida(e)) return;    // o status de "interrompida" já foi dado
      await status("Erro: " + e.message, { erro: true });
    });
    responder({ ok: true, iniciado: true });
    return false;
  }

  if (msg.tipo === "PESQUISAR") {
    pesquisar(msg.cfg).catch(async (e) => {
      if (foiInterrompida(e)) return;    // o status de "interrompida" já foi dado
      await status("Erro: " + e.message, { erro: true });
    });
    responder({ ok: true, iniciado: true });
    return false;
  }
  // O popup pode nascer no meio de uma pesquisa (o painel flutuante é recriado
  // quando a aba navega). Quem sabe se algo está rodando é o service worker.
  if (msg.tipo === "STATUS") {
    (async () => {
      const e = await lerExecucao();
      const s = await chrome.storage.local.get("status");
      responder({ ...(s.status || {}),
                  rodando: rodando || !!e.rodando,
                  filaEmCurso: filaEmCurso || !!e.filaEmCurso });
    })();
    return true;
  }
});
