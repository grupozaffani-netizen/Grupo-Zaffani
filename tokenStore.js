// Persistência do token do Bling.
//
// O Render gratuito apaga os arquivos locais sempre que reinicia a máquina,
// e aí a conexão com o Bling se perdia. Agora, se as variáveis
// UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN estiverem configuradas,
// os tokens também ficam guardados no Upstash (um banco gratuito e
// permanente) e são recarregados automaticamente quando o servidor liga.
// Sem essas variáveis, tudo funciona como antes (arquivo local).

import fs from "node:fs";

const FILE = new URL("./tokens.local.json", import.meta.url);
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const USA_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
// Uma chave por aplicativo do Bling, para CZ e New Man poderem usar o mesmo banco.
const CHAVE =
  process.env.TOKEN_KEY ||
  "bling_tokens_" + String(process.env.BLING_CLIENT_ID || "padrao").trim().slice(0, 12);

let cache = null;

async function upstash(caminho, corpo) {
  const r = await fetch(`${UPSTASH_URL}/${caminho}`, {
    method: corpo === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: corpo,
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Upstash respondeu ${r.status}: ${j.error || ""}`);
  return j.result;
}

// Chamado uma vez quando o servidor liga, antes de aceitar requisições.
export async function initTokenStore() {
  if (!USA_UPSTASH) {
    console.log("[tokenStore] Upstash não configurado: usando só o arquivo local.");
    return;
  }
  try {
    const valor = await upstash(`get/${CHAVE}`);
    if (valor) {
      cache = JSON.parse(valor);
      try { fs.writeFileSync(FILE, valor, "utf8"); } catch {}
      console.log("[tokenStore] Conexão com o Bling recuperada do Upstash.");
    } else {
      console.log("[tokenStore] Upstash ativo, ainda sem conexão salva. Conecte ao Bling uma vez.");
    }
  } catch (err) {
    console.error("[tokenStore] Falha ao ler do Upstash:", err.message);
  }
}

export function loadTokens() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return cache;
  } catch {
    if (process.env.BLING_REFRESH_TOKEN) {
      return { refresh_token: process.env.BLING_REFRESH_TOKEN, access_token: null, expires_at: 0 };
    }
    return null;
  }
}

export function saveTokens(tokens) {
  cache = tokens;
  const texto = JSON.stringify(tokens, null, 2);
  try {
    fs.writeFileSync(FILE, texto, "utf8");
  } catch (err) {
    console.error("[tokenStore] não consegui salvar tokens em disco:", err.message);
  }
  if (USA_UPSTASH) {
    upstash(`set/${CHAVE}`, texto)
      .then(() => console.log("[tokenStore] Conexão salva no Upstash."))
      .catch((err) => console.error("[tokenStore] Falha ao salvar no Upstash:", err.message));
  }
  const masked = tokens.refresh_token
    ? tokens.refresh_token.slice(0, 6) + "…" + tokens.refresh_token.slice(-6)
    : "(nenhum)";
  console.log(`[tokenStore] refresh_token atual: ${masked}`);
}

export function clearTokens() {
  cache = null;
  try { fs.unlinkSync(FILE); } catch {}
  if (USA_UPSTASH) upstash(`del/${CHAVE}`, "").catch(() => {});
}
