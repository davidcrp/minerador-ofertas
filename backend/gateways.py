"""Impressões digitais de gateways / plataformas de checkout.

Cada entrada: nome -> (dominios, marcadores no HTML).
`dominios` casa contra qualquer host da cadeia de redirects ou de links de
checkout achados na página. `marcadores` são trechos que aparecem no HTML
(src de script, pixel, texto do rodapé).
"""

from __future__ import annotations

import re
from html import unescape
from urllib.parse import urlparse

GATEWAYS: dict[str, dict[str, list[str]]] = {
    # --- infoprodutos / low ticket BR ---
    "Kiwify":        {"dominios": ["kiwify.com.br", "kiwify.com", "kiwify.app", "pay.kiwify.com.br"],
                      "marcadores": ["kiwify"]},
    "Hotmart":       {"dominios": ["hotmart.com", "hotmart.es", "pay.hotmart.com", "hotm.art"],
                      "marcadores": ["hotmart"]},
    "Eduzz":         {"dominios": ["eduzz.com", "sun.eduzz.com", "chk.eduzz.com"],
                      "marcadores": ["eduzz"]},
    "Monetizze":     {"dominios": ["monetizze.com.br", "checkout.monetizze.com.br"],
                      "marcadores": ["monetizze"]},
    "Braip":         {"dominios": ["braip.com", "ev.braip.com", "checkout.braip.com"],
                      "marcadores": ["braip"]},
    "Cakto":         {"dominios": ["cakto.com.br", "pay.cakto.com.br"],
                      "marcadores": ["cakto"]},
    "Perfect Pay":   {"dominios": ["perfectpay.com.br", "go.perfectpay.com.br"],
                      "marcadores": ["perfectpay", "perfect pay"]},
    "Ticto":         {"dominios": ["ticto.com.br", "checkout.ticto.com.br", "ticto.app"],
                      "marcadores": ["ticto"]},
    "Kirvano":       {"dominios": ["kirvano.com", "pay.kirvano.com"],
                      "marcadores": ["kirvano"]},
    "Greenn":        {"dominios": ["greenn.com.br", "checkout.greenn.com.br"],
                      "marcadores": ["greenn"]},
    "Lastlink":      {"dominios": ["lastlink.com"], "marcadores": ["lastlink"]},
    "Hubla":         {"dominios": ["hubla.com.br", "hub.la"], "marcadores": ["hubla"]},
    "Doppus":        {"dominios": ["doppus.com", "doppus.app"], "marcadores": ["doppus"]},
    "Payt":          {"dominios": ["payt.com.br"], "marcadores": ["payt.com.br"]},
    "Digital Manager Guru": {"dominios": ["digitalmanager.guru", "mycartpanda.com"],
                             "marcadores": ["digitalmanager", "cartpanda"]},
    "Pepper":        {"dominios": ["pepper.com.br", "usepepper.com.br"],
                      "marcadores": ["usepepper"]},
    "Voomp":         {"dominios": ["voompcreators.com.br", "voomp.com.br"],
                      "marcadores": ["voomp"]},
    "TriboPay":      {"dominios": ["tribopay.com.br"], "marcadores": ["tribopay"]},
    "Zouti":         {"dominios": ["zouti.com.br", "zouti.io"], "marcadores": ["zouti"]},
    "Astron Members": {"dominios": ["astronmembers.com.br"], "marcadores": ["astronmembers"]},
    "GGCheckout":    {"dominios": ["ggcheckout.app", "ggcheckout.com", "ggcheckout.com.br"],
                      "marcadores": ["ggcheckout"]},

    # --- ecommerce / genéricos ---
    "Yampi":         {"dominios": ["yampi.com.br", "seguro.pay.yampi.com.br", "catalog.yampi.io"],
                      "marcadores": ["yampi"]},
    "Appmax":        {"dominios": ["appmax.com.br"], "marcadores": ["appmax"]},
    "Shopify":       {"dominios": ["myshopify.com", "shopify.com"],
                      "marcadores": ["cdn.shopify.com", "shopify-features"]},
    # Mesma plataforma, dois nomes comerciais (BR: Nuvemshop, ES: Tiendanube) —
    # e o CDN é compartilhado, então não dá para separar por domínio.
    "Nuvemshop/Tiendanube": {"dominios": ["nuvemshop.com.br", "lojavirtualnuvem.com.br",
                                          "tiendanube.com", "mitiendanube.com"],
                             "marcadores": ["nuvemshop", "tiendanube"]},
    "Mercado Pago":  {"dominios": ["mercadopago.com", "mercadopago.com.br", "mercadopago.com.ar",
                                   "mercadopago.com.mx", "mercadopago.com.co", "mercadopago.cl",
                                   "mercadopago.com.pe", "mercadopago.com.uy", "mpago.la", "mpago.li"],
                      "marcadores": ["mercadopago"]},
    "PagSeguro":     {"dominios": ["pagseguro.uol.com.br", "pagbank.com.br", "pag.ae"],
                      "marcadores": ["pagseguro", "pagbank"]},
    "Stripe":        {"dominios": ["stripe.com", "checkout.stripe.com", "buy.stripe.com"],
                      "marcadores": ["js.stripe.com"]},
    "PayPal":        {"dominios": ["paypal.com"], "marcadores": ["paypalobjects.com"]},
    "Asaas":         {"dominios": ["asaas.com"], "marcadores": ["asaas"]},
    "InfinitePay":   {"dominios": ["infinitepay.io"], "marcadores": ["infinitepay"]},

    # --- mercados de língua espanhola (LATAM + Espanha) ---
    "PayU":          {"dominios": ["payu.com", "payulatam.com", "gateway.payulatam.com"],
                      "marcadores": ["payulatam", "payu.com"]},
    "dLocal":        {"dominios": ["dlocal.com", "dlocalgo.com"],
                      "marcadores": ["dlocal"]},
    "ePayco":        {"dominios": ["epayco.co", "epayco.com", "checkout.epayco.co"],
                      "marcadores": ["epayco"]},
    "Wompi":         {"dominios": ["wompi.co", "checkout.wompi.co"], "marcadores": ["wompi"]},
    "Bold":          {"dominios": ["bold.co", "checkout.bold.co"], "marcadores": ["bold.co"]},
    "Openpay":       {"dominios": ["openpay.mx", "openpay.co"], "marcadores": ["openpay"]},
    "Conekta":       {"dominios": ["conekta.com", "pay.conekta.com"], "marcadores": ["conekta"]},
    "Clip":          {"dominios": ["clip.mx", "pay.clip.mx"], "marcadores": ["clip.mx"]},
    "Kueski Pay":    {"dominios": ["kueski.com", "kueskipay.com"], "marcadores": ["kueski"]},
    "Culqi":         {"dominios": ["culqi.com", "checkout.culqi.com"], "marcadores": ["culqi"]},
    "Izipay":        {"dominios": ["izipay.pe"], "marcadores": ["izipay"]},
    "Niubiz":        {"dominios": ["niubiz.com.pe"], "marcadores": ["niubiz"]},
    "Flow":          {"dominios": ["flow.cl", "www.flow.cl"], "marcadores": ["flow.cl"]},
    "Webpay":        {"dominios": ["webpay.cl", "transbank.cl", "webpay3g.transbank.cl"],
                      "marcadores": ["webpay", "transbank"]},
    "Khipu":         {"dominios": ["khipu.com"], "marcadores": ["khipu"]},
    "Mobbex":        {"dominios": ["mobbex.com"], "marcadores": ["mobbex"]},
    "Rebill":        {"dominios": ["rebill.com", "rebill.to"], "marcadores": ["rebill"]},
    "Redsys":        {"dominios": ["redsys.es", "sis.redsys.es"], "marcadores": ["redsys"]},
    "Bizum":         {"dominios": ["bizum.es"], "marcadores": ["bizum"]},
    "Paycomet":      {"dominios": ["paycomet.com"], "marcadores": ["paycomet"]},
}

# Que tipo de operação cada plataforma denuncia. Low ticket de infoproduto vive
# em Kiwify/Hotmart/Cakto e afins; loja de e-commerce é outro jogo (frete,
# estoque, ticket médio maior).
TIPO_GATEWAY = {
    "infoproduto": {
        "Kiwify", "Hotmart", "Eduzz", "Monetizze", "Braip", "Cakto", "Perfect Pay",
        "Ticto", "Kirvano", "Greenn", "Lastlink", "Hubla", "Doppus", "Payt",
        "Digital Manager Guru", "Pepper", "Voomp", "TriboPay", "Zouti",
        "Astron Members", "GGCheckout",
    },
    "ecommerce": {"Shopify", "Nuvemshop/Tiendanube", "Yampi", "Appmax"},
}


def tipo_de(gateway: str) -> str:
    for tipo, nomes in TIPO_GATEWAY.items():
        if gateway in nomes:
            return tipo
    return "pagamento" if gateway else ""


# Meios de pagamento aceitos pela loja (selo no rodapé, script do checkout) vs.
# a plataforma onde a oferta roda. Um link para mercadopago.com no rodapé de uma
# loja Shopify não faz dela um checkout do Mercado Pago: quando os dois aparecem
# na mesma página, a plataforma ganha.
PAGAMENTO = {
    "Mercado Pago", "PagSeguro", "Stripe", "PayPal", "Asaas", "InfinitePay", "Appmax",
    "PayU", "dLocal", "ePayco", "Wompi", "Bold", "Openpay", "Conekta", "Clip",
    "Kueski Pay", "Culqi", "Izipay", "Niubiz", "Flow", "Webpay", "Khipu", "Mobbex",
    "Rebill", "Redsys", "Bizum", "Paycomet",
}

# Hosts que nunca são gateway — evitam falso positivo na cadeia de redirect.
IGNORAR = {
    "l.facebook.com", "lm.facebook.com", "facebook.com", "www.facebook.com",
    "instagram.com", "www.instagram.com", "bit.ly", "linktr.ee", "t.co",
    "google.com", "www.google.com", "api.whatsapp.com", "wa.me",
}

RE_LINK = re.compile(r"""https?://[^\s"'<>\\)]+""", re.I)

# Preço em pt-BR e nos mercados de língua espanhola. O símbolo "$" sozinho é
# ambíguo (MXN, ARS, COP, CLP, USD…), então a moeda da página é inferida à
# parte e usada para saber o que é valor plausível.
RE_PRECO = re.compile(
    # "S/" (sol peruano) só vale precedido de espaço/início — senão casa dentro
    # de caminhos como "assets/019".
    r"(?P<moeda>R\$|US\$|(?<![\w/])S/\.?|€"
    # código de 3 letras só vale como palavra solta e seguido de espaço, senão
    # casa lixo de HTML/JS ("...bRl5...").
    r"|(?<![A-Za-z])(?:MXN|ARS|COP|CLP|PEN|UYU|USD|EUR|BRL)(?=\s)"
    r"|\$)\s?"
    r"(?P<valor>\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)"
    r"|(?P<valor2>\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s?(?P<moeda2>€|\b(?:reais|pesos|soles|euros)\b)",
    re.I,
)

SIMBOLO_MOEDA = {
    "r$": "BRL", "brl": "BRL", "reais": "BRL",
    "us$": "USD", "usd": "USD",
    "€": "EUR", "eur": "EUR", "euros": "EUR",
    "s/": "PEN", "s/.": "PEN", "pen": "PEN", "soles": "PEN",
    "mxn": "MXN", "ars": "ARS", "cop": "COP", "clp": "CLP", "uyu": "UYU",
}

# Faixa plausível para preço de oferta em cada moeda — o que separa preço de
# número solto ("+2.000 alunos") muda muito entre BRL e COP.
FAIXA_MOEDA = {
    "BRL": (3, 5_000), "USD": (3, 3_000), "EUR": (3, 3_000), "PEN": (10, 10_000),
    "MXN": (30, 60_000), "ARS": (500, 5_000_000), "COP": (5_000, 20_000_000),
    "CLP": (1_000, 3_000_000), "UYU": (100, 200_000),
}

MOEDA_POR_TLD = {
    ".com.br": "BRL", ".br": "BRL", ".com.mx": "MXN", ".mx": "MXN",
    ".com.ar": "ARS", ".ar": "ARS", ".com.co": "COP", ".co": "COP",
    ".cl": "CLP", ".com.pe": "PEN", ".pe": "PEN", ".com.uy": "UYU", ".uy": "UYU",
    ".es": "EUR", ".pt": "EUR",
}

RE_CODIGO_MOEDA = re.compile(r"\b(MXN|ARS|COP|CLP|PEN|UYU|BRL|EUR|USD)\b")
RE_WHATS = re.compile(
    r"(?:wa\.me/|api\.whatsapp\.com/send\?phone=|whatsapp\.com/send/\?phone=)(\d{10,15})", re.I
)


def host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower().removeprefix("www.")
    except Exception:
        return ""


def _casa_dominio(h: str, dominios: list[str]) -> str | None:
    for d in dominios:
        if h == d or h.endswith("." + d) or d in h:
            return d
    return None


HOSTS_ASSET = ("static", "cdn", "img", "image", "assets", "media", "js", "css")
EXT_ASSET = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".css", ".js",
             ".woff", ".woff2", ".ico", ".mp4")


def _parece_checkout(url: str, h: str) -> bool:
    primeiro = h.split(".")[0]
    if primeiro in HOSTS_ASSET or any(primeiro.startswith(a) for a in HOSTS_ASSET):
        return False
    if url.lower().split("?")[0].endswith(EXT_ASSET):
        return False
    return True


def e_gateway(url: str) -> bool:
    """O endereço é do próprio checkout/plataforma (não uma página de venda)."""
    h = host(url)
    return bool(h) and any(_casa_dominio(h, fp["dominios"]) for fp in GATEWAYS.values())


def detectar(cadeia: list[str], html: str) -> tuple[str, str, str]:
    """Devolve (gateway, evidencia, checkout_url).

    Ordem de confiança:
      1. host da cadeia de redirects (destino final já é o checkout)
      2. link de checkout encontrado dentro do HTML
      3. marcador textual no HTML (script/pixel do gateway)
    """
    html = unescape(html or "")  # &amp; nos hrefs viraria URL quebrada
    hosts = [host(u) for u in cadeia if u]

    for h in hosts:
        if not h or h in IGNORAR:
            continue
        for nome, fp in GATEWAYS.items():
            achado = _casa_dominio(h, fp["dominios"])
            if achado:
                return nome, f"redirect -> {h}", cadeia[-1]

    # Links dentro da página: um CDN do gateway (static-media.hotmart.com) prova
    # a plataforma mas não serve como URL de checkout, então guardamos os dois
    # separados e só devolvemos como checkout o que parece de fato um checkout.
    plataforma_vista = ("", "", "")
    pagamento_visto = ("", "", "")
    for link in RE_LINK.findall(html or ""):
        h = host(link)
        if not h or h in IGNORAR:
            continue
        for nome, fp in GATEWAYS.items():
            if not _casa_dominio(h, fp["dominios"]):
                continue
            achado = (nome, f"link na página -> {h}", link) if _parece_checkout(link, h) \
                else (nome, f"asset do gateway -> {h}", "")
            if nome in PAGAMENTO:
                if not pagamento_visto[0]:
                    pagamento_visto = achado
            elif achado[2]:
                return achado           # plataforma com link de checkout: melhor sinal
            elif not plataforma_vista[0]:
                plataforma_vista = achado
    for achado in (plataforma_vista, pagamento_visto):
        if achado[0]:
            return achado

    # Marcador textual descreve a plataforma DA página. Se o destino final é
    # rede social ou agregador de links, o que está no HTML é da rede (o
    # instagram.com cita "dlocal" no próprio código), não da oferta.
    if host(cadeia[-1] if cadeia else "") in IGNORAR:
        return "", "", ""

    baixo = (html or "").lower()
    adiado = ("", "", "")
    for nome, fp in GATEWAYS.items():
        for marcador in fp["marcadores"]:
            if marcador not in baixo:
                continue
            if nome in PAGAMENTO:
                if not adiado[0]:
                    adiado = (nome, f"marcador no HTML: {marcador}", "")
            else:
                return nome, f"marcador no HTML: {marcador}", ""
    return adiado


# "12x de", "12 cuotas de", "3 pagos de", "12 meses sin intereses"
# Preço riscado / âncora: "De R$ 147 por R$ 14,90", "Economia de R$ 132".
RE_ANCORA = re.compile(r"(?:\bde|\bera|\bantes|economi[az]e?\s+de|desconto\s+de|"
                       r"\bdesde|ahorra|ahorro\s+de|acima\s+de|compras\s+de|"
                       r"m[ií]nimo\s+de)[\s\"':]*$", re.I)
# Valor que é desconto, não preço: "R$ 10,00 OFF", "R$ 20 de desconto".
RE_DESCONTO_DEPOIS = re.compile(r"^[\s\"']*(?:off\b|de\s+desconto|desconto|de\s+cashback|"
                                r"de\s+frete|de\s+descuento|en\s+descuento)", re.I)

RE_PARCELA = re.compile(
    r"(\d+\s*(?:x|cuotas?|pagos?|parcelas?|meses)\s*(?:de\s*|sin\s+inter[eé]s(?:es)?\s*)?|/\s*)$",
    re.I,
)


def _num(v: str) -> float:
    """Converte o número escrito em qualquer das duas convenções: 1.234,56
    (pt-BR, AR, CO) e 1,234.56 (MX, PE, US). Quando aparecem os dois
    separadores, o último é o decimal."""
    limpo = re.sub(r"[^\d,.]", "", v)
    if not limpo:
        return -1.0
    ult_ponto, ult_virgula = limpo.rfind("."), limpo.rfind(",")
    if ult_ponto >= 0 and ult_virgula >= 0:
        decimal = "." if ult_ponto > ult_virgula else ","
    elif ult_virgula >= 0:
        decimal = "," if len(limpo) - ult_virgula - 1 in (1, 2) else ""
    elif ult_ponto >= 0:
        decimal = "." if len(limpo) - ult_ponto - 1 in (1, 2) else ""
    else:
        decimal = ""
    milhar = "." if decimal == "," else ","
    limpo = limpo.replace(milhar, "")
    if decimal:
        limpo = limpo.replace(decimal, ".")
    else:
        limpo = limpo.replace(".", "").replace(",", "")
    try:
        return float(limpo)
    except ValueError:
        return -1.0


def moeda_da_pagina(html: str, url: str = "") -> str:
    """Moeda provável da página: código escrito com todas as letras ganha do
    domínio, que ganha do palpite final (USD). Serve para saber o que "$ 25.000"
    significa — preço em ARS ou lixo em BRL."""
    codigos = RE_CODIGO_MOEDA.findall((html or "").upper())
    if codigos:
        return max(set(codigos), key=codigos.count)
    if "R$" in (html or ""):
        return "BRL"
    h = host(url)
    for tld, moeda in MOEDA_POR_TLD.items():
        if h.endswith(tld):
            return moeda
    return "USD"


def achar_preco(html: str, url: str = "") -> str:
    """Preço da oferta. Descarta parcelas ("12x de R$ 7,50", "12 cuotas de
    $2.500") e valores fora da faixa plausível da moeda, e fica com o que mais
    se repete na página — o preço cheio costuma aparecer em vários lugares
    (headline, caixa de checkout, comparativo)."""
    # Sem as tags: "12 x de </span><span>R$ 10,03" no HTML cru escondia a
    # parcela do filtro, e produto de R$ 97 entrava como low ticket de R$ 10.
    # Espaços juntados: a quebra de linha que sobra das tags empurrava o "5 x de"
    # para fora da janela que o filtro de parcela olha.
    texto = re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", html or "")))
    padrao = moeda_da_pagina(texto, url)
    contagem: dict[str, int] = {}
    valores: dict[str, float] = {}
    for m in RE_PRECO.finditer(texto):
        bruto = m.group(0)
        antes = texto[max(0, m.start() - 20):m.start()]
        if RE_PARCELA.search(antes.strip()) or RE_ANCORA.search(antes) \
                or RE_DESCONTO_DEPOIS.search(texto[m.end():m.end() + 20]):
            continue
        marcador = (m.group("moeda") or m.group("moeda2") or "").lower()
        moeda = SIMBOLO_MOEDA.get(marcador.rstrip("."), padrao)  # "$" e "pesos" caem no padrão
        minimo, maximo = FAIXA_MOEDA.get(moeda, (3, 5_000))
        valor = _num(m.group("valor") or m.group("valor2") or "")
        if valor < minimo or valor > maximo:
            continue
        chave = re.sub(r"\s+", " ", bruto).strip()
        contagem[chave] = contagem.get(chave, 0) + 1
        valores[chave] = valor
    if not contagem:
        return ""
    # mais frequente; empate resolve pelo menor (oferta de entrada)
    return sorted(contagem.items(), key=lambda x: (-x[1], valores[x[0]]))[0][0]


def valor_e_moeda(preco: str, padrao: str = "BRL") -> tuple[float, str]:
    """Do texto achado ("R$ 97,00", "$1,188.00") para (97.0, "BRL") — é isso que
    permite filtrar faixa de preço no banco em vez de comparar string."""
    if not preco:
        return (0.0, "")
    m = RE_PRECO.search(preco)
    marcador = ((m.group("moeda") or m.group("moeda2") or "") if m else "").lower()
    moeda = SIMBOLO_MOEDA.get(marcador.rstrip("."), padrao)
    valor = _num(preco)
    return (valor if valor > 0 else 0.0, moeda)


def achar_whatsapp(html: str) -> str:
    m = RE_WHATS.search(html or "")
    return m.group(1) if m else ""
