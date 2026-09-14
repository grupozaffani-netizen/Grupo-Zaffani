// Cliente OAuth2 + REST para a API v3 do Bling.
//
// Endpoints confirmados na documentação oficial do Bling
// (developer.bling.com.br):
//   - Autorização: https://www.bling.com.br/Api/v3/oauth/authorize
//   - Token:       https://www.bling.com.br/Api/v3/oauth/token   (POST, Basic Auth client_id:client_secret)
//   - API:         https://api.bling.com.br/Api/v3/...           (Bearer token)
//
// Alguns nomes exatos de parâmetro de consulta (ex: em /produtos,
// /estoques/saldos, /pedidos/vendas) foram confirmados por uma biblioteca
// de terceiros bem mantida, não diretamente no texto da doc oficial (que
// é uma SPA difícil de raspar) — por isso o server valida a resposta e
// devolve erros claros em vez de mascarar problemas, para ajustarmos
// rapidamente se algum nome de campo estiver diferente na prática.

import { loadTokens, saveTokens } from "./tokenStore.js";

const AUTH_BASE = "https://www.bling.com.br/Api/v3/oauth";
const API_BASE = "https://api.bling.com.br/Api/v3";

const CLIENT_ID = process.env.BLING_CLIENT_ID;
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const REDIRECT_URI = process.env.BLING_REDIRECT_URI; // ex: https://SEU-APP.onrender.com/oauth/callback

function assertConfigured() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    throw new Error(
      "Faltam variáveis de ambiente: BLING_CLIENT_ID, BLING_CLIENT_SECRET, BLING_REDIRECT_URI"
    );
  }
}

export function buildAuthorizeUrl(state) {
  assertConfigured();
  const url = new URL(`${AUTH_BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", state);
  return url.toString();
}

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
}

async function requestToken(bodyParams) {
  assertConfigured();
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "enable-jwt": "1", // Bling está migrando para tokens JWT; pedimos explicitamente.
    },
    body: new URLSearchParams(bodyParams).toString(),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Bling /oauth/token respondeu algo não-JSON (status ${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    throw new Error(`Bling /oauth/token falhou (status ${res.status}): ${JSON.stringify(data)}`);
  }
  if (!data.access_token) {
    throw new Error(`Bling /oauth/token não devolveu access_token: ${JSON.stringify(data)}`);
  }
  return data;
}

// Troca o "code" recebido no /oauth/callback pelos tokens iniciais.
export async function exchangeCodeForTokens(code) {
  const data = await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  persist(data);
  return data;
}

function persist(data) {
  const expiresInSec = Number(data.expires_in) || 3600; // fallback conservador se a API não informar
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token, // pode vir igual ou rotacionado — sempre salvamos o mais recente
    expires_at: Date.now() + expiresInSec * 1000 - 30_000, // 30s de folga
  });
}

let refreshInFlight = null;

async function refreshAccessToken(refreshToken) {
  // Evita duas renovações simultâneas (duas chamadas MCP ao mesmo tempo).
  if (!refreshInFlight) {
    refreshInFlight = requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })
      .then((data) => {
        persist(data);
        return data;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

// Garante um access_token válido, renovando via refresh_token se preciso.
export async function getValidAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error(
      "Nenhuma conta Bling conectada ainda. Abra a URL do servidor no navegador e clique em 'Conectar ao Bling'."
    );
  }

  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at) {
    return tokens.access_token;
  }

  const fresh = await refreshAccessToken(tokens.refresh_token);
  return fresh.access_token;
}

export function isConnected() {
  const tokens = loadTokens();
  return Boolean(tokens && tokens.refresh_token);
}

// Chamada genérica autenticada à API do Bling, com uma tentativa de
// renovação de token em caso de 401 (token expirado no meio do caminho).
export async function blingGet(path, searchParams = {}) {
  const token = await getValidAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const doFetch = async (accessToken) =>
    fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    // Token pode ter expirado antes do previsto — força renovação e tenta 1x mais.
    const tokens = loadTokens();
    const fresh = await refreshAccessToken(tokens.refresh_token);
    res = await doFetch(fresh.access_token);
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Bling ${path} respondeu algo não-JSON (status ${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || JSON.stringify(data);
    throw new Error(`Bling ${path} falhou (status ${res.status}): ${msg}`);
  }
  return data;
}
