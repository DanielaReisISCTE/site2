# Daniela Reis | Excel, Power BI e Reporting para PME

Site profissional com formulário integrado e envio por HTTPS através da API do Resend.

## Ficheiros desta atualização

1. `server.js`
2. `render.yaml`
3. `package.json`
4. `README.md`
5. `test/server.test.js`

O ficheiro `public/index.html` não é alterado nesta atualização.

## Configuração no Render

1. Criar uma conta no Resend e gerar uma chave de API.
2. No serviço do Render, abrir `Environment`.
3. Criar `RESEND_API_KEY` e colar a chave do Resend apenas no campo privado do Render.
4. Criar `CONTACT_TO` com o endereço que deve receber os pedidos.
5. Remover `GMAIL_USER`.
6. Remover `GMAIL_APP_PASSWORD`.
7. Guardar as alterações e executar uma nova implantação.
8. Abrir `/api/contact/status`. O resultado esperado é `{"active":true}`.
9. Enviar um pedido de teste pelo site e confirmar a receção.

Nunca colocar `RESEND_API_KEY` no código, no GitHub, no HTML ou numa mensagem. O endereço definido em `CONTACT_TO` permanece apenas no ambiente privado do Render.

## Funcionamento

A rota `POST /api/contact` mantém os campos `name`, `email`, `message` e `website`. O campo `website` continua a ser usado como proteção antispam. A validação, os limites de comprimento e o limite de cinco pedidos por endereço IP em cada período de quinze minutos mantêm-se.

O servidor envia um pedido HTTPS para `https://api.resend.com/emails`. O remetente é `onboarding@resend.dev` e o campo de resposta é o email indicado pelo cliente.

## Testes locais

```bash
npm ci
npm test
npm start
```

Os testes usam uma implementação simulada de `fetch`. Não enviam pedidos para o Resend e não enviam emails reais.
