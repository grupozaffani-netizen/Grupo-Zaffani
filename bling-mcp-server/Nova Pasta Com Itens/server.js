// Servidor MCP (leitura apenas) para o Bling ERP.
//
// Expõe 3 ferramentas para o Claude consultar o Bling:
//   - listar_produtos
//   - consultar_estoque
//   - listar_pedidos_vendas
//
// E duas rotas de navegador para conectar a conta Bling uma única vez:
//   GET /            -> página de status + botão "Conectar ao Bling"
//   GET /oauth/callback -> recebe o "code" do Bling e finaliza a conexão

import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  isConnected,
  blingGet,
} from "./bling.js";

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------
// Página inicial: status da conexão + botão de conectar
// ---------------------------------------------------------------------
let lastState = null;

app.get("/", (_req, res) => {
  const connected = isConnected();
  lastState = crypto.randomBytes(16).toString("hex");
  const authorizeUrl = buildAuthorizeUrl(lastState);
  res.send(`<!doctype html>
<html lang="pt-br">
<head><meta charset="utf-8"><title>Bling MCP Server</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px;">
  <h1>Servidor Bling ↔ Claude</h1>
  <p>Status da conexão com o Bling:
    <strong style="color:${connected ? "green" : "crimson"}">
      ${connected ? "conectado" : "não conectado"}
    </strong>
  </p>
  <p><a href="${authorizeUrl}" style="display:inline-block; padding:10px 16px; background:#2563eb; color:#fff; border-radius:6px; text-decoration:none;">
    ${connected ? "Reconectar ao Bling" : "Conectar ao Bling"}
  </a></p>
  <p style="color:#666; font-size:14px;">O endereço MCP para colar no Claude é: <code>${_req.protocol}://${_req.get("host")}/mcp</code></p>
</body>
</html>`);
});

app.get("/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`Bling recusou a autorização: ${error}`);
  }
  if (!code) {
    return res.status(400).send("Faltou o parâmetro 'code' na resposta do Bling.");
  }
  if (!state || state !== lastState) {
    return res
      .status(400)
      .send("State inválido ou expirado — volte para a página inicial e clique em Conectar de novo.");
  }
  try {
    await exchangeCodeForTokens(String(code));
    res.send(`<!doctype html><html><body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto;">
      <h1>Conectado! ✅</h1>
      <p>Sua conta Bling foi conectada com sucesso. Pode fechar esta aba e voltar para o Claude.</p>
      <p><a href="/">Voltar</a></p>
    </body></html>`);
  } catch (err) {
    console.error("[oauth/callback] erro:", err);
    res.status(500).send(`Falha ao trocar o código por token: ${err.message}`);
  }
});

// Verificação simples de saúde (útil para o Render não derrubar a instância)
app.get("/health", (_req, res) => res.json({ ok: true, connected: isConnected() }));

// ---------------------------------------------------------------------
// Ferramentas MCP (somente leitura)
// ---------------------------------------------------------------------
function createMcpServer() {
  const server = new McpServer({ name: "bling-erp", version: "0.1.0" });

  server.registerTool(
    "listar_produtos",
    {
      title: "Listar produtos do Bling",
      description:
        "Lista produtos cadastrados no Bling, com paginação. Use 'nome' ou 'codigo' para filtrar por texto.",
      inputSchema: {
        pagina: z.number().int().min(1).default(1).describe("Número da página (padrão 1)"),
        limite: z.number().int().min(1).max(100).default(100).describe("Itens por página (máx 100)"),
        nome: z.string().optional().describe("Filtrar por nome do produto (texto parcial)"),
        codigo: z.string().optional().describe("Filtrar por código/SKU exato"),
      },
    },
    async ({ pagina, limite, nome, codigo }) => {
      const data = await blingGet("/produtos", { pagina, limite, nome, codigo });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "consultar_estoque",
    {
      title: "Consultar saldo de estoque no Bling",
      description:
        "Consulta o saldo físico e virtual de estoque de um ou mais produtos, por ID(s) de produto do Bling.",
      inputSchema: {
        idsProdutos: z
          .array(z.number().int())
          .min(1)
          .describe("Lista de IDs de produto do Bling (obtidos via listar_produtos)"),
      },
    },
    async ({ idsProdutos }) => {
      const data = await blingGet("/estoques/saldos", {
        idsProdutos: idsProdutos.join(","),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "listar_pedidos_vendas",
    {
      title: "Listar pedidos de venda do Bling",
      description:
        "Lista pedidos de venda dentro de um período (formato AAAA-MM-DD), com paginação.",
      inputSchema: {
        dataInicial: z.string().optional().describe("Data inicial AAAA-MM-DD"),
        dataFinal: z.string().optional().describe("Data final AAAA-MM-DD"),
        pagina: z.number().int().min(1).default(1),
        limite: z.number().int().min(1).max(100).default(100),
      },
    },
    async ({ dataInicial, dataFinal, pagina, limite }) => {
      const data = await blingGet("/pedidos/vendas", {
        dataInicial,
        dataFinal,
        pagina,
        limite,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------
// Transporte MCP via HTTP (stateless: uma instância de server/transport
// por requisição, mais simples de rodar em hospedagens com múltiplas
// instâncias/sem afinidade de sessão, como o plano free do Render).
// ---------------------------------------------------------------------
app.post("/mcp", async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // modo stateless
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[/mcp] erro:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: err.message },
        id: null,
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Bling MCP server rodando na porta ${PORT}`);
});
