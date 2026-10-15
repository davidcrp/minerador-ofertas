// Roda no contexto DA PÁGINA (world: MAIN), antes de qualquer script do Facebook.
// Intercepta as respostas do GraphQL que a própria Biblioteca de Anúncios pede e
// repassa o corpo cru para o content script via postMessage.
//
// Ler a resposta da própria página é bem mais robusto do que raspar o DOM: o
// layout muda toda hora, o JSON não.

(() => {
  const ALVO = "/api/graphql";

  function repassar(corpo) {
    if (typeof corpo !== "string" || corpo.indexOf("ad_archive_id") === -1) return;
    try {
      window.postMessage({ __minerador: "graphql", corpo }, "*");
    } catch (e) {
      /* corpo grande demais para clonar — ignora */
    }
  }

  // fetch
  const fetchOriginal = window.fetch;
  window.fetch = function (...args) {
    const p = fetchOriginal.apply(this, args);
    p.then((resp) => {
      try {
        const url = (resp && resp.url) || String(args[0] || "");
        if (url.indexOf(ALVO) !== -1) resp.clone().text().then(repassar).catch(() => {});
      } catch (e) {}
    }).catch(() => {});
    return p;
  };

  // XMLHttpRequest (o Facebook ainda usa em alguns caminhos)
  const abrirOriginal = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (metodo, url, ...resto) {
    this.__minerador_url = String(url || "");
    return abrirOriginal.call(this, metodo, url, ...resto);
  };

  const enviarOriginal = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        if ((this.__minerador_url || "").indexOf(ALVO) !== -1) {
          if (this.responseType === "" || this.responseType === "text") repassar(this.responseText);
        }
      } catch (e) {}
    });
    return enviarOriginal.apply(this, args);
  };
})();
