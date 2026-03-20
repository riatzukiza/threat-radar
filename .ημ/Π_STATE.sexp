(Π_STATE
  (time "2026-03-20T16:35:08Z")
  (branch "main")
  (pre_head "2bbf55c")
  (dirty true)
  (checks
    (check (status passed) (command "services/threat-radar-mcp pnpm run typecheck"))
    (check (status failed) (command "services/threat-radar-mcp pnpm run test") (note "81 pass, 2 fail: storage thread CRUD; signal auto-clustering"))
    (check (status passed) (command "services/threat-radar-mcp pnpm run build"))
  )
  (repo_notes
    (upstream "origin/main")
    (status_digest "9429-a8e3-a0d1-ec4d")
    (note "This snapshot intentionally preserves a known-red test state so the root recursive Π can reference the exact failing revision.")
    (changed_file "receipts.log")
    (changed_file "services/threat-radar-mcp/src/main.ts")
    (changed_file ".dockerignore")
  )
)
