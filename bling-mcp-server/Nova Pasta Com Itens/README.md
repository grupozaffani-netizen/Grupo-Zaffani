# Bling MCP Server (somente leitura)

Servidor pequeno que conecta o Claude ao seu Bling, para consultar
produtos, estoque e pedidos de venda. Só faz leitura — não altera nada
no Bling.

Guia completo de instalação abaixo. Se estiver seguindo passo a passo
com o Claude, pode ignorar isso e seguir as instruções da conversa —
este arquivo é só para referência/consulta.

## 1. Suba este código para um repositório no GitHub

1. Crie uma conta gratuita em https://github.com (se ainda não tiver).
2. Clique em "New repository", dê um nome (ex: `bling-mcp-czstore`),
   marque como **privado** e clique em "Create repository".
3. Na página do repositório vazio, clique em "uploading an existing
   file" e arraste todos os arquivos desta pasta (menos a pasta
   `node_modules`, que não precisa subir).
4. Clique em "Commit changes".

## 2. Hospede no Render (gratuito)

1. Crie uma conta em https://render.com (pode entrar com o GitHub).
2. Clique em "New" → "Web Service".
3. Conecte o repositório que você criou no passo 1.
4. Configurações:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Ainda não clique em "Deploy" — antes, vá para a aba "Environment" e
   adicione as variáveis abaixo (os valores de `BLING_CLIENT_ID` e
   `BLING_CLIENT_SECRET` vêm do passo 3, você pode voltar aqui depois):
   - `BLING_CLIENT_ID`
   - `BLING_CLIENT_SECRET`
   - `BLING_REDIRECT_URI` → vai ser `https://SEU-APP.onrender.com/oauth/callback`
     (o Render mostra o endereço `SEU-APP.onrender.com` assim que você cria o serviço)
6. Clique em "Deploy". Em alguns minutos você terá uma URL pública tipo
   `https://bling-mcp-czstore.onrender.com`.

> Nota: no plano gratuito do Render, o servidor "dorme" depois de 15
> minutos sem uso e demora ~30-60s para acordar na próxima chamada.
> Para este uso (consultas via Claude, não em tempo real o dia todo)
> isso é tranquilo.

## 3. Crie o aplicativo no Bling

1. Acesse https://developer.bling.com.br/aplicativos e crie um app novo
   (visibilidade **privado**).
2. Em "Redirect URL", cole `https://SEU-APP.onrender.com/oauth/callback`
   (a URL real do passo 2).
3. Marque os escopos (módulos): **Produtos**, **Controle de Estoque** e
   **Pedidos de Venda** — escolha a opção de leitura quando o Bling
   oferecer nível de permissão por módulo.
4. Salve e copie o **Client ID** e o **Client Secret** gerados.
5. Volte no Render (aba Environment) e cole esses dois valores em
   `BLING_CLIENT_ID` e `BLING_CLIENT_SECRET`. Salve — o Render vai
   reiniciar o serviço automaticamente.

## 4. Conecte sua conta Bling

1. Abra `https://SEU-APP.onrender.com` no navegador.
2. Clique em "Conectar ao Bling".
3. Faça login no Bling e autorize o aplicativo.
4. Você deve ver "Conectado! ✅".

## 5. Adicione como conector no Claude

1. No Claude (claude.ai), vá em Configurações → Conectores → Adicionar
   conector personalizado.
2. Nome: `Bling` (ou o que preferir).
3. URL: `https://SEU-APP.onrender.com/mcp`
4. Salve e ative o conector nesta conversa.

## Ferramentas disponíveis

- `listar_produtos` — lista produtos (filtro por nome/código, paginado)
- `consultar_estoque` — saldo de estoque por ID(s) de produto
- `listar_pedidos_vendas` — pedidos de venda por período

## Se algo parar de funcionar

O `refresh_token` do Bling dura cerca de 30 dias. Se a conexão cair
depois de um tempo, basta abrir a URL do servidor de novo e clicar em
"Reconectar ao Bling" — leva 10 segundos.
