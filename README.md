# Threat Radar

Application/source repository for the Threat Radar platform.

## Role in the workspace

- This repo contains the product code for:
  - `packages/radar-core`
  - `packages/mcp-foundation`
  - `packages/signal-atproto`
  - `packages/signal-embed-browser`
  - `packages/thread-assessment`
  - `services/threat-radar-mcp`
  - `services/threat-radar-web`
- The live public deployment is **not** managed from Render.

## Canonical deployment status

Render is retired for Threat Radar.

The canonical live deployment for `https://radar.promethean.rest` is Promethean-hosted and managed from the parent `devel` workspace:

- edge routing: `services/proxx/Caddyfile`
- runtime stack: `services/radar-stack/**`
- app/product source: `threat-radar-deploy/**`

This means this repo is the source of the application code, while the actual live compose/runtime glue lives in `devel/services/radar-stack`.

## Local development

Build the workspace packages and run the MCP/web services locally from this repo.

For live-host deployment, use the Promethean runtime materials in the `devel` workspace rather than restoring the retired Render manifests.