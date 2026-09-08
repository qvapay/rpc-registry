<div align="center">

# 🛰️ rpc-registry

**Fuente de verdad de a qué nodos hablan las wallets self-custody de [QvaPay](https://qvapay.com).**

[![check](https://github.com/qvapay/rpc-registry/actions/workflows/ci.yml/badge.svg)](https://github.com/qvapay/rpc-registry/actions/workflows/ci.yml)
[![registry version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fqvapay%2Frpc-registry%2Fmain%2Fregistry.json&query=%24.version&label=registry&color=blue)](registry.json)
[![chains](https://img.shields.io/badge/chains-6-8A2BE2)](#-cadenas-soportadas)
[![endpoints](https://img.shields.io/badge/endpoints-120-orange)](#-cadenas-soportadas)
[![jsDelivr hits](https://data.jsdelivr.com/v1/package/gh/qvapay/rpc-registry/badge)](https://www.jsdelivr.com/package/gh/qvapay/rpc-registry)
[![last commit](https://img.shields.io/github/last-commit/qvapay/rpc-registry)](https://github.com/qvapay/rpc-registry/commits/main)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#-contribuir)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)

Un solo JSON, versionado, validado y con health check automático.  
Sin API keys. Sin backend. Sin sorpresas.

</div>

---

## 📦 ¿Qué hay aquí?

| Archivo | Qué es |
|---|---|
| [`registry.json`](registry.json) | Endpoints RPC, tokens y exploradores por cadena. **El único archivo que las wallets consumen.** |
| [`schema.json`](schema.json) | JSON Schema (draft 2020-12) que define la forma válida del registro. |
| [`scripts/check.mjs`](scripts/check.mjs) | Valida el schema, aplica reglas de negocio y pega a todos los endpoints habilitados. |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Corre el check en cada PR, en cada push a `main` y cada 6 horas. |

## ⛓️ Cadenas soportadas

| Cadena | Tipo | Chain ID | Nativo | Tokens | RPCs públicos | Operadores | Explorador |
|---|---|---:|---|---|---:|---:|---|
| Ethereum | `evm` | 1 | ETH | USDT, USDC | 29 | 29 | [etherscan.io](https://etherscan.io) |
| BNB Smart Chain | `evm` | 56 | BNB | USDT, USDC | 35 | 23 | [bscscan.com](https://bscscan.com) |
| Polygon PoS | `evm` | 137 | POL | USDT, USDC, USDC.e | 19 | 15 | [polygonscan.com](https://polygonscan.com) |
| Base | `evm` | 8453 | ETH | USDC, USDT | 23 | 21 | [basescan.org](https://basescan.org) |
| TRON | `tron` | 728126428 | TRX | USDT, USDC | 6 | 4 | [tronscan.org](https://tronscan.org) |
| Bitcoin | `btc` | — | BTC | — | 8 | 8 | [mempool.space](https://mempool.space) |

Todos los endpoints del registro (v4, septiembre 2026) fueron verificados uno a uno con `eth_chainId` + `eth_blockNumber` + `eth_getBalance` (EVM), `/wallet/getnowblock` (TRON) o `/blocks/tip/height` + `/address/*/utxo` (Bitcoin) antes de entrar. En BSC varios "operadores" son los dataseeds oficiales de BNB Chain repartidos entre `bnbchain`, `defibit`, `ninicoin` y `nariox`.

**Por qué TRON y Bitcoin tienen menos:** no es falta de búsqueda, es el ecosistema. Fuera de TronGrid/TronStack/PublicNode casi nadie expone la API HTTP de full node de TRON sin API key; los tres endpoints `api: "jsonrpc"` de TRON (TronGrid, PublicNode, dRPC) son **solo lectura** (el JSON-RPC de TRON no implementa `eth_sendRawTransaction`), por eso van con prioridad ≥ 100 y una wallet debe usarlos únicamente para consultar saldos y bloques. En Bitcoin solo existen ~10 instancias Esplora públicas completas en toda la red (con índice de direcciones y broadcast); las demás API públicas (Blockbook de Trezor/Atomic, Bitcore de BitPay, blockchain.info, Blockchair, BlockCypher, JSON-RPC de Bitcoin Core) usan otros formatos y entrarían solo si el registro añade nuevos valores de `api`.

## 🧭 Cómo funciona

- **`priority` menor gana.** La wallet intenta los endpoints en ese orden y hace failover al siguiente si uno falla.
- **`owner: qvapay`** son nuestros propios nodos. Entran siempre con `priority: 0` y `enabled: false`; se activan con un commit cuando estén listos.
- **Mínimo 2 públicos habilitados** por cadena, siempre. El CI no deja mergear si esa regla se rompe o si alguno no responde.
- **Sin API keys.** Aquí no hay y nunca las habrá. Si un proveedor las exige, no entra al registro.
- **`api`** indica el protocolo del endpoint: `jsonrpc` (EVM), `trongrid` (TRON) o `esplora` (Bitcoin). Si se omite, se infiere del `kind` de la cadena. En TRON un endpoint `jsonrpc` es de solo lectura.
- **Al menos 2 operadores distintos** entre los públicos habilitados de cada cadena, para que la caída de un proveedor no tumbe la cadena.
- **Un nodo parado cuenta como caído.** Si responde pero va más de 20 bloques por detrás de la mediana de la cadena, el check lo trata igual que a uno muerto: para una wallet un nodo con saldos viejos es peor que uno sin respuesta.
- **Sin keys embebidas.** El check rechaza URLs con `?api_key=`, `?token=`, hashes de 32 hex o UUIDs en el path: son tokens "públicos" de terceros que pueden revocarse en cualquier momento. Por eso no están GetBlock shared, NodeReal `/v1/<key>`, Dwellir, RPCFast ni LeoRPC (`api_key=FREE`).

<details>
<summary><b>Ejemplo de una cadena en <code>registry.json</code></b></summary>

```json
"base": {
  "kind": "evm",
  "chainId": 8453,
  "name": "Base",
  "native": { "symbol": "ETH", "decimals": 18 },
  "explorer": "https://basescan.org/tx/{tx}",
  "tokens": [
    { "symbol": "USDC", "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "decimals": 6 }
  ],
  "rpcs": [
    { "url": "https://base.qvapay.com",          "priority": 0,  "owner": "qvapay", "enabled": false },
    { "url": "https://mainnet.base.org",         "priority": 10, "owner": "base" },
    { "url": "https://base-rpc.publicnode.com",  "priority": 20, "owner": "publicnode" }
  ]
}
```

</details>

## 📡 Consumo

```
https://raw.githubusercontent.com/qvapay/rpc-registry/main/registry.json   # primario, caché ~5 min
https://cdn.jsdelivr.net/gh/qvapay/rpc-registry@main/registry.json          # espejo,   caché ~12 h
```

Un cliente bien portado debe:

1. **Validar** el JSON descargado contra [`schema.json`](schema.json) antes de usarlo.
2. **Ignorar** cualquier registro cuya `version` sea menor a la que ya tiene guardada.
3. **Empaquetar** una copia del registro en la app como último fallback si ambas URLs fallan.

<details>
<summary><b>Ejemplo mínimo en JavaScript</b></summary>

```js
const SOURCES = [
  "https://raw.githubusercontent.com/qvapay/rpc-registry/main/registry.json",
  "https://cdn.jsdelivr.net/gh/qvapay/rpc-registry@main/registry.json",
];

async function loadRegistry(current) {
  for (const url of SOURCES) {
    try {
      const fresh = await fetch(url).then((r) => r.json());
      if (fresh.version > (current?.version ?? 0)) return fresh;
    } catch {}
  }
  return current; // copia empaquetada
}

const rpcsFor = (reg, chain) =>
  reg.chains[chain].rpcs
    .filter((r) => r.enabled !== false)
    .sort((a, b) => a.priority - b.priority);
```

</details>

## 🛠️ Desarrollo local

```bash
npm ci
npm run check                    # schema + reglas + health check de red (tolerante)
npm run check -- --strict        # igual, pero cualquier endpoint caído es error (lo que corre en cada PR)
npm run check -- --chain=polygon # sondea solo una cadena
npm run check:schema             # solo schema y reglas, sin red
```

Las sondas salen por un pool de 6 en paralelo: con 120+ endpoints una ráfaga dispara los rate limits por IP de varios proveedores y produce 429 falsos.

Cada endpoint se prueba hasta 3 veces antes de darlo por caído. En modo tolerante, que es el que usa el cron cada 6 h, solo falla si una cadena queda con menos de 2 RPCs sanos; así un nodo público con un fallo puntual no abre issues falsos.

Salida típica de `npm run check`:

```
✅ schema ok (version 3, 6 chains)

ethereum
  ✅ https://ethereum-rpc.publicnode.com  h=23412876  lag=0  312ms
  ✅ https://eth.drpc.org                 h=23412876  lag=0  498ms
  ⚠️  https://1rpc.io/eth                 h=23412851  lag=25 1204ms
```

`⚠️` marca un endpoint parado (más de 20 bloques por detrás de la mediana) y `❌` uno caído; ambos cuentan como no sanos. `⏳` (HTTP 429) y `🛡️` (desafío de Cloudflare) marcan endpoints vivos que rechazan la IP desde la que corre el check — típico con los runners de GitHub —; no cuentan como sanos pero tampoco rompen `--strict`, porque un cliente real con su propia IP sí los usa. Si quedan menos de 2 sanos en una cadena, el check falla.

## 🤝 Contribuir

Las PRs son bienvenidas: añadir un RPC público confiable, corregir un contrato de token, sumar una cadena nueva.

1. Haz fork y crea una rama: `git checkout -b feat/nombre-descriptivo`
2. Edita [`registry.json`](registry.json). **Sube `version` en 1** y actualiza `updated_at`.
3. Corre `npm run check` en local. Tiene que salir verde.
4. Abre la PR describiendo qué cambia y por qué. Si es un endpoint nuevo, indica quién lo opera.

**Qué no se acepta:**

- Endpoints que requieran API key, token o header de autenticación, incluidas las keys "públicas" embebidas en la URL.
- Endpoints sin HTTPS.
- Cambios que dejen una cadena con menos de 2 públicos habilitados o de un solo operador.
- Añadir una cadena sin su endpoint `owner: qvapay` (puede ir deshabilitado).

<details>
<summary><b>Proveedores ya evaluados y descartados (septiembre 2026)</b> — no hace falta volver a proponerlos salvo que cambien de política</summary>

| Proveedor | Motivo |
|---|---|
| Ankr (`rpc.ankr.com/*`, `polygon-rpc.com`, `bscrpc.com`, `eth.public-rpc.com`) | Exige API key desde 2025; `polygon-rpc.com` sigue apareciendo como "oficial" en docs viejas pero está deshabilitado. |
| LlamaNodes (`*.llamarpc.com`) | Muerto (error 525 / timeout). |
| Lava (`*.lava.build`) | "This endpoint has been discontinued" (410). |
| Grove (`rpc.grove.city`) | Cerró; sus públicos migraron a `api.pocket.network`, que sí está en el registro. |
| Envio HyperRPC (`*.rpc.hypersync.xyz`) | Exige token. |
| Blast API en Polygon | "Blast API is no longer available" (ETH/BSC/Base siguen). |
| Alchemy `/v2/demo` | Muerto; el `/public` documentado sí está en el registro (no existe para Polygon). |
| 1RPC en BSC (`1rpc.io/bnb`, `public.1rpc.io/bnb`) | Nodo parado: lleva decenas de miles de bloques por detrás. |
| MeowRPC | Cuota por IP tan baja que falla el check con 3 intentos. |
| thirdweb (`<chainId>.rpc.thirdweb.com`) | Rate limit por IP agresivo: 429 al primer intento sin client id. |
| OnFinality en BSC/Polygon/Base | Cuota pública compartida agotada la mayor parte del día. |
| dRPC en BSC | "Public endpoint rate limit" persistente (el resto de cadenas de dRPC está). |
| Nodies en BSC/Polygon | "requires a paid subscription plan". |
| Cloudflare `cloudflare-eth.com` | Responde "Cannot fulfill request" a `eth_getBalance`. |
| Flashbots Protect, Titan, Beaver, GasHawk | Relays de transacciones, no sirven para lecturas. |
| routeme.sh, satelink, nodeflare, keccak, chainstack public, rpcfast, tatum en Base | Rate limit o 402/403 sin key. |
| SubQuery public, stakely (salvo ETH), blockpi (salvo ETH/Base), swiftnodes en Polygon | No resuelven, 404/521 o fallan intermitentemente. |
| mempool.emzy.de | Instancia completa y muy citada como fallback, pero su throttle por IP hace fallar el check con 3 intentos; candidata a volver si el CI la tolera. |
| Bull Bitcoin mempool | Capó `/address/*/utxo` a 0 UTXOs: inservible para una wallet. |
| DIYNodes mempool | Sin índice de direcciones (404 en `/address/*/utxo`). |
| Bisq mempool, mempool.bitcoin.builders, mempoolx.space | DNS o TLS muertos. |
| mempool.guide | Es la cadena fork BIP-110, no Bitcoin mainnet. |

</details>

Si un endpoint público se cae, el health check programado abre un issue automáticamente con la etiqueta [`rpc-down`](https://github.com/qvapay/rpc-registry/issues?q=label%3Arpc-down). Si lo ves antes que el CI, abre el issue tú.

## 🔒 Seguridad

Este repositorio controla a qué nodos se conecta una wallet con fondos reales. Un endpoint malicioso puede mentir sobre saldos o censurar transacciones, aunque **nunca puede firmar por el usuario**.

- Solo se aceptan proveedores públicos con reputación establecida.
- Todo cambio pasa por PR revisada y por el CI.
- Si encuentras un endpoint comprometido o un contrato de token incorrecto, repórtalo de inmediato abriendo un issue con la etiqueta `security`.

## 🗺️ Roadmap

- [x] ≥ 20 RPCs públicos verificados por cadena EVM (v4, septiembre 2026).
- [ ] Activar los nodos `owner: qvapay` cadena por cadena (hoy no hay hardware propio; el registro funciona solo con públicos).
- [ ] Más endpoints para TRON y Bitcoin: evaluar añadir `api: "blockbook"` (Trezor, Atomic) y JSON-RPC de Bitcoin Core (PublicNode, dRPC, NOWNodes) para ampliar Bitcoin, y buscar operadores de full node TRON sin key.
- [ ] Publicar métricas de latencia y lag de los health checks.
- [ ] Soporte para más cadenas según demanda de la comunidad.

---

<div align="center">
<sub>Mantenido por <a href="https://github.com/qvapay">QvaPay</a> · Hecho en 🇨🇺 para la comunidad</sub>
</div>
