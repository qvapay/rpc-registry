// Valida registry.json contra schema.json y hace health check a cada RPC habilitado.
// Uso: node scripts/check.mjs [--no-network]
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const NO_NET = process.argv.includes("--no-network");
const TIMEOUT_MS = 8000;

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

let failures = 0;
for (const [id, chain] of Object.entries(registry.chains)) {
  const results = await Promise.allSettled(
    chain.rpcs.filter((r) => r.enabled !== false).map(async (r) => {
      try { return { r, ...(await probe(id, chain, r)) }; }
      catch (e) { throw new Error(`${r.url}  ${e?.message ?? e}`); }
    })
  );
  const ok = results.filter((x) => x.status === "fulfilled").map((x) => x.value);
  const maxH = Math.max(...ok.map((x) => x.height).filter(Number.isFinite), 0);
  console.log(`\n${id}`);
  for (const x of results) {
    if (x.status === "fulfilled") {
      const lag = maxH - x.value.height;
      const flag = lag > 20 ? "⚠️ " : "✅";
      console.log(`  ${flag} ${x.value.r.url}  h=${x.value.height}  lag=${lag}  ${x.value.ms}ms`);
    } else {
      failures++;
      console.log(`  ❌ ${x.reason?.message ?? x.reason}`);
    }
  }
  if (ok.length < 2) { console.error(`❌ ${id}: menos de 2 RPCs sanos`); failures++; }
}
process.exit(failures ? 1 : 0);
