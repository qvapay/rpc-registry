// Valida registry.json contra schema.json y hace health check a cada RPC habilitado.
// Uso: node scripts/check.mjs [--no-network] [--strict]
//   --no-network  solo schema y reglas de negocio
//   --strict      cualquier endpoint caído es error (para PR/push).
//                 Sin --strict solo falla si una cadena queda con < 2 RPCs sanos (para el cron).
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const NO_NET = process.argv.includes("--no-network");
const STRICT = process.argv.includes("--strict");
const TIMEOUT_MS = 8000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const MIN_HEALTHY = 2;
const MAX_LAG = 20;

const registry = JSON.parse(await readFile(new URL("../registry.json", import.meta.url), "utf8"));
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
  const urls = new Set();
  for (const r of chain.rpcs) {
    if (urls.has(r.url)) { console.error(`❌ ${id}: URL duplicada ${r.url}`); bad++; }
    urls.add(r.url);
  }
}
if (bad) process.exit(1);
if (NO_NET) process.exit(0);

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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      const j = await res.json();
      const h = j?.block_header?.raw_data?.number;
      if (!h) throw new Error("sin block_header");
      return { height: h, ms: Date.now() - started };
    }
    if (api === "esplora") {
      const res = await fetch(`${rpc.url}/blocks/tip/height`, { signal, headers: rpc.headers ?? {} });
      const h = parseInt(await res.text(), 10);
      if (!Number.isFinite(h)) throw new Error("tip inválido");
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
    catch (e) { last = e; if (i < ATTEMPTS) await sleep(RETRY_DELAY_MS); }
  }
  throw last;
}

let down = 0;
let chainsDown = 0;
for (const [id, chain] of Object.entries(registry.chains)) {
  const results = await Promise.allSettled(
    chain.rpcs.filter((r) => r.enabled !== false).map(async (r) => {
      try { return { r, ...(await probeWithRetry(id, chain, r)) }; }
      catch (e) { throw new Error(`${r.url}  ${e?.message ?? e}`); }
    })
  );
  const ok = results.filter((x) => x.status === "fulfilled").map((x) => x.value);
  const maxH = Math.max(...ok.map((x) => x.height).filter(Number.isFinite), 0);
  console.log(`\n${id}`);
  for (const x of results) {
    if (x.status === "fulfilled") {
      const { r, height, ms, attempts } = x.value;
      const lag = maxH - height;
      const flag = lag > MAX_LAG ? "⚠️ " : "✅";
      const retried = attempts > 1 ? `  (${attempts} intentos)` : "";
      console.log(`  ${flag} ${r.url}  h=${height}  lag=${lag}  ${ms}ms${retried}`);
    } else {
      down++;
      console.log(`  ❌ ${x.reason?.message ?? x.reason}  (tras ${ATTEMPTS} intentos)`);
    }
  }
  if (ok.length < MIN_HEALTHY) { console.error(`❌ ${id}: menos de ${MIN_HEALTHY} RPCs sanos`); chainsDown++; }
}

console.log("");
if (chainsDown) { console.error(`❌ ${chainsDown} cadena(s) sin RPCs suficientes`); process.exit(1); }
if (down && STRICT) { console.error(`❌ ${down} endpoint(s) caído(s) y --strict activo`); process.exit(1); }
if (down) console.warn(`⚠️  ${down} endpoint(s) caído(s), pero todas las cadenas tienen ≥ ${MIN_HEALTHY} sanos`);
else console.log("✅ todos los endpoints habilitados responden");
process.exit(0);
