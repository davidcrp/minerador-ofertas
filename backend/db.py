"""Banco do minerador (Postgres / Neon).

Uma conexão por request — em serverless não dá para manter pool no processo.
Use sempre a connection string *pooled* do Neon (a que tem `-pooler` no host).
"""

from __future__ import annotations

import hashlib
import os
import secrets

import psycopg
from psycopg.rows import dict_row
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

VARS_URL = ("DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL",
            "DATABASE_POSTGRES_URL", "NEON_DATABASE_URL")


def url_banco() -> str:
    for v in VARS_URL:
        valor = os.getenv(v)
        if valor:
            return valor
    raise RuntimeError(
        "Defina DATABASE_URL com a connection string do Neon "
        "(no Vercel a integração cria essa variável sozinha)."
    )


# O que o libpq entende. Provedor gosta de enfiar parâmetro próprio na URL
# (Supabase manda `supa=base-pooler.x`, Prisma manda `pgbouncer=true`) e a
# conexão morre com "invalid URI query parameter".
PARAMS_LIBPQ = {
    "sslmode", "sslrootcert", "sslcert", "sslkey", "connect_timeout", "options",
    "application_name", "target_session_attrs", "channel_binding", "hostaddr",
    "gssencmode", "keepalives", "keepalives_idle", "passfile", "service",
}


def limpar_url(url: str) -> str:
    partes = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(partes.query, keep_blank_values=True)
             if k in PARAMS_LIBPQ]
    return urlunsplit(partes._replace(query=urlencode(query)))


def get_db() -> psycopg.Connection:
    url = limpar_url(url_banco())
    # prepare_threshold=None: pooler em modo transação (Supabase :6543, pgbouncer)
    # não guarda prepared statement entre comandos e devolveria erro no segundo uso.
    return psycopg.connect(url, row_factory=dict_row, connect_timeout=10,
                           prepare_threshold=None)


def hash_senha(senha: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.sha256((senha + salt).encode()).hexdigest()
    return f"{salt}:{h}"


def confere_senha(senha: str, guardado: str) -> bool:
    try:
        salt, h = guardado.split(":", 1)
        return secrets.compare_digest(
            hashlib.sha256((senha + salt).encode()).hexdigest(), h
        )
    except Exception:
        return False


ESQUEMA = """
CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    plano TEXT DEFAULT 'free',
    usos_restantes INTEGER DEFAULT 10,
    criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pesquisas (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    termo TEXT NOT NULL,
    pais TEXT DEFAULT 'BR',
    min_anuncios INTEGER DEFAULT 1,
    min_dias INTEGER DEFAULT 0,
    total_coletado INTEGER DEFAULT 0,
    criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS anuncios (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    ad_archive_id TEXT NOT NULL,
    page_id TEXT,
    page_name TEXT,
    is_active INTEGER DEFAULT 1,
    start_date BIGINT,
    end_date BIGINT,
    dias_ativo INTEGER DEFAULT 0,
    plataformas TEXT,
    cta_text TEXT,
    link_url TEXT,
    titulo TEXT,
    legenda TEXT,
    texto TEXT,
    midia TEXT,
    midia_url TEXT,
    variacoes INTEGER DEFAULT 1,
    termo TEXT,
    pais TEXT DEFAULT 'BR',
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW(),
    excluido_em TIMESTAMPTZ,
    UNIQUE (user_id, ad_archive_id)
);

CREATE INDEX IF NOT EXISTS idx_anuncios_page ON anuncios(user_id, page_id);
CREATE INDEX IF NOT EXISTS idx_anuncios_termo ON anuncios(user_id, termo);

-- Destinos são compartilhados: a mesma URL só é resolvida uma vez.
CREATE TABLE IF NOT EXISTS destinos (
    url TEXT PRIMARY KEY,
    url_final TEXT,
    dominio TEXT,
    titulo_pagina TEXT,
    imagem TEXT,
    gateway TEXT,
    gateway_evidencia TEXT,
    checkout_url TEXT,
    preco TEXT,
    preco_valor NUMERIC,
    preco_moeda TEXT,
    whatsapp TEXT,
    status TEXT DEFAULT 'pendente',
    erro TEXT,
    tentativas INTEGER DEFAULT 0,
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_destinos_status ON destinos(status);

-- "Melhores": guarda o retrato da oferta, não uma referência. Limpar os
-- resultados apaga anúncios; o que você separou continua de pé.
CREATE TABLE IF NOT EXISTS favoritos (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL,
    page_name TEXT,
    dados JSONB NOT NULL,
    nota TEXT DEFAULT '',
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, page_id)
);

-- Cópia da mídia do anúncio no Blob: a URL da CDN da Meta é assinada e expira.
CREATE TABLE IF NOT EXISTS midias (
    ad_archive_id TEXT PRIMARY KEY,
    tipo TEXT,
    origem TEXT,
    origem_poster TEXT,
    video_url TEXT DEFAULT '',
    poster_url TEXT DEFAULT '',
    bytes BIGINT DEFAULT 0,
    status TEXT DEFAULT 'pendente',
    tentativas INTEGER DEFAULT 0,
    erro TEXT,
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_midias_status ON midias(status);

-- Miniatura da capa guardada no próprio banco. É o plano B de quando o Blob
-- está fora: a URL da CDN da Meta expira em dias e sem cópia permanente todo
-- anúncio antigo vira quadro vazio. WebP de 320px pesa ~5 KB, e o /capa/<id>
-- é servido com cache imutável, então cada capa viaja uma vez por navegador.
CREATE TABLE IF NOT EXISTS capas (
    ad_archive_id TEXT PRIMARY KEY,
    jpeg BYTEA NOT NULL,
    bytes INTEGER DEFAULT 0,
    mime TEXT DEFAULT 'image/jpeg',
    criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS anunciantes (
    page_id TEXT PRIMARY KEY,
    page_name TEXT,
    total_ativos INTEGER,
    escaneado_em TIMESTAMPTZ DEFAULT NOW()
);
"""


# CREATE TABLE IF NOT EXISTS não altera tabela que já existe: colunas novas
# entram aqui e são aplicadas por setup_db.py.
MIGRACOES = """
ALTER TABLE anuncios  ADD COLUMN IF NOT EXISTS midia_url TEXT;
ALTER TABLE anuncios  ADD COLUMN IF NOT EXISTS midia_sd TEXT;
ALTER TABLE anuncios  ADD COLUMN IF NOT EXISTS midia_poster TEXT;
ALTER TABLE destinos  ADD COLUMN IF NOT EXISTS imagem TEXT;
ALTER TABLE destinos  ADD COLUMN IF NOT EXISTS preco_valor NUMERIC;
ALTER TABLE destinos  ADD COLUMN IF NOT EXISTS preco_moeda TEXT;
-- exclusão reversível: o ✕ do painel esconde, o "desfazer" traz de volta
ALTER TABLE anuncios  ADD COLUMN IF NOT EXISTS excluido_em TIMESTAMPTZ;
-- capa comprimida em WebP; as antigas continuam JPEG
ALTER TABLE capas     ADD COLUMN IF NOT EXISTS mime TEXT DEFAULT 'image/jpeg';
"""


def init_db() -> str:
    """Cria o esquema e garante o usuário único. Rode uma vez (setup_db.py)."""
    senha = os.getenv("MINERADOR_ADMIN_SENHA")
    usuario = os.getenv("MINERADOR_ADMIN_USER", "admin")
    conn = get_db()
    with conn:
        conn.execute(ESQUEMA)
        conn.execute(MIGRACOES)
        existe = conn.execute("SELECT COUNT(*) AS c FROM usuarios").fetchone()["c"]
        if existe:
            return f"esquema ok — {existe} usuário(s), nada alterado"
        if not senha:
            raise RuntimeError(
                "MINERADOR_ADMIN_SENHA não definida. Defina antes de criar o usuário."
            )
        conn.execute(
            "INSERT INTO usuarios (username, password_hash, is_admin, plano, usos_restantes)"
            " VALUES (%s, %s, 1, 'admin', 999999)",
            (usuario, hash_senha(senha)),
        )
    conn.close()
    return f"esquema criado — usuário '{usuario}' pronto"


def trocar_senha(usuario: str, senha: str) -> bool:
    conn = get_db()
    with conn:
        r = conn.execute("UPDATE usuarios SET password_hash = %s WHERE username = %s",
                         (hash_senha(senha), usuario))
    conn.close()
    return r.rowcount > 0


def novo_token(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    conn = get_db()
    with conn:
        conn.execute("INSERT INTO tokens (token, user_id) VALUES (%s, %s)", (token, user_id))
        # Mantém no máximo 20 tokens por usuário (um por dispositivo/reinstalação).
        conn.execute("""
            DELETE FROM tokens WHERE user_id = %s AND token NOT IN (
                SELECT token FROM tokens WHERE user_id = %s
                ORDER BY criado_em DESC LIMIT 20)
        """, (user_id, user_id))
    conn.close()
    return token


def user_por_token(token: str) -> dict | None:
    if not token:
        return None
    conn = get_db()
    row = conn.execute(
        "SELECT u.* FROM tokens t JOIN usuarios u ON u.id = t.user_id WHERE t.token = %s",
        (token,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None
