// Agrega vendas por produto num período, cruzando com custo/estoque atual.
//
// A lista de pedidos do Bling (/pedidos/vendas) só traz o cabeçalho de
// cada pedido (sem os itens). Pra saber QUAIS produtos venderam, é
// preciso buscar cada pedido individualmente (/pedidos/vendas/{id}), que
// traz os itens. Isso pode ser bastante chamada pra um fim de semana de
// movimento — por isso paginamos e buscamos em lotes pequenos (respeitando
// o limite de 3 requisições/segundo do Bling) e devolvemos só o resumo
// agregado, não os pedidos crus, pra não estourar o tamanho da resposta.

import { blingGet } from "./bling.js";

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function listAllPedidos(dataInicial, dataFinal, maxPedidos) {
  const pedidos = [];
  let pagina = 1;
  const limite = 100;
  while (pedidos.length < maxPedidos) {
    const resp = await blingGet("/pedidos/vendas", {
      dataInicial,
      dataFinal,
      pagina,
      limite,
    });
    const batch = resp?.data || [];
    pedidos.push(...batch);
    if (batch.length < limite) break; // última página
    pagina += 1;
  }
  return pedidos.slice(0, maxPedidos);
}

// Situações do Bling cujo pedido NÃO deve contar como venda efetiva
// (cancelado). Mantemos a lista curta e explícita — se algo escapar,
// melhor aparecer nos dados brutos do que ser silenciosamente descartado
// por um "adivinhar" nosso.
const SITUACAO_CANCELADO_IDS = new Set([6, 12]); // IDs padrão do Bling p/ "Cancelado" — ver nota no resultado

export async function resumoVendasPeriodo({ dataInicial, dataFinal, maxPedidos = 300 }) {
  const pedidos = await listAllPedidos(dataInicial, dataFinal, maxPedidos);

  const pedidosValidos = pedidos.filter((p) => !SITUACAO_CANCELADO_IDS.has(p?.situacao?.id));
  const pedidosCancelados = pedidos.length - pedidosValidos.length;

  // Busca o detalhe (itens) de cada pedido válido, em paralelo limitado.
  const detalhes = await mapWithConcurrency(pedidosValidos, 3, async (pedido) => {
    try {
      const resp = await blingGet(`/pedidos/vendas/${pedido.id}`);
      return { pedido, itens: resp?.data?.itens || [] };
    } catch (err) {
      return { pedido, itens: [], erro: err.message };
    }
  });

  const erros = detalhes.filter((d) => d.erro).map((d) => ({ pedidoId: d.pedido.id, erro: d.erro }));

  // Agrega por produto (chave = id do produto, com fallback pro código).
  const porProduto = new Map();
  for (const { itens } of detalhes) {
    for (const item of itens) {
      const idProduto = item?.produto?.id ?? item?.codigo ?? item?.descricao;
      if (!idProduto) continue;
      const atual = porProduto.get(idProduto) || {
        idProduto: item?.produto?.id ?? null,
        codigo: item?.codigo ?? null,
        nome: item?.descricao ?? null,
        quantidadeVendida: 0,
        receitaTotal: 0,
        numeroPedidos: 0,
      };
      const qtd = Number(item.quantidade) || 0;
      const valorUnit = Number(item.valor) || 0;
      atual.quantidadeVendida += qtd;
      atual.receitaTotal += qtd * valorUnit;
      atual.numeroPedidos += 1;
      porProduto.set(idProduto, atual);
    }
  }

  const produtosVendidos = Array.from(porProduto.values());

  // Enriquece com custo e estoque atual (1 chamada por produto único).
  // Cada pedido já custou 1 chamada; para não deixar a ferramenta lenta
  // demais num período com muitos produtos distintos, enriquecemos só os
  // mais vendidos (os que mais importam pra "o que destacou" e "o que
  // repor"). Os demais aparecem no resultado sem custo/estoque.
  const MAX_PRODUTOS_ENRIQUECIDOS = 40;
  const comIdProduto = produtosVendidos
    .filter((p) => p.idProduto)
    .sort((a, b) => b.quantidadeVendida - a.quantidadeVendida)
    .slice(0, MAX_PRODUTOS_ENRIQUECIDOS);
  const produtosNaoEnriquecidos = produtosVendidos.filter((p) => p.idProduto).length - comIdProduto.length;

  const infosProduto = await mapWithConcurrency(comIdProduto, 3, async (p) => {
    try {
      const resp = await blingGet(`/produtos/${p.idProduto}`);
      const prod = resp?.data;
      return {
        idProduto: p.idProduto,
        nomeCompleto: prod?.nome,
        codigo: prod?.codigo,
        precoTabela: prod?.preco,
        precoCusto: prod?.precoCusto,
        estoqueAtual: prod?.estoque?.saldoVirtualTotal ?? null,
      };
    } catch (err) {
      return { idProduto: p.idProduto, erro: err.message };
    }
  });
  const errosEnriquecimento = infosProduto
    .filter((i) => i.erro)
    .map((i) => ({ idProduto: i.idProduto, erro: i.erro }));
  const infoPorId = new Map(infosProduto.map((i) => [i.idProduto, i]));

  const resultado = produtosVendidos.map((p) => {
    const info = p.idProduto ? infoPorId.get(p.idProduto) : null;
    const precoMedioVenda = p.quantidadeVendida > 0 ? p.receitaTotal / p.quantidadeVendida : null;
    const precoCusto = info?.precoCusto ?? null;
    const margemUnitaria =
      precoCusto !== null && precoCusto !== undefined && precoMedioVenda !== null
        ? precoMedioVenda - precoCusto
        : null;
    const margemPercentual =
      margemUnitaria !== null && precoMedioVenda > 0 ? (margemUnitaria / precoMedioVenda) * 100 : null;
    return {
      idProduto: p.idProduto,
      codigo: info?.codigo ?? p.codigo,
      nome: info?.nomeCompleto ?? p.nome,
      quantidadeVendida: p.quantidadeVendida,
      numeroPedidos: p.numeroPedidos,
      receitaTotal: Number(p.receitaTotal.toFixed(2)),
      precoMedioVenda: precoMedioVenda !== null ? Number(precoMedioVenda.toFixed(2)) : null,
      precoCusto: precoCusto ?? null,
      margemUnitaria: margemUnitaria !== null ? Number(margemUnitaria.toFixed(2)) : null,
      margemPercentual: margemPercentual !== null ? Number(margemPercentual.toFixed(1)) : null,
      estoqueAtual: info?.estoqueAtual ?? null,
    };
  });

  resultado.sort((a, b) => b.quantidadeVendida - a.quantidadeVendida);

  const todosErros = [...erros, ...errosEnriquecimento];

  return {
    periodo: { dataInicial, dataFinal },
    totalPedidosEncontrados: pedidos.length,
    pedidosCancelados,
    pedidosAnalisados: pedidosValidos.length,
    produtosDistintosVendidos: resultado.length,
    produtosComCustoEEstoque: comIdProduto.length,
    erros: todosErros.length ? todosErros : undefined,
    produtos: resultado,
    nota:
      `Pedidos cancelados foram filtrados por uma lista fixa de IDs de situação comuns do Bling (6=Cancelado, 12=Cancelado por... variações de conta). Se sua conta usa IDs diferentes, pedidos cancelados podem aparecer aqui — verifique 'numeroPedidos' incomuns. ` +
      `Custo e estoque atual foram buscados só para os ${MAX_PRODUTOS_ENRIQUECIDOS} produtos mais vendidos do período (por chamada individual à API), pra ferramenta não ficar lenta demais — os outros ${produtosNaoEnriquecidos} produtos vendidos aparecem sem essas informações (campos null). Peça pra reprocessar um subconjunto se precisar de custo/estoque de mais itens.`,
  };
}
