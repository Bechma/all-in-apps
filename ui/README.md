# Notes UI (SvelteKit)

This UI consumes the Rust notes backend protobuf API:

- HTTP: `/api/notes`
- WebSocket: `/api/notes/events`
- Content type: `application/x-protobuf`

## Run locally

1. Start the backend (with notes enabled) on `http://127.0.0.1:3000`.
2. Run the UI:

```bash
cd ui
bun run dev
```

The Vite dev server proxies `/api` and `/healthcheck` to the backend.

Set `NOTES_BACKEND_URL` if your backend runs elsewhere:

```bash
NOTES_BACKEND_URL=http://127.0.0.1:4000 bun run dev
```

## Shared protobuf in TypeScript

The notes protobuf schema is generated with `ts-proto` from:

- `../crates/apps/notes/proto/notes.proto`

Generated output:

- `src/lib/protobuf/gen/notes.ts`

Commands:

```bash
cd ui
bun run proto:generate
```

```bash
cd ui
bun run proto:check
```

`proto:check` regenerates and fails if anything in `src/lib/protobuf/gen` is out of sync.

## Backend smoke test

Run the client smoke test against a running backend:

```bash
cd ui
NOTES_API_BASE_URL=http://127.0.0.1:3000 bun run test:backend-smoke
```

This validates create/get/update/list/delete plus websocket update events using the same TypeScript client code used by
the UI.
