# Scripts de manutenção (uso único)

Ficaram da troca de banco (Neon antigo → novo) e da recuperação de capas e
favoritos. Não fazem parte do app: não são importados por ele e não sobem no
deploy (`.vercelignore`). Rode da pasta `backend/` com `DATABASE_URL` definido:

```bash
python manutencao/migrar.py              # confere o que viria do banco antigo
python manutencao/recuperar_capas.py     # guarda og:image viva como capa
python manutencao/repor_favoritos.py     # repõe favoritos remontados
python manutencao/vincular_recuperados.py
```
