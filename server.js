// Servidor MCP (leitura apenas) para o Bling ERP.
//
// Expõe estas ferramentas para o Claude consultar o Bling:
//   - listar_produtos
//   - consultar_estoque
//   - listar_pedidos_vendas   (pode filtrar por idContato, pra ver o histórico de um cliente)
//   - resumo_vendas_periodo   (agrega vendas por produto num período, com margem e estoque)
//   - listar_lojas
//   - consultar_contato       (dados cadastrais + endereço/cidade de um cliente, por idContato)
//   - resumo_contas_pagar     (contas a pagar vencidas, de hoje e a vencer, com totais)
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
import { resumoVendasPeriodo } from "./salesSummary.js";
import { resumoContasPagar } from "./contasPagar.js";
import { initTokenStore } from "./tokenStore.js";

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
  <p style="color:#666; font-size:14px;">O endereço MCP para colar no Claude é: <code>${_req.protocol}://${_req.get("host")}${process.env.MCP_SEGREDO ? "/mcp/(seu segredo)" : "/mcp"}</code></p>
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
        "Lista pedidos de venda dentro de um período (formato AAAA-MM-DD), com paginação. Informe idContato pra ver só os pedidos de um cliente específico (útil pra checar se ele já comprou antes — combine com um período bem largo, tipo dataInicial='2015-01-01', e olhe o total de páginas/pedidos retornados).",
      inputSchema: {
        dataInicial: z.string().optional().describe("Data inicial AAAA-MM-DD"),
        dataFinal: z.string().optional().describe("Data final AAAA-MM-DD"),
        idContato: z
          .number()
          .int()
          .optional()
          .describe(
            "Se informado, considera só pedidos desse cliente (contato.id retornado nos pedidos, ou pela ferramenta consultar_contato). Use com um período largo pra ver o histórico completo do cliente."
          ),
        pagina: z.number().int().min(1).default(1),
        limite: z.number().int().min(1).max(100).default(100),
      },
    },
    async ({ dataInicial, dataFinal, idContato, pagina, limite }) => {
      const data = await blingGet("/pedidos/vendas", {
        dataInicial,
        dataFinal,
        idContato,
        pagina,
        limite,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "resumo_vendas_periodo",
    {
      title: "Resumo de vendas por produto num período",
      description:
        "Analisa todos os pedidos de venda de um período (ex: um fim de semana de bazar, ou o dia de uma live) e devolve, por produto: quantidade vendida, receita, preço médio, custo, margem e estoque atual. Pode filtrar por loja/canal (idLoja) — use listar_lojas pra descobrir o ID. Pode demorar um pouco mais que as outras ferramentas porque busca item a item dos pedidos.",
      inputSchema: {
        dataInicial: z.string().describe("Data inicial AAAA-MM-DD"),
        dataFinal: z.string().describe("Data final AAAA-MM-DD"),
        maxPedidos: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(300)
          .describe("Limite de pedidos a analisar (proteção contra períodos muito longos)"),
        idLoja: z
          .number()
          .int()
          .optional()
          .describe(
            "Se informado, considera só pedidos dessa loja/canal do Bling (ex: pra isolar vendas de um canal específico como o site). Descubra o ID com a ferramenta listar_lojas."
          ),
      },
    },
    async ({ dataInicial, dataFinal, maxPedidos, idLoja }) => {
      const data = await resumoVendasPeriodo({ dataInicial, dataFinal, maxPedidos, idLoja });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "listar_lojas",
    {
      title: "Listar lojas/canais cadastrados no Bling",
      description:
        "Lista as lojas/canais de venda cadastrados na conta Bling (ex: site, marketplaces), com id e nome. Use o id retornado no parâmetro idLoja de resumo_vendas_periodo pra filtrar vendas por canal.",
      inputSchema: {},
    },
    async () => {
      const data = await blingGet("/lojas");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "consultar_contato",
    {
      title: "Consultar dados de um cliente/contato no Bling",
      description:
        "Busca o cadastro completo de um cliente/contato do Bling por ID (inclui endereço, cidade e UF quando cadastrados). O ID vem no campo contato.id dos pedidos retornados por listar_pedidos_vendas ou resumo_vendas_periodo.",
      inputSchema: {
        idContato: z.number().int().describe("ID do contato no Bling (contato.id de um pedido)"),
      },
    },
    async ({ idContato }) => {
      const data = await blingGet(`/contatos/${idContato}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "buscar_pedidos_cliente",
    {
      title: "Buscar pedidos de uma cliente por CPF ou nome",
      description:
        "Procura a cliente pelo CPF/CNPJ (com ou sem pontuação) ou pelo nome e devolve os pedidos dela dos últimos 12 meses (número do Bling, número da loja, data, total e itens resumidos), do mais recente para o mais antigo. Depois use buscar_pedido_troca com o número do Bling escolhido para pegar endereço e dados completos.",
      inputSchema: {
        cpfOuNome: z.string().describe("CPF/CNPJ ou nome da cliente"),
      },
    },
    async ({ cpfOuNome }) => {
      const termo = String(cpfOuNome || "").trim();
      const doc = termo.replace(/\D/g, "");
      const ehDoc = doc.length === 11 || doc.length === 14;
      const soDig = (s) => String(s || "").replace(/\D/g, "");

      let contatos = [];
      const buscas = ehDoc
        ? [{ numeroDocumento: doc }, { pesquisa: doc }, { pesquisa: termo }]
        : [{ pesquisa: termo }];
      for (const filtro of buscas) {
        try {
          const r = await blingGet("/contatos", { ...filtro, limite: 20 });
          let lista = r?.data || [];
          if (ehDoc) lista = lista.filter((c) => soDig(c.numeroDocumento) === doc);
          if (lista.length) { contatos = lista; break; }
        } catch (e) {
          // tenta a próxima forma de busca
        }
      }
      if (!contatos.length) {
        return { content: [{ type: "text", text: JSON.stringify({ encontrado: false, termo, mensagem: ehDoc ? "Nenhuma cliente com esse CPF/CNPJ no Bling." : "Nenhuma cliente com esse nome no Bling." }) }] };
      }

      const inicio = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const pedidos = [];
      for (const c of contatos.slice(0, 3)) {
        try {
          const r = await blingGet("/pedidos/vendas", { idContato: c.id, dataInicial: inicio, limite: 20 });
          for (const p of r?.data || []) {
            pedidos.push({
              numero: p.numero,
              numeroLoja: p.numeroLoja || null,
              data: p.data,
              total: p.total,
              cliente: c.nome,
              cpfCnpj: c.numeroDocumento || "",
            });
          }
        } catch (e) {}
      }
      pedidos.sort((x, y) => String(y.data).localeCompare(String(x.data)));
      const resultado = {
        encontrado: pedidos.length > 0,
        clientes: contatos.slice(0, 3).map((c) => ({ nome: c.nome, cpfCnpj: c.numeroDocumento || "" })),
        pedidos: pedidos.slice(0, 10),
        mensagem: pedidos.length ? null : "Cliente encontrada, mas sem pedidos nos últimos 12 meses.",
      };
      return { content: [{ type: "text", text: JSON.stringify(resultado) }] };
    }
  );

  server.registerTool(
    "buscar_pedido_troca",
    {
      title: "Buscar pedido para troca (dados da cliente)",
      description:
        "Busca um pedido de venda pelo número do Bling (ex: 4543) ou pelo número da loja/marketplace (ex: 17900102551573) e devolve, num só resultado, os dados do pedido (itens e valores) e da cliente: nome, CPF/CNPJ, telefone, e-mail e o endereço de entrega (ou o do cadastro). Usado pelo painel de trocas para gerar a etiqueta.",
      inputSchema: {
        numero: z.string().describe("Número do pedido no Bling ou número da loja/marketplace"),
      },
    },
    async ({ numero }) => {
      const alvo = String(numero || "").trim();
      const digitos = alvo.replace(/\D/g, "");
      const bate = (p) =>
        String(p.numero) === alvo || String(p.numero) === digitos ||
        String(p.numeroLoja || "") === alvo || String(p.numeroLoja || "").replace(/\D/g, "") === digitos;

      let achado = null;
      const tentativas = [];
      if (digitos && digitos.length <= 9) tentativas.push({ numero: digitos });
      tentativas.push({ "numerosLojas[]": alvo });
      if (digitos && digitos !== alvo) tentativas.push({ "numerosLojas[]": digitos });
      for (const filtro of tentativas) {
        try {
          const r = await blingGet("/pedidos/vendas", { ...filtro, limite: 100 });
          achado = (r?.data || []).find(bate) || null;
          if (achado) break;
        } catch (e) {
          // tenta o próximo filtro
        }
      }
      if (!achado) {
        return { content: [{ type: "text", text: JSON.stringify({ encontrado: false, numero: alvo, mensagem: "Pedido não encontrado. Confira o número (Bling ou da loja)." }) }] };
      }

      const det = (await blingGet(`/pedidos/vendas/${achado.id}`))?.data || {};
      let contato = {};
      const idContato = det?.contato?.id || achado?.contato?.id;
      if (idContato) {
        try { contato = (await blingGet(`/contatos/${idContato}`))?.data || {}; } catch {}
      }
      const et = det?.transporte?.etiqueta || {};
      const geral = contato?.endereco?.geral || {};
      const usarEtiqueta = Boolean(et.cep && (et.endereco || et.logradouro));
      const end = usarEtiqueta
        ? { origem: "entrega do pedido", cep: et.cep, logradouro: et.endereco || et.logradouro, numero: et.numero, complemento: et.complemento, bairro: et.bairro, cidade: et.municipio, uf: et.uf }
        : { origem: "cadastro da cliente", cep: geral.cep, logradouro: geral.endereco, numero: geral.numero, complemento: geral.complemento, bairro: geral.bairro, cidade: geral.municipio, uf: geral.uf };

      const resultado = {
        encontrado: true,
        pedido: {
          id: det.id || achado.id,
          numero: det.numero || achado.numero,
          numeroLoja: det.numeroLoja || achado.numeroLoja || null,
          data: det.data || achado.data,
          total: det.total ?? achado.total,
          itens: (det.itens || []).map((i) => ({ codigo: i.codigo, descricao: i.descricao, quantidade: i.quantidade, valor: i.valor })),
        },
        cliente: {
          nome: et.nome || contato.nome || det?.contato?.nome || achado?.contato?.nome || "",
          cpfCnpj: contato.numeroDocumento || det?.contato?.numeroDocumento || achado?.contato?.numeroDocumento || "",
          telefone: contato.celular || contato.telefone || "",
          email: contato.email || "",
          endereco: end,
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(resultado) }] };
    }
  );

  server.registerTool(
    "resumo_contas_pagar",
    {
      title: "Resumo de contas a pagar (vencidas, hoje e a vencer)",
      description:
        "Lista as contas a pagar em aberto (e parcialmente pagas) do Bling: todas as vencidas e as que vencem até 'diasAFrente' dias. Devolve totais (vencidas, vencem hoje, próximos 7 dias, até 30 dias) e cada conta com vencimento, status (vencida/hoje/a_vencer), dias de atraso, valor em aberto, fornecedor, descrição, documento e categoria. Datas no fuso de São Paulo.",
      inputSchema: {
        diasAFrente: z
          .number()
          .int()
          .min(0)
          .max(120)
          .default(30)
          .describe("Quantos dias à frente incluir nas contas a vencer (padrão 30)"),
        maxDetalhes: z
          .number()
          .int()
          .min(0)
          .max(300)
          .default(120)
          .describe("Quantas contas (das mais urgentes) buscar com descrição/categoria completas"),
      },
    },
    async ({ diasAFrente, maxDetalhes }) => {
      const data = await resumoContasPagar({ diasAFrente, maxDetalhes });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------
// Transporte MCP via HTTP (stateless: uma instância de server/transport
// por requisição, mais simples de rodar em hospedagens com múltiplas
// instâncias/sem afinidade de sessão, como o plano free do Render).
// ---------------------------------------------------------------------
// Se MCP_SEGREDO estiver configurado, o endereço do conector passa a ser
// /mcp/<segredo> (protege os dados de clientes). Sem a variável, continua /mcp.
const MCP_PATH = process.env.MCP_SEGREDO ? `/mcp/${process.env.MCP_SEGREDO}` : "/mcp";

app.post(MCP_PATH, async (req, res) => {
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

await initTokenStore();

app.listen(PORT, () => {
  console.log(`Bling MCP server rodando na porta ${PORT}`);
});
