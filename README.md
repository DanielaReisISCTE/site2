# Daniela Reis | Excel, Power BI e Reporting para PME

Site profissional com formulário integrado e envio por Gmail no servidor.

## Publicação no Render

1. Colocar esta pasta num repositório Git privado ou público.
2. No Render, criar um Blueprint a partir do repositório. O ficheiro `render.yaml` configura o serviço.
3. Definir no painel privado do serviço:
   * `GMAIL_USER`: conta Gmail usada pelo servidor para enviar.
   * `GMAIL_APP_PASSWORD`: palavra passe de aplicação da conta Gmail, sem espaços.
   * `CONTACT_TO`: `danielafespal@gmail.com`.
4. Publicar e abrir `/api/contact/status`. O resultado esperado é `{"active":true}`.
5. Enviar um pedido de teste e confirmar a receção no Gmail.

Nunca colocar palavras passe no código, no repositório ou no HTML. A palavra passe de aplicação exige verificação em dois passos na conta Google.

## Testes locais

```bash
npm ci
npm test
npm start
```

Sem as três variáveis privadas, o site abre normalmente, mas o formulário permanece desativado para não simular envios.
