// Resumo de contas a pagar do Bling (somente leitura).
//
// Usa a API v3:
//   GET /contas/pagar                     -> lista (id, situacao, vencimento, valor, contato.id)
//   GET /contas/pagar/{id}                -> detalhe (saldo, historico, numeroDocumento, categoria.id)
//   GET /contatos/{id}                    -> nome do fornecedor
//   GET /categorias/receitas-despesas     -> nome da categoria
//
// Situações do filtro: 1 = Em aberto, 3 = Parcialmente pago.
// O aplicativo do Bling precisa ter o escopo "Contas a pagar" liberado.

import { blingGet } from "./bling.js";

const FUSO = "America/Sao_Paulo";

function hojeSP() {
  return new Date().toLocaleDateString("en-CA", { timeZone: FUSO }); // AAAA-MM-DD
}

function somaDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function diffDias(a, b) {
  // dias entre duas datas AAAA-MM-DD (b - a)
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

const arred = (n) => Math.round((Number(n) || 0) * 100) / 100;

// O Bling recusa filtros de vencimento com período muito longo
// ("Período do filtro é maior que o permitido"). Por isso a busca é
// feita em janelas: começa com ~1 ano por janela e, se o Bling ainda
// reclamar do tamanho, divide a janela pela metade e tenta de novo.
const ERRO_PERIODO = /per[ií]odo do filtro/i;
let tamanhoJanela = 365; // lembra o tamanho que funcionou entre chamadas

async function listarJanela(situacao, inicio, fim, maxPaginas) {
  const itens = [];
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const r = await blingGet("/contas/pagar", {
      situacao,
      dataVencimentoInicial: inicio,
      dataVencimentoFinal: fim,
      pagina,
      limite: 100,
    });
    const lista = r?.data || [];
    itens.push(...lista);
    if (lista.length < 100) break;
  }
  return itens;
}

async function listarTodas(situacao, dataInicio, dataVencimentoFinal, maxPaginas) {
  const todas = [];
  let fim = dataVencimentoFinal;
  while (fim >= dataInicio) {
    let inicio = somaDias(fim, -(tamanhoJanela - 1));
    if (inicio < dataInicio) inicio = dataInicio;
    try {
      todas.push(...(await listarJanela(situacao, inicio, fim, maxPaginas)));
    } catch (err) {
      if (ERRO_PERIODO.test(String(err.message || "")) && tamanhoJanela > 7) {
        tamanhoJanela = Math.max(7, Math.floor(tamanhoJanela / 2));
        continue; // repete a mesma janela, agora menor
      }
      throw err;
    }
    fim = somaDias(inicio, -1);
  }
  return todas;
}

async function mapaCategorias() {
  const mapa = new Map();
  try {
    for (let pagina = 1; pagina <= 5; pagina++) {
      const r = await blingGet("/categorias/receitas-despesas", { pagina, limite: 100 });
      const lista = r?.data || [];
      for (const c of lista) mapa.set(c.id, c.descricao);
      if (lista.length < 100) break;
    }
  } catch (e) {
    // sem permissão de categorias: segue sem nome de categoria
  }
  return mapa;
}

// ---------------------------------------------------------------------
// Caches em memória (somem quando o servidor reinicia, e tudo bem).
// O Bling só aceita ~3 consultas por segundo, então montar o resumo de
// uma conta com centenas de lançamentos leva minutos. Para o painel não
// estourar o tempo limite:
//  - o resultado completo fica guardado por alguns minutos;
//  - duas chamadas iguais ao mesmo tempo compartilham a mesma busca;
//  - nomes de fornecedor e detalhes de cada conta são reaproveitados.
// ---------------------------------------------------------------------
const RESUMO_TTL_MS = 5 * 60 * 1000;
const DETALHE_TTL_MS = 6 * 60 * 60 * 1000;
const cacheNomes = new Map();
const cacheDetalhes = new Map();
const cacheResumo = new Map(); // chave -> { em, promessa }

export async function resumoContasPagar(opcoes = {}) {
  const { diasAFrente = 30, maxDetalhes = 120, anosAtras = 3 } = opcoes;
  const chave = JSON.stringify([hojeSP(), diasAFrente, maxDetalhes, anosAtras]);
  const atual = cacheResumo.get(chave);
  if (atual && Date.now() - atual.em < RESUMO_TTL_MS) return atual.promessa;
  const promessa = montarResumo({ diasAFrente, maxDetalhes, anosAtras });
  cacheResumo.set(chave, { em: Date.now(), promessa });
  promessa.catch(() => cacheResumo.delete(chave)); // erro não fica guardado
  return promessa;
}

async function montarResumo({ diasAFrente = 30, maxDetalhes = 120, anosAtras = 3 } = {}) {
  const hoje = hojeSP();
  const limiteData = somaDias(hoje, diasAFrente);
  // Até onde olhar para trás nas vencidas (contas muito antigas em aberto
  // costumam ser lançamentos esquecidos; aumente anosAtras se precisar).
  const dataInicio = somaDias(hoje, -Math.round(anosAtras * 365));

  let brutas;
  try {
    const [abertas, parciais] = [
      await listarTodas(1, dataInicio, limiteData, 20),
      await listarTodas(3, dataInicio, limiteData, 5),
    ];
    brutas = [...abertas, ...parciais];
  } catch (err) {
    const msg = String(err.message || "");
    if (/status 40[13]/.test(msg)) {
      throw new Error(
        "O Bling recusou o acesso às contas a pagar. Libere o escopo 'Contas a pagar' no aplicativo (developer.bling.com.br) e clique em 'Reconectar ao Bling' na página do servidor. Detalhe: " + msg
      );
    }
    throw err;
  }

  // remove duplicadas (por segurança) e ordena por vencimento
  const porId = new Map();
  for (const c of brutas) porId.set(c.id, c);
  const contas = [...porId.values()].sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)));

  // Detalhes: prioriza as mais urgentes (vencidas e próximas)
  const paraDetalhar = contas.slice(0, maxDetalhes);
  const detalhes = new Map();
  for (const c of paraDetalhar) {
    const guardado = cacheDetalhes.get(c.id);
    if (guardado && Date.now() - guardado.em < DETALHE_TTL_MS) { detalhes.set(c.id, guardado.d); continue; }
    try {
      const d = (await blingGet(`/contas/pagar/${c.id}`))?.data;
      if (d) { detalhes.set(c.id, d); cacheDetalhes.set(c.id, { d, em: Date.now() }); }
    } catch (e) {}
  }

  // Nomes dos fornecedores (um por contato). Ficam guardados na memória do
  // servidor: nome de fornecedor quase nunca muda, e assim só a primeira
  // consulta paga o custo de buscar cada um.
  const nomes = new Map();
  const idsContato = [...new Set(contas.map((c) => c?.contato?.id).filter(Boolean))];
  for (const id of idsContato.slice(0, 150)) {
    if (cacheNomes.has(id)) { nomes.set(id, cacheNomes.get(id)); continue; }
    try {
      const ct = (await blingGet(`/contatos/${id}`))?.data;
      if (ct) { const nome = ct.nome || ct.fantasia || ""; nomes.set(id, nome); cacheNomes.set(id, nome); }
    } catch (e) {}
  }

  const categorias = await mapaCategorias();

  const totais = {
    vencidas: { quantidade: 0, valor: 0 },
    vencemHoje: { quantidade: 0, valor: 0 },
    proximos7dias: { quantidade: 0, valor: 0 },
    ate30dias: { quantidade: 0, valor: 0 },
    totalEmAberto: { quantidade: 0, valor: 0 },
  };

  const lista = contas.map((c) => {
    const d = detalhes.get(c.id) || {};
    const valorAberto = arred(d.saldo != null && Number(d.saldo) > 0 ? d.saldo : c.valor);
    const dias = diffDias(hoje, c.vencimento); // negativo = atrasada
    const status = dias < 0 ? "vencida" : dias === 0 ? "hoje" : "a_vencer";

    const somar = (t) => { t.quantidade++; t.valor = arred(t.valor + valorAberto); };
    somar(totais.totalEmAberto);
    if (status === "vencida") somar(totais.vencidas);
    else if (status === "hoje") somar(totais.vencemHoje);
    else {
      if (dias <= 7) somar(totais.proximos7dias);
      if (dias <= 30) somar(totais.ate30dias);
    }

    const idCat = d?.categoria?.id;
    return {
      id: c.id,
      vencimento: c.vencimento,
      status,
      diasAtraso: dias < 0 ? -dias : 0,
      diasParaVencer: dias > 0 ? dias : 0,
      valor: valorAberto,
      valorOriginal: arred(c.valor),
      parcial: c.situacao === 3,
      fornecedor: nomes.get(c?.contato?.id) || null,
      descricao: d.historico || null,
      documento: d.numeroDocumento || null,
      categoria: idCat ? categorias.get(idCat) || null : null,
    };
  });

  return {
    hoje,
    janela: { desde: dataInicio, ate: limiteData, diasAFrente, anosAtras },
    totais,
    quantidade: lista.length,
    detalhadas: Math.min(lista.length, maxDetalhes),
    contas: lista,
  };
}
