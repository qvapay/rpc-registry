// Valida registry.json contra schema.json y hace health check a cada RPC habilitado.
// Uso: node scripts/check.mjs [--no-network] [--strict] [--baseline=<registry.json>] [--chain=<id>]
//   --no-network  solo schema y reglas de negocio
//   --strict      un endpoint caído es error (para PR/push).
//                 Sin --strict solo falla si una cadena queda con < 2 RPCs sanos (para el cron).
//   --baseline=f  con --strict, solo son error los endpoints que NO estaban en ese registro
//                 (el de main): lo nuevo tiene que responder, lo viejo que falle se avisa y lo
//                 vigila el cron. Sin baseline, todo fallo es error.
//   --chain=<id>  sondea solo esa cadena (p. ej. --chain=polygon).
// Un endpoint que responde pero va más de MAX_LAG bloques por detrás del resto cuenta como caído:
// para una wallet un nodo parado es peor que uno muerto (muestra saldos viejos y rechaza nonces).
// Las sondas van por un pool de CONCURRENCY para no disparar rate limits con ráfagas.
// Un 429 (rate limit) o un desafío de Cloudflare (403/503 con HTML) a la IP del runner NO es un nodo
// caído: el servidor está vivo pero no atiende a ESTA IP. Se reportan aparte (⏳/🛡️), no cuentan como
// sanos y no rompen --strict; solo cuenta como caído lo que no responde o responde mal.
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const NO_NET = process.argv.includes("--no-network");
const STRICT = process.argv.includes("--strict");
const ONLY = process.argv.find((a) => a.startsWith("--chain="))?.slice("--chain=".length);
const BASELINE_PATH = process.argv.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length);
const TIMEOUT_MS = 8000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const MIN_HEALTHY = 2;
const MAX_LAG = 20;
const CONCURRENCY = 6;
const MAX_RETRY_AFTER_MS = 10000;
const ESPLORA_PROBE_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"; // vector de prueba de BIP-173, casi sin UTXOs

const registry = JSON.parse(await readFile(new URL("../registry.json", import.meta.url), "utf8"));
const baselineUrls = new Set();
if (BASELINE_PATH) {
  try {
    const base = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
    for (const c of Object.values(base.chains ?? {})) for (const r of c.rpcs ?? []) baselineUrls.add(r.url);
    console.log(`ℹ️  baseline: ${baselineUrls.size} URLs ya presentes en ${BASELINE_PATH}`);
  } catch (e) { console.warn(`⚠️  no se pudo leer el baseline ${BASELINE_PATH}: ${e.message}; todo fallo será error`); }
}
const schema = JSON.parse(await readFile(new URL("../schema.json", import.meta.url), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
if (!ajv.validate(schema, registry)) {
  console.error("❌ registry.json no valida contra schema.json");
  console.error(ajv.errorsText(ajv.errors, { separator: "\n" }));
  process.exit(1);
}
console.log(`✅ schema ok (version ${registry.version}, ${Object.keys(registry.chains).length} chains)`);

// Reglas de negocio que el schema no expresa
let bad = 0;
for (const [id, chain] of Object.entries(registry.chains)) {
  const own = chain.rpcs.filter((r) => r.owner === "qvapay");
  if (own.length === 0) { console.error(`❌ ${id}: falta el endpoint owner=qvapay`); bad++; }
  if (!own.every((r) => r.priority === 0)) { console.error(`❌ ${id}: los endpoints qvapay deben tener priority 0`); bad++; }
  const enabledPublic = chain.rpcs.filter((r) => r.enabled !== false && r.owner !== "qvapay");
  if (enabledPublic.length < 2) { console.error(`❌ ${id}: se requieren al menos 2 RPCs públicos habilitados`); bad++; }
  const owners = new Set(enabledPublic.map((r) => r.owner));
  if (enabledPublic.length >= 2 && owners.size < 2) { console.error(`❌ ${id}: los públicos habilitados deben ser de al menos 2 operadores distintos`); bad++; }
  for (const r of chain.rpcs) {
    if (/[?&](api_?key|token|key)=/i.test(r.url) || /\/v[0-9]\/[0-9a-f]{32}/i.test(r.url) || /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(r.url)) {
      console.error(`❌ ${id}: la URL parece llevar una API key embebida: ${r.url}`); bad++;
    }
  }
  const urls = new Set();
  for (const r of chain.rpcs) {
    if (urls.has(r.url)) { console.error(`❌ ${id}: URL duplicada ${r.url}`); bad++; }
    urls.add(r.url);
  }
}
if (bad) process.exit(1);
if (NO_NET) process.exit(0);
if (ONLY && !registry.chains[ONLY]) { console.error(`❌ cadena desconocida: ${ONLY}`); process.exit(1); }

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// Fallo "blando": el endpoint vive pero rechaza a esta IP (rate limit o desafío anti-bot).
class SoftError extends Error {
  constructor(kind, message, retryAfterMs = 0) { super(message); this.kind = kind; this.retryAfterMs = retryAfterMs; }
}
function classify(res) {
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    return new SoftError("throttled", "HTTP 429 rate limit", Number.isFinite(ra) ? Math.min(ra * 1000, MAX_RETRY_AFTER_MS) : 0);
  }
  const cf = res.headers.get("server") === "cloudflare" || res.headers.has("cf-mitigated");
  const html = (res.headers.get("content-type") ?? "").includes("text/html");
  if ((res.status === 403 || res.status === 503) && cf && (html || res.headers.has("cf-mitigated"))) {
    return new SoftError("challenged", `HTTP ${res.status} desafío de Cloudflare`);
  }
  return null;
}

async function withTimeout(p) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await p(ctrl.signal); } finally { clearTimeout(t); }
}

async function probe(chainId, chain, rpc) {
  const api = rpc.api ?? (chain.kind === "evm" ? "jsonrpc" : chain.kind === "tron" ? "trongrid" : "esplora");
  const started = Date.now();
  return withTimeout(async (signal) => {
    if (api === "jsonrpc") {
      const call = async (method, id) => {
        const res = await fetch(rpc.url, {
          method: "POST", signal,
          headers: { "content-type": "application/json", ...(rpc.headers ?? {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [] }),
        });
        if (!res.ok) throw classify(res) ?? new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (j?.error) throw new Error(`rpc error: ${j.error.message ?? JSON.stringify(j.error)}`);
        if (typeof j?.result !== "string") throw new Error(`respuesta inválida a ${method}`);
        return parseInt(j.result, 16);
      };
      const [got, height] = await Promise.all([call("eth_chainId", 1), call("eth_blockNumber", 2)]);
      if (got !== chain.chainId) throw new Error(`chainId ${got} ≠ ${chain.chainId}`);
      if (!Number.isFinite(height)) throw new Error("altura inválida");
      return { height, ms: Date.now() - started };
    }
    if (api === "trongrid") {
      const res = await fetch(`${rpc.url}/wallet/getnowblock`, { method: "POST", signal, headers: rpc.headers ?? {} });
      if (!res.ok) throw classify(res) ?? new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const h = j?.block_header?.raw_data?.number;
      if (!h) throw new Error("sin block_header");
      return { height: h, ms: Date.now() - started };
    }
    if (api === "esplora") {
      const res = await fetch(`${rpc.url}/blocks/tip/height`, { signal, headers: rpc.headers ?? {} });
      if (!res.ok) throw classify(res) ?? new Error(`HTTP ${res.status}`);
      const h = parseInt(await res.text(), 10);
      if (!Number.isFinite(h)) throw new Error("tip inválido");
      // Una wallet necesita el índice por dirección: hay instancias que sirven el tip pero
      // no /address/*/utxo (o lo capan a 0 UTXOs). Dirección con muy pocos UTXOs a propósito.
      const utxo = await fetch(`${rpc.url}/address/${ESPLORA_PROBE_ADDRESS}/utxo`, { signal, headers: rpc.headers ?? {} });
      if (!utxo.ok) throw classify(utxo) ?? new Error(`sin índice de direcciones (HTTP ${utxo.status} en /address/*/utxo)`);
      if (!Array.isArray(await utxo.json())) throw new Error("respuesta inválida en /address/*/utxo");
      return { height: h, ms: Date.now() - started };
    }
    throw new Error(`api desconocida ${api}`);
  });
}

// Reintenta para no marcar como caído un nodo con un fallo puntual de red.
async function probeWithRetry(id, chain, rpc) {
  let last;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try { return { ...(await probe(id, chain, rpc)), attempts: i }; }
    catch (e) { last = e; if (i < ATTEMPTS) await sleep(Math.max(RETRY_DELAY_MS, e?.retryAfterMs ?? 0)); }
  }
  throw last;
}

let down = 0;
let lagging = 0;
let soft = 0;
let preexisting = 0; // caídos/parados que ya estaban en el baseline
let chainsDown = 0;
for (const [id, chain] of Object.entries(registry.chains)) {
  if (ONLY && id !== ONLY) continue;
  const results = await pool(chain.rpcs.filter((r) => r.enabled !== false), CONCURRENCY, async (r) => {
    try { return { status: "fulfilled", value: { r, ...(await probeWithRetry(id, chain, r)) } }; }
    catch (e) { return { status: "rejected", url: r.url, soft: e instanceof SoftError ? e.kind : null, reason: new Error(`${r.url}  ${e?.message ?? e}`) }; }
  });
  const ok = results.filter((x) => x.status === "fulfilled").map((x) => x.value);
  // Altura de referencia: mediana de los que responden, para que un solo nodo adelantado
  // (o uno que mienta) no marque a todos los demás como retrasados.
  const heights = ok.map((x) => x.height).filter(Number.isFinite).sort((a, b) => a - b);
  const refH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  let healthy = 0;
  console.log(`\n${id}  (${ok.length}/${results.length} responden)`);
  for (const x of results) {
    if (x.status === "fulfilled") {
      const { r, height, ms, attempts } = x.value;
      const lag = refH - height;
      const retried = attempts > 1 ? `  (${attempts} intentos)` : "";
      if (lag > MAX_LAG) {
        lagging++;
        if (baselineUrls.has(r.url)) preexisting++;
        console.log(`  ⚠️  ${r.url}  h=${height}  lag=${lag}  ${ms}ms${retried}  ← parado, cuenta como caído${baselineUrls.has(r.url) ? " (ya estaba en main)" : ""}`);
      } else {
        healthy++;
        console.log(`  ✅ ${r.url}  h=${height}  lag=${Math.max(lag, 0)}  ${ms}ms${retried}`);
      }
    } else if (x.soft) {
      soft++;
      const icon = x.soft === "throttled" ? "⏳" : "🛡️ ";
      console.log(`  ${icon} ${x.reason?.message ?? x.reason}  (tras ${ATTEMPTS} intentos; vivo, pero no atiende a esta IP)`);
    } else {
      down++;
      const old = baselineUrls.has(x.url);
      if (old) preexisting++;
      console.log(`  ❌ ${x.reason?.message ?? x.reason}  (tras ${ATTEMPTS} intentos)${old ? "  (ya estaba en main)" : ""}`);
    }
  }
  if (healthy < MIN_HEALTHY) { console.error(`❌ ${id}: menos de ${MIN_HEALTHY} RPCs sanos`); chainsDown++; }
}

console.log("");
const failed = down + lagging;
const newFailed = failed - preexisting;
if (chainsDown) { console.error(`❌ ${chainsDown} cadena(s) sin RPCs suficientes`); process.exit(1); }
if (soft) console.warn(`⏳ ${soft} endpoint(s) rechazaron a esta IP (rate limit / desafío anti-bot); no cuentan como caídos`);
if (STRICT && BASELINE_PATH && failed) {
  if (preexisting) console.warn(`⚠️  ${preexisting} endpoint(s) que ya estaban en main fallan; los vigila el cron`);
  if (newFailed) { console.error(`❌ ${newFailed} endpoint(s) NUEVOS caídos o parados, y --strict activo`); process.exit(1); }
  console.log(`✅ todos los endpoints nuevos responden`); process.exit(0);
}
if (failed && STRICT) { console.error(`❌ ${down} endpoint(s) caído(s) y ${lagging} parado(s), y --strict activo`); process.exit(1); }
if (failed) console.warn(`⚠️  ${down} endpoint(s) caído(s) y ${lagging} parado(s), pero todas las cadenas tienen ≥ ${MIN_HEALTHY} sanos`);
else console.log(`✅ todos los endpoints que atienden a esta IP responden y están al día`);
process.exit(0);
