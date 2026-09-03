# POC — Vendas em Lives do Instagram

Painel local para testar o fluxo: produto ativo → comentário com gatilho → DM simulada → histórico do lead.

## Executar com Docker

```powershell
docker compose up --build
```

Abra http://localhost:3000.

Para encerrar:

```powershell
docker compose down
```

## Executar com Node/NPM

Não há dependências externas nesta POC.

```powershell
npm start
```

## O que está simulado

- O botão **Simular comentário** representa um evento `live_comments` do webhook da Meta.
- A DM é registrada como enviada, sem fazer uma chamada externa.
- Os produtos, leads e histórico ficam em `data/database.json`.

## Caminho para produção

1. Trocar o armazenamento JSON por PostgreSQL.
2. Usar Redis/BullMQ para fila, retentativas e rate limit.
3. Validar `x-hub-signature-256` com `META_APP_SECRET`.
4. Expor `GET/POST /webhook` com HTTPS e configurar a URL no painel da Meta.
5. No worker, enviar a mensagem para `/{ig_user_id}/messages`, com `{ recipient: { comment_id }, message: { text } }`.
