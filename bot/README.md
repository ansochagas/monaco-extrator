# Bot de Captura e Envio WhatsApp

Este modulo tem 2 etapas:

1. Capturar o relatorio de `Coletas` e salvar por area.
2. Ler os textos gerados e enviar no WhatsApp Web.

## 1) Preparacao

1. Copie `bot/.env.example` para `bot/.env`.
2. Preencha `MONACO_USER` e `MONACO_PASSWORD`.
3. Instale dependencias:

```bash
npm install
```

4. Instale o navegador do Playwright (uma vez):

```bash
npm run bot:wa:install-browser
```

## 2) Captura do relatorio

Capturar todas as areas na data de hoje:

```bash
npm run bot:capture
```

Capturar por area:

```bash
npm run bot:capture -- --date 2026-02-25 --area "03 JAGUARUANA CE"
```

Capturar por id:

```bash
npm run bot:capture -- --date 2026-02-25 --area-id 8
```

## 3) Arquivos de saida da captura

Em `bot/output/YYYY-MM-DD`:

- `NOME_DA_AREA__id_X.txt` (mensagem pronta para WhatsApp)
- `NOME_DA_AREA__id_X.json` (dados estruturados)
- `_resumo_execucao.json` (resumo da captura)

Campos extraidos:

- `Data`
- `Vendedor`
- `Coletor`
- `Tipo`
- `Valor`
- `TOTAL`

## 4) Configurar mapeamento de grupos

Arquivo:

- `bot/config/area-whatsapp-groups.json`

Formato:

```json
{
  "groups": [
    {
      "areaName": "03 JAGUARUANA CE",
      "groupName": "GRUPO - 03 JAGUARUANA CE",
      "enabled": true
    }
  ]
}
```

Voce pode usar `bot/config/area-whatsapp-groups.example.json` como modelo.

## 5) Bootstrap da sessao WhatsApp

Rode uma vez para logar a conta do bot no WhatsApp Web:

```bash
npm run bot:wa:bootstrap
```

Depois de escanear o QR, a sessao fica salva em `bot/.session/whatsapp`.

## 6) Preview antes do envio

Gera validacao sem enviar mensagem:

```bash
npm run bot:wa:send -- --date 2026-02-25
```

Saida:

- `bot/output/YYYY-MM-DD/_whatsapp_preview.json`

## 7) Envio real

Envia mensagens de fato:

```bash
npm run bot:wa:execute -- --date 2026-02-25
```

Saida:

- `bot/output/YYYY-MM-DD/_whatsapp_execute_result.json`
- `bot/output/YYYY-MM-DD/_whatsapp_screenshots/` (somente quando falha)
