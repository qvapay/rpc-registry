# rpc-registry

Fuente de verdad de a qué nodos hablan las wallets self-custody de QvaPay.

- `registry.json` — endpoints RPC, tokens y exploradores por cadena.
- `priority` menor gana. `owner: qvapay` son nuestros nodos; entran con `enabled: false` y se activan con un commit.
- Cada PR y cada 6 h corre `scripts/check.mjs`: valida el schema y pega a todos los endpoints habilitados.
- Aquí no hay API keys y nunca las habrá.

## Consumo

```
https://raw.githubusercontent.com/qvapay/rpc-registry/main/registry.json   (primario, caché ~5 min)
https://cdn.jsdelivr.net/gh/qvapay/rpc-registry@main/registry.json          (espejo, caché ~12 h)
```

Los clientes deben: validar contra `schema.json`, ignorar registros con `version` menor al que ya tienen, y llevar una copia empaquetada como último fallback.

## Cambiar algo

1. Editar `registry.json`, subir `version` en 1 y `updated_at`.
2. `npm run check` en local.
3. PR. El CI no mergea si un endpoint habilitado no responde.
# rpc-registry
