// Persistência simples do token do Bling.
//
// Guarda o refresh_token (e o access_token em cache) num arquivo local.
// Em hospedagens sem disco persistente (ex: Render free) esse arquivo pode
// ser perdido quando a instância reinicia depois de ficar inativa — por
// isso também aceitamos um valor inicial via variável de ambiente
// BLING_REFRESH_TOKEN, e sempre imprimimos o refresh_token mais recente no
// log toda vez que ele é renovado, para você poder colar de novo na
// variável de ambiente se precisar.

import fs from "node:fs";

const FILE = new URL("./tokens.local.json", import.meta.url);

export function loadTokens() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    // Sem arquivo ainda: usa a semente da variável de ambiente, se existir.
    if (process.env.BLING_REFRESH_TOKEN) {
      return {
        refresh_token: process.env.BLING_REFRESH_TOKEN,
        access_token: null,
        expires_at: 0,
      };
    }
    return null;
  }
}

export function saveTokens(tokens) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(tokens, null, 2), "utf8");
  } catch (err) {
    console.error("[tokenStore] não consegui salvar tokens em disco:", err.message);
  }
  // Sempre logamos o refresh_token atual (mascarado) para diagnóstico,
  // e o valor completo só se pedirmos explicitamente via DEBUG_TOKENS=1
  const masked = tokens.refresh_token
    ? tokens.refresh_token.slice(0, 6) + "…" + tokens.refresh_token.slice(-6)
    : "(nenhum)";
  console.log(`[tokenStore] refresh_token atual: ${masked}`);
  if (process.env.DEBUG_TOKENS === "1") {
    console.log(`[tokenStore] refresh_token completo (DEBUG_TOKENS=1): ${tokens.refresh_token}`);
  }
}

export function clearTokens() {
  try {
    fs.unlinkSync(FILE);
  } catch {
    // ok
  }
}
