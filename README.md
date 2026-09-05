<div align="center">

# 🛰️ rpc-registry

**Fuente de verdad de a qué nodos hablan las wallets self-custody de [QvaPay](https://qvapay.com).**

[![check](https://github.com/qvapay/rpc-registry/actions/workflows/ci.yml/badge.svg)](https://github.com/qvapay/rpc-registry/actions/workflows/ci.yml)
[![registry version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fqvapay%2Frpc-registry%2Fmain%2Fregistry.json&query=%24.version&label=registry&color=blue)](registry.json)
[![chains](https://img.shields.io/badge/chains-6-8A2BE2)](#-cadenas-soportadas)
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

| Cadena | Tipo | Chain ID | Nativo | Tokens | Explorador |
|---|---|---:|---|---|---|
| Ethereum | `evm` | 1 | ETH | USDT, USDC | [etherscan.io](https://etherscan.io) |
| BNB Smart Chain | `evm` | 56 | BNB | USDT, USDC | [bscscan.com](https://bscscan.com) |
| Polygon PoS | `evm` | 137 | POL | USDT, USDC, USDC.e | [polygonscan.com](https://polygonscan.com) |
| Base | `evm` | 8453 | ETH | USDC, USDT | [basescan.org](https://basescan.org) |
| TRON | `tron` | — | TRX | USDT, USDC | [tronscan.org](https://tronscan.org) |
| Bitcoin | `btc` | — | BTC | — | [mempool.space](https://mempool.space) |

## 🧭 Cómo funciona

- **`priority` menor gana.** La wallet intenta los endpoints en ese orden y hace failover al siguiente si uno falla.
- **`owner: qvapay`** son nuestros propios nodos. Entran siempre con `priority: 0` y `enabled: false`; se activan con un commit cuando estén listos.
- **Mínimo 2 públicos habilitados** por cadena, siempre. El CI no deja mergear si esa regla se rompe o si alguno no responde.
- **Sin API keys.** Aquí no hay y nunca las habrá. Si un proveedor las exige, no entra al registro.
- **`api`** indica el protocolo del endpoint: `jsonrpc` (EVM), `trongrid` (TRON) o `esplora` (Bitcoin). Si se omite, se infiere del `kind` de la cadena.

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
npm run check              # schema + reglas + health check de red (tolerante)
npm run check -- --strict  # igual, pero cualquier endpoint caído es error (lo que corre en cada PR)
npm run check:schema       # solo schema y reglas, sin red
```

Cada endpoint se prueba hasta 3 veces antes de darlo por caído. En modo tolerante, que es el que usa el cron cada 6 h, solo falla si una cadena queda con menos de 2 RPCs sanos; así un nodo público con un fallo puntual no abre issues falsos.

Salida típica de `npm run check`:

```
✅ schema ok (version 3, 6 chains)

ethereum
  ✅ https://ethereum-rpc.publicnode.com  h=23412876  lag=0  312ms
  ✅ https://eth.drpc.org                 h=23412876  lag=0  498ms
  ⚠️  https://1rpc.io/eth                 h=23412851  lag=25 1204ms
```

`⚠️` marca un endpoint con más de 20 bloques de retraso. `❌` marca uno caído; si quedan menos de 2 sanos en una cadena, el check falla.

## 🤝 Contribuir

Las PRs son bienvenidas: añadir un RPC público confiable, corregir un contrato de token, sumar una cadena nueva.

1. Haz fork y crea una rama: `git checkout -b feat/nombre-descriptivo`
2. Edita [`registry.json`](registry.json). **Sube `version` en 1** y actualiza `updated_at`.
3. Corre `npm run check` en local. Tiene que salir verde.
4. Abre la PR describiendo qué cambia y por qué. Si es un endpoint nuevo, indica quién lo opera.

**Qué no se acepta:**

- Endpoints que requieran API key, token o header de autenticación.
- Endpoints sin HTTPS.
- Cambios que dejen una cadena con menos de 2 públicos habilitados.
- Añadir una cadena sin su endpoint `owner: qvapay` (puede ir deshabilitado).

Si un endpoint público se cae, el health check programado abre un issue automáticamente con la etiqueta [`rpc-down`](https://github.com/qvapay/rpc-registry/issues?q=label%3Arpc-down). Si lo ves antes que el CI, abre el issue tú.

## 🔒 Seguridad

Este repositorio controla a qué nodos se conecta una wallet con fondos reales. Un endpoint malicioso puede mentir sobre saldos o censurar transacciones, aunque **nunca puede firmar por el usuario**.

- Solo se aceptan proveedores públicos con reputación establecida.
- Todo cambio pasa por PR revisada y por el CI.
- Si encuentras un endpoint comprometido o un contrato de token incorrecto, repórtalo de inmediato abriendo un issue con la etiqueta `security`.

## 🗺️ Roadmap

- [ ] Activar los nodos `owner: qvapay` cadena por cadena.
- [ ] Publicar métricas de latencia y lag de los health checks.
- [ ] Soporte para más cadenas según demanda de la comunidad.

---

<div align="center">
<sub>Mantenido por <a href="https://github.com/qvapay">QvaPay</a> · Hecho en 🇨🇺 para la comunidad</sub>
</div>
