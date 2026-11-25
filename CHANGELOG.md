# Changelog

## Unreleased

- Check 2 — reports reads that saw more rows than the table holds inside the caller's
  tenants, using the returned range as a floor (`100-109/*` → at least 110 rows).
- `supatripwire check`: check 1 — reports signed-in reads whose filter named a tenant
  the caller does not belong to, classified as crossed, not provably foreign, or
  nothing returned.
