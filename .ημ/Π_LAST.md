# Π handoff

- time: 2026-03-21T21:23:56Z
- branch: main
- pre-Π HEAD: b77c0bb
- Π HEAD: pending at capture time; resolved by the final commit after artifact assembly

## Summary
- Retire the obsolete Render deployment path by deleting stale render manifests and the broken MCP Dockerfile, and add README guidance that points live deployment authority at the Promethean runtime layer in devel.
- Preserve the current world-interface refinement branch state while clarifying that this repo now serves as product/source code and not the canonical live deployment surface.

## Notes
- push branch: pi/fork-tax/2026-03-21-211345
- origin remains origin/main; snapshot published on a dedicated Π branch plus tag while local main stays available for ongoing work.

## Verification
- pass: pnpm --dir threat-radar-deploy --filter @riatzukiza/threat-radar-mcp build
- pass: pnpm --dir threat-radar-deploy --filter @riatzukiza/threat-radar-web build
- pass: pnpm --dir threat-radar-deploy --filter @riatzukiza/threat-radar-web test (313 passed; React act warnings only)
