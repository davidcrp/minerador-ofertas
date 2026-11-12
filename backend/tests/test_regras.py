"""Regras puras do minerador — sem banco e sem rede.

    cd minerador/backend && python -m unittest discover tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://teste:teste@127.0.0.1:1/teste")

import app  # noqa: E402
import db  # noqa: E402
import enrich  # noqa: E402
import gateways as g  # noqa: E402
import lowticket as lt  # noqa: E402


class Gateways(unittest.TestCase):
    def test_dominio_nao_casa_pedaco(self):
        self.assertFalse(g.e_gateway("https://kobold.com/x"))
        self.assertTrue(g.e_gateway("https://pay.kiwify.com.br/abc"))

    def test_detecta_por_redirect_e_por_link(self):
        self.assertEqual(g.detectar(["https://pay.kiwify.com.br/abc"], "")[0], "Kiwify")
        html = '<a href="https://pay.hotmart.com/X123">comprar</a>'
        self.assertEqual(g.detectar(["https://site.com"], html)[0], "Hotmart")


class Preco(unittest.TestCase):
    def test_dado_estruturado_ganha_do_texto(self):
        html = ('<script type="application/ld+json">{"@type":"Product","offers":'
                '{"price":"19.90","priceCurrency":"BRL"}}</script> R$ 197,00 R$ 197,00')
        self.assertEqual(g.preco_estruturado(html, "https://x.com.br"),
                         ("R$ 19,90", 19.9, "BRL"))

    def test_meta_de_preco(self):
        html = ('<meta property="product:price:amount" content="27.00">'
                '<meta property="product:price:currency" content="BRL">')
        self.assertEqual(g.preco_estruturado(html), ("R$ 27,00", 27.0, "BRL"))

    def test_texto_formatado_volta_a_numero(self):
        self.assertEqual(g.valor_e_moeda("R$ 19,90"), (19.9, "BRL"))
        self.assertEqual(g.valor_e_moeda("MXN 199.00", "MXN"), (199.0, "MXN"))

    def test_parcela_nao_e_preco(self):
        self.assertEqual(g.preco_da_copy("12x de R$ 9,70 ou R$ 97 à vista")[1], 97.0)

    def test_copy(self):
        self.assertEqual(g.preco_da_copy("Kit de moldes por apenas R$ 19,90!")[1], 19.9)
        self.assertEqual(g.preco_da_copy("De R$ 97 por R$ 27 só hoje")[1], 27.0)
        self.assertEqual(g.preco_da_copy("Kit digital por solo $99", "MX")[1:], (99.0, "MXN"))
        self.assertEqual(g.preco_da_copy("Aprenda crochê do zero")[1], 0.0)

    def test_promessa_de_ganho_nao_e_preco(self):
        self.assertEqual(g.preco_da_copy("Fature R$ 300 por dia vendendo doces")[1], 0.0)
        self.assertEqual(g.preco_da_copy("Ganhe até R$ 5.000 em casa. Método por R$ 37")[1], 37.0)


class LowTicket(unittest.TestCase):
    base = {"url_final": "https://site.com", "checkout_url": "https://pay.kiwify.com.br/a",
            "gateway": "Kiwify"}

    def low(self, valor, moeda):
        return lt.destino_e_low({**self.base, "preco_valor": valor, "preco_moeda": moeda})

    def test_real(self):
        self.assertTrue(self.low(27, "BRL"))
        self.assertFalse(self.low(97, "BRL"))
        self.assertFalse(self.low(None, ""))

    def test_moeda_hispanica_tem_cotacao(self):
        self.assertTrue(self.low(99, "MXN"))
        self.assertTrue(self.low(9000, "ARS"))
        self.assertFalse(self.low(250000, "COP"))

    def test_toda_moeda_reconhecida_tem_cotacao(self):
        # moeda sem cotação vale 0 e reprova tudo daquele mercado em silêncio
        for moeda in g.FAIXA_MOEDA:
            self.assertGreater(lt.COTACAO_BRL.get(moeda, 0), 0, moeda)


class Bloqueio(unittest.TestCase):
    def test_403_e_desafio_nao_sao_pagina_lida(self):
        self.assertTrue(enrich.bloqueado(403, "<html>Forbidden</html>"))
        self.assertTrue(enrich.bloqueado(200, "<title>Just a moment...</title>"))
        self.assertFalse(enrich.bloqueado(200, "<html>" + "oferta " * 5000 + "</html>"))
        self.assertFalse(enrich.bloqueado(200, "<h1>Kit de moldes</h1>"))


class Oferta(unittest.TestCase):
    def test_chave_e_o_checkout_nao_a_pagina(self):
        a = app.chave_oferta("https://pay.kiwify.com.br/AbC123?utm=1", "https://lp1.com", "lp1.com")
        b = app.chave_oferta("https://pay.kiwify.com.br/AbC123/", "https://lp2.com", "lp2.com")
        self.assertEqual(a, b)
        self.assertNotEqual(a, app.chave_oferta("https://pay.kiwify.com.br/Outro", "", ""))

    def test_sem_checkout_usa_o_dominio(self):
        self.assertEqual(app.chave_oferta("", "https://www.loja.com/p/1", "loja.com"), "d:loja.com")
        self.assertEqual(app.chave_oferta("", "https://instagram.com/x", "instagram.com"), "")

    def oferta(self, **extra):
        o = dict(dias_rodando=90, dias_novo=90, anuncios_coletados=1, preco_brl=0,
                 checkout_url="", tipo_gateway="", anuncios_ativos=4, rede_ativos=4,
                 ativos_antes=0, visto_ha=0)
        o.update(extra)
        return app.pontuar(o)

    def test_tempo_tem_teto(self):
        self.assertEqual(self.oferta(dias_rodando=700)["score"],
                         self.oferta(dias_rodando=180)["score"])

    def test_rede_soma_na_escala(self):
        self.assertGreater(self.oferta(rede_ativos=20)["score"], self.oferta()["score"])

    def test_crescendo(self):
        self.assertTrue(self.oferta(anuncios_ativos=12, ativos_antes=4)["crescendo"])
        self.assertFalse(self.oferta(anuncios_ativos=5, ativos_antes=4)["crescendo"])

    def test_sumida_perde_score(self):
        viva, sumida = self.oferta(), self.oferta(visto_ha=40)
        self.assertTrue(sumida["sumida"])
        self.assertLess(sumida["score"], viva["score"])


class Senha(unittest.TestCase):
    def test_hash_novo_e_antigo(self):
        import hashlib
        novo = db.hash_senha("segredo")
        self.assertFalse(db.senha_antiga(novo))
        self.assertTrue(db.confere_senha("segredo", novo))
        self.assertFalse(db.confere_senha("errada", novo))
        antigo = "sal:" + hashlib.sha256(b"segredosal").hexdigest()
        self.assertTrue(db.senha_antiga(antigo))
        self.assertTrue(db.confere_senha("segredo", antigo))


if __name__ == "__main__":
    unittest.main()
