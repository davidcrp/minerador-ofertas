"""Transforma uma ideia ("produtos para o natal", "sazonalidade") em palavras-chave.

A Biblioteca de Anúncios busca por texto do anúncio, então o que rende é o
termo que o anunciante de low ticket escreve na copy: "ebook de receitas de
natal", "moldes de enfeites natalinos", "kit cartinha do papai noel".

Ideia abstrata ("sazonalidade", "presentes", "datas comemorativas") não serve
como busca: ela é destrinchada em temas concretos — e "sazonal" quer dizer as
datas comerciais que vêm aí, não Páscoa em outubro. Por isso a IA recebe a data
de hoje e o calendário comercial.

Ordem: Gemini (GEMINI_API_KEY, plano gratuito do Google AI Studio) ->
Claude (ANTHROPIC_API_KEY) -> gerador local por regras. Qualquer falha (cota,
rede, resposta torta) desce para o próximo, então a extensão nunca fica sem
resposta.
"""

from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from datetime import date, timedelta

MAX_TERMOS = 30

# --------------------------------------------------------------- calendário

# (mês, dia aproximado, nome, palavras que a copy desses nichos usa).
# Data móvel (Páscoa, Carnaval, Dia das Mães/Pais, Black Friday) vai pelo dia
# típico: o corte é "o que vem nos próximos meses", não precisão de agenda.
CALENDARIO_BR = [
    (1, 20, "Volta às aulas", ["volta às aulas", "atividades escolares", "etiquetas escolares",
                               "material escolar personalizado", "apostila de alfabetização"]),
    (2, 15, "Carnaval", ["abadá personalizado", "fantasia de carnaval", "kit carnaval",
                         "maquiagem de carnaval"]),
    (3, 8, "Dia da Mulher", ["dia da mulher", "lembrancinha dia da mulher",
                             "mimo dia das mulheres"]),
    (4, 5, "Páscoa", ["ovos de páscoa", "páscoa lucrativa", "receitas de páscoa",
                      "ovo de colher", "lembrancinhas de páscoa", "moldes coelho páscoa"]),
    (5, 10, "Dia das Mães", ["dia das mães", "presente dia das mães",
                             "lembrancinhas dia das mães", "cesta café da manhã"]),
    (6, 12, "Dia dos Namorados", ["dia dos namorados", "presente namorados",
                                  "caixa surpresa namorados", "cesta romântica"]),
    (6, 24, "Festa Junina", ["festa junina", "doces juninos para vender", "quentão",
                             "decoração festa junina", "comidas típicas juninas"]),
    (8, 10, "Dia dos Pais", ["dia dos pais", "presente dia dos pais",
                             "lembrancinhas dia dos pais", "cesta dia dos pais"]),
    (9, 15, "Dia do Cliente", ["dia do cliente", "brinde para clientes",
                               "mimos para clientes"]),
    (10, 12, "Dia das Crianças", ["dia das crianças", "presente dia das crianças",
                                  "atividades infantis", "brinquedos educativos",
                                  "livro de colorir", "kit festa infantil",
                                  "lembrancinhas dia das crianças", "jogos pedagógicos"]),
    (10, 15, "Dia dos Professores", ["dia dos professores", "lembrancinhas dia dos professores",
                                     "presente professora"]),
    (10, 31, "Halloween", ["halloween", "fantasia de halloween", "decoração halloween",
                           "doces de halloween", "festa halloween infantil"]),
    (11, 28, "Black Friday", ["black friday", "oferta black friday", "kit black friday",
                              "desconto black friday"]),
    (12, 25, "Natal", ["receitas de natal", "enfeites de natal", "decoração natalina",
                       "lembrancinhas de natal", "cartinha do papai noel", "ceia de natal",
                       "panetone caseiro", "moldes natalinos", "natal lucrativo",
                       "amigo secreto"]),
    (12, 31, "Ano Novo", ["ano novo", "planner 2027", "simpatias ano novo",
                          "metas para o ano novo", "réveillon"]),
]

CALENDARIO_ES = [
    (1, 6, "Día de Reyes", ["rosca de reyes", "regalos día de reyes"]),
    (2, 14, "San Valentín", ["san valentín", "regalos san valentín", "caja sorpresa"]),
    (4, 5, "Semana Santa / Pascua", ["huevos de pascua", "recetas semana santa"]),
    (5, 10, "Día de la Madre", ["día de la madre", "regalos día de la madre"]),
    (6, 15, "Día del Padre", ["día del padre", "regalos día del padre"]),
    (8, 1, "Regreso a clases", ["regreso a clases", "etiquetas escolares", "útiles escolares"]),
    (10, 31, "Halloween", ["halloween", "disfraz de halloween", "decoración halloween"]),
    (11, 2, "Día de Muertos", ["día de muertos", "altar de muertos", "pan de muerto",
                               "calaveritas de azúcar"]),
    (11, 28, "Black Friday", ["black friday", "ofertas black friday"]),
    (12, 25, "Navidad", ["recetas navideñas", "adornos navideños", "regalos navideños",
                         "moldes navideños", "cena navideña", "intercambio de regalos"]),
    (12, 31, "Año Nuevo", ["año nuevo", "rituales año nuevo", "planner 2027"]),
]


def proximas_datas(hoje: date | None = None, idioma: str = "pt", dias: int = 150) -> list[tuple]:
    """Datas comerciais dos próximos `dias`, da mais próxima à mais distante.
    Data que passou há menos de 5 dias ainda vale (o anúncio continua rodando)."""
    hoje = hoje or date.today()
    calendario = CALENDARIO_ES if idioma == "es" else CALENDARIO_BR
    saida = []
    for mes, dia, nome, termos in calendario:
        for ano in (hoje.year, hoje.year + 1):
            d = date(ano, mes, dia)
            if hoje - timedelta(days=5) <= d <= hoje + timedelta(days=dias):
                saida.append((d, nome, termos))
                break
    return sorted(saida)


# --------------------------------------------------------------- gerador local

PARADAS = {
    "pt": {"produto", "produtos", "para", "pra", "o", "a", "os", "as", "de", "do", "da",
           "dos", "das", "um", "uma", "e", "ideia", "ideias", "vender", "venda", "low",
           "ticket", "coisas", "algo", "sobre", "no", "na", "nos", "nas", "com", "em"},
    "es": {"producto", "productos", "para", "el", "la", "los", "las", "de", "del", "un",
           "una", "y", "idea", "ideas", "vender", "venta", "low", "ticket", "cosas",
           "sobre", "en", "con"},
}

# Formatos que vendem barato: é o vocabulário da copy de oferta de entrada.
FORMATOS = {
    "pt": ["ebook {c}", "kit {c}", "curso {c}", "apostila {c}", "pdf {c}", "moldes {c}",
           "planner {c}", "receitas {c}", "atividades {c}", "pack {c}", "guia {c}",
           "templates {c}", "{c} digital", "método {c}", "combo {c}"],
    "es": ["ebook {c}", "kit {c}", "curso {c}", "pdf {c}", "moldes {c}", "planner {c}",
           "recetas {c}", "actividades {c}", "pack {c}", "guía {c}", "plantillas {c}",
           "{c} digital", "método {c}", "combo {c}"],
}

# Nichos perenes que não são data do calendário.
TEMAS = {
    "emagrecer": ["emagrecer rápido", "dieta", "receitas fit", "jejum intermitente",
                  "cardápio low carb", "chá para emagrecer", "treino em casa"],
    "renda": ["renda extra", "ganhar dinheiro em casa", "trabalhar em casa",
              "negócio lucrativo", "vender todo dia"],
}
GATILHOS_TEMA = {
    "emagrecer": ("emagre", "dieta", "peso", "fit", "adelgaz"),
    "renda": ("renda", "dinheiro", "lucr", "ganhar", "dinero"),
}
# Gatilho -> nome da data no calendário.
GATILHOS_DATA = {
    "Natal": ("natal", "papai noel", "navidad"), "Navidad": ("natal", "navidad"),
    "Páscoa": ("pascoa",), "Semana Santa / Pascua": ("pascua",),
    "Dia das Mães": ("maes", "mae "), "Día de la Madre": ("madre",),
    "Dia dos Pais": ("pais",), "Día del Padre": ("padre",),
    "Volta às aulas": ("aula", "escola", "escolar", "alfabetiz"),
    "Regreso a clases": ("clases", "escolar"),
    "Dia das Crianças": ("crianca", "infantil"), "Halloween": ("halloween", "bruxa"),
    "Dia dos Namorados": ("namorad",), "San Valentín": ("valentin",),
    "Festa Junina": ("junin",), "Black Friday": ("black",), "Ano Novo": ("ano novo",),
    "Dia dos Professores": ("professor",), "Día de Muertos": ("muertos",),
}
# Ideia que pede "o que está na época" em vez de um nicho.
SAZONAL = ("sazon", "estacion", "temporada", "datas comemorativas", "data comemorativa",
           "fechas", "epoca", "presente", "regalo", "feriado", "comemorativ")


def _sem_acento(t: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", t) if unicodedata.category(c) != "Mn")


def _limpar(lista) -> list[str]:
    vistos, saida = set(), []
    for t in lista:
        t = re.sub(r"\s+", " ", str(t)).strip().strip(".,;\"'").lower()
        chave = _sem_acento(t)
        if 2 < len(t) <= 60 and chave not in vistos:
            vistos.add(chave)
            saida.append(t)
    return saida[:MAX_TERMOS]


def _intercalar(grupos: list[dict]) -> list[str]:
    """Um de cada tema por vez: o topo da lista cobre todos os temas, em vez de
    gastar os primeiros 10 chips num tema só."""
    filas = [list(g["termos"]) for g in grupos]
    saida = []
    while any(filas):
        for f in filas:
            if f:
                saida.append(f.pop(0))
    return _limpar(saida)


def _intercalar_todos(grupos: list[dict]) -> list[str]:
    """Como _intercalar, sem o teto de MAX_TERMOS (mineração automática)."""
    filas = [list(g["termos"]) for g in grupos]
    vistos, saida = set(), []
    while any(filas):
        for f in filas:
            if f:
                t = re.sub(r"\s+", " ", str(f.pop(0))).strip().lower()
                if t and _sem_acento(t) not in vistos:
                    vistos.add(_sem_acento(t))
                    saida.append(t)
    return saida


def _grupos_limpos(grupos: list[dict]) -> list[dict]:
    saida = []
    for g in grupos:
        termos = _limpar(g.get("termos") or [])
        if termos:
            saida.append({"tema": str(g.get("tema") or "").strip()[:60], "termos": termos})
    return saida


def gerar_local(ideia: str, idioma: str = "pt", hoje: date | None = None) -> dict:
    idioma = "es" if idioma == "es" else "pt"
    plano = " " + _sem_acento(ideia.lower()) + " "
    grupos = []

    datas = proximas_datas(hoje, idioma, dias=400)
    pedidas = [(d, n, t) for d, n, t in datas
               if any(g in plano for g in GATILHOS_DATA.get(n, ()))]
    if pedidas:
        grupos += [{"tema": n, "termos": t} for _, n, t in pedidas]
    elif any(g in plano for g in SAZONAL):
        # "sazonalidade": as datas que vêm aí, da mais próxima para a mais longe
        grupos += [{"tema": n, "termos": t} for _, n, t in proximas_datas(hoje, idioma)]

    for tema, gatilhos in GATILHOS_TEMA.items():
        if idioma == "pt" and any(g in plano for g in gatilhos):
            grupos.append({"tema": tema.capitalize(), "termos": TEMAS[tema]})

    if not grupos:
        # Só as palavras de enchimento das pontas saem ("produtos para o natal" ->
        # "natal"); as do meio ficam, senão "dia das mães" vira "dia mães".
        paradas = {_sem_acento(x) for x in PARADAS[idioma]}
        palavras = re.findall(r"[\wçãõáéíóúâêô]+", ideia.lower())
        while palavras and _sem_acento(palavras[0]) in paradas:
            palavras.pop(0)
        while palavras and _sem_acento(palavras[-1]) in paradas:
            palavras.pop()
        nucleo = " ".join(palavras[:5]) or ideia.strip()
        # "receitas receitas fit" não: formato que já está na ideia fica de fora
        formatos = [f.format(c=nucleo) for f in FORMATOS[idioma]
                    if _sem_acento(f.replace("{c}", "").strip()) not in _sem_acento(nucleo)]
        grupos.append({"tema": nucleo, "termos": [nucleo] + formatos})

    grupos = _grupos_limpos(grupos)
    return {"termos": _intercalar(grupos), "grupos": grupos}


# --------------------------------------------------------------- IA

ESQUEMA = {
    "type": "object",
    "properties": {
        "interpretacao": {"type": "string"},
        "temas": {"type": "array", "items": {
            "type": "object",
            "properties": {"tema": {"type": "string"},
                           "termos": {"type": "array", "items": {"type": "string"}}},
            "required": ["tema", "termos"],
            "additionalProperties": False,
        }},
    },
    "required": ["interpretacao", "temas"],
    "additionalProperties": False,
}

MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
         "setembro", "outubro", "novembro", "dezembro"]

INSTRUCOES = """Você é especialista em mineração de ofertas low ticket (até R$ 50: ebooks, \
apostilas, cursos curtos, kits digitais, moldes, planners, receitas, packs, artes para \
imprimir, produtos físicos baratos) na Biblioteca de Anúncios do Facebook.

A busca da Biblioteca casa com o TEXTO do anúncio. Sua tarefa: transformar a ideia do \
usuário em termos de busca que um anunciante desse tipo de oferta escreveria na copy.

Hoje é {hoje}. Próximas datas comerciais ({mercado}), da mais próxima à mais distante:
{datas}

Ideia do usuário: "{ideia}"
Idioma dos anúncios: {idioma}

Como pensar:
1. Interprete a ideia. Se ela for ABSTRATA ou um conceito de mercado (ex.: "sazonalidade", \
"produtos sazonais", "datas comemorativas", "presentes", "tendências", "o que vender agora", \
"público feminino"), NÃO use a palavra da ideia como termo — destrinche em temas concretos. \
Sazonalidade/sazonal/época = as datas comerciais acima, priorizando as mais próximas.
2. Se a ideia já for concreta (ex.: "natal", "receitas fit", "crochê"), os temas são \
subnichos dela.
3. Gere de 4 a 7 temas. Em cada tema, 4 a 6 termos de 1 a 4 palavras, específicos e \
vendáveis barato (produto + formato: "moldes de enfeites natalinos", "kit festa \
dia das crianças", "atividades halloween para imprimir"), incluindo o desejo que a copy \
usa ("renda extra no natal", "lembrancinha barata").
4. Nunca: data que já passou neste ano (a menos que a ideia peça), termo genérico \
sozinho ("produtos", "sazonal", "presentes"), marca, hashtag, termo repetido com \
variação mínima.

Em "interpretacao", diga em uma frase como você entendeu a ideia."""


def _prompt(ideia: str, idioma: str, hoje: date | None = None) -> str:
    hoje = hoje or date.today()
    es = idioma == "es"
    datas = "\n".join(f"- {d.day:02d}/{d.month:02d}: {nome}"
                      for d, nome, _ in proximas_datas(hoje, "es" if es else "pt", dias=200))
    return INSTRUCOES.format(
        hoje=f"{hoje.day} de {MESES[hoje.month - 1]} de {hoje.year}",
        mercado="América Latina hispânica" if es else "Brasil",
        datas=datas or "- (nenhuma nos próximos meses)",
        ideia=ideia.replace('"', "'"),
        idioma={"es": "espanhol", "en": "inglês"}.get(idioma, "português do Brasil"))


def _resposta(texto: str) -> dict:
    j = json.loads(texto)
    grupos = _grupos_limpos(j.get("temas") or [])
    if not grupos:
        raise ValueError("resposta sem temas")
    return {"termos": _intercalar(grupos), "grupos": grupos,
            "interpretacao": str(j.get("interpretacao") or "")[:300]}


# ---- Gemini

GEMINI_API = "https://generativelanguage.googleapis.com/v1beta"
_modelos_gemini: list[str] = []


def _versao(nome: str) -> tuple:
    return tuple(int(n) for n in re.findall(r"\d+", nome.split("gemini-")[-1])[:2])


def modelos_gemini() -> list[str]:
    """O Google aposenta modelo por nome (gemini-2.5-flash já deu 404) e o
    plano gratuito devolve 503 quando um modelo está cheio. Então pergunta à API
    o que existe e monta uma fila: Flash mais novo primeiro, Flash-Lite como
    reserva. GEMINI_MODELO no ambiente força um."""
    global _modelos_gemini
    if os.getenv("GEMINI_MODELO"):
        return [os.environ["GEMINI_MODELO"]]
    if _modelos_gemini:
        return _modelos_gemini
    import requests

    r = requests.get(f"{GEMINI_API}/models", params={"pageSize": 1000},
                     headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]}, timeout=15)
    r.raise_for_status()
    nomes = [m["name"].split("/", 1)[-1] for m in r.json().get("models", [])
             if "generateContent" in m.get("supportedGenerationMethods", [])]
    ruins = ("image", "tts", "audio", "live", "thinking", "exp", "8b", "embedding")
    estaveis = [n for n in nomes if "flash" in n and not any(x in n for x in ruins)
                and "preview" not in n]
    flash = sorted((n for n in estaveis if "lite" not in n), key=_versao, reverse=True)
    lite = sorted((n for n in estaveis if "lite" in n), key=_versao, reverse=True)
    fila = []
    for n in (["gemini-flash-latest"] if "gemini-flash-latest" in nomes else []) + flash[:2] \
            + (["gemini-flash-lite-latest"] if "gemini-flash-lite-latest" in nomes else []) \
            + lite[:1]:
        if n not in fila:
            fila.append(n)
    if not fila:
        raise RuntimeError("nenhum modelo flash disponível para esta chave")
    _modelos_gemini = fila
    return fila


def _gemini_uma_vez(modelo: str, prompt: str, timeout: float) -> dict:
    import requests

    r = requests.post(
        f"{GEMINI_API}/models/{modelo}:generateContent",
        headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"],
                 "Content-Type": "application/json"},
        json={
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "OBJECT", "required": ["interpretacao", "temas"],
                    "properties": {
                        "interpretacao": {"type": "STRING"},
                        "temas": {"type": "ARRAY", "items": {
                            "type": "OBJECT", "required": ["tema", "termos"],
                            "properties": {"tema": {"type": "STRING"},
                                           "termos": {"type": "ARRAY",
                                                      "items": {"type": "STRING"}}}}},
                    }},
                "temperature": 0.7,
            },
        },
        timeout=timeout,
    )
    if r.status_code == 404:
        # modelo aposentado no meio do caminho: redescobre na próxima chamada
        global _modelos_gemini
        _modelos_gemini = []
    r.raise_for_status()
    partes = r.json()["candidates"][0]["content"]["parts"]
    return _resposta("".join(p.get("text", "") for p in partes))


def gerar_gemini(ideia: str, idioma: str) -> dict:
    """Tenta cada modelo da fila. O teto total fica abaixo dos 60s da Vercel."""
    prompt = _prompt(ideia, idioma)
    fim = time.monotonic() + 48
    ultimo = None
    for modelo in modelos_gemini():
        resta = fim - time.monotonic()
        if resta < 8:
            break
        try:
            return _gemini_uma_vez(modelo, prompt, timeout=min(22, resta))
        except Exception as e:      # 503 cheio, 429 cota, timeout: próximo modelo
            ultimo = e
            print(f"ideias: Gemini {modelo} falhou:", str(e)[:160])
    raise ultimo or RuntimeError("sem tempo para o Gemini")


# ---- Claude

def gerar_claude(ideia: str, idioma: str) -> dict:
    import anthropic

    client = anthropic.Anthropic(timeout=40, max_retries=1)
    resposta = client.beta.messages.create(
        model="claude-opus-5-5",
        max_tokens=4000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "low",
                       "format": {"type": "json_schema", "schema": ESQUEMA}},
        messages=[{"role": "user", "content": _prompt(ideia, idioma)}],
    )
    if resposta.stop_reason == "refusal":
        raise RuntimeError("pedido recusado")
    return _resposta(next((b.text for b in resposta.content if b.type == "text"), ""))


def gerar(ideia: str, idioma: str = "pt") -> dict:
    ideia = (ideia or "").strip()[:200]
    if not ideia:
        return {"termos": [], "grupos": [], "fonte": ""}
    for chave, fn in (("GEMINI_API_KEY", gerar_gemini), ("ANTHROPIC_API_KEY", gerar_claude)):
        if os.getenv(chave):
            try:
                return {**fn(ideia, idioma), "fonte": "ia"}
            except Exception as e:
                print(f"ideias: {fn.__name__} falhou:", str(e)[:200])
    return {**gerar_local(ideia, idioma), "fonte": "regras"}
