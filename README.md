# all-in-apps

## Local Postgres for SQLx macros

```bash
docker compose up -d postgres
```

```bash
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/all_in_apps
cargo sqlx migrate run --source crates/apps/notes/migrations
```

## Refresh SQLx offline metadata

```bash
cargo sqlx prepare --workspace -- --all-targets
```

This updates `.sqlx/` so `query!`/`query_as!` compile offline (`SQLX_OFFLINE=true`).
