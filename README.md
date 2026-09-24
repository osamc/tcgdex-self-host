# TCGdex self-host

A Docker Compose stack for the [TCGdex API](https://hub.docker.com/r/tcgdex/server), placed behind an existing Caddy server. A small manager in front of the official image records request volume and lets you add cards, sets, and series, or replace official records that share the same id.

The published `tcgdex/server` image compiles the card database when the image is built. It does not read a data folder at runtime, so custom records are applied by the manager on the REST v2 endpoints. GraphQL is proxied unchanged and does not include those records.

## Run

```bash
cp .env.example .env
openssl rand -hex 24   # put this value in MANAGEMENT_TOKEN
docker compose up -d
```

The API and the management UI listen on `127.0.0.1:8080`. The TCGdex container itself is not published.

- API: `http://127.0.0.1:8080/v2/en/cards/base1-4`
- Health: `http://127.0.0.1:8080/healthz`
- Management UI: `http://127.0.0.1:8080/manage`

The first start waits until Cardmarket and TCGcsv price files have downloaded. Current images do not open port 3000 until both feeds load, and they refuse to start the TCGcsv client unless `TCGDEX_USER_AGENT` is set. The container needs outbound HTTPS to `downloads.s3.cardmarket.com` and `tcgcsv.com`.

If those hosts cannot be reached, the official process never listens. Add `CI: "true"` to the `tcgdex` service environment to serve the card database without market prices. That variable is how the upstream image skips the price client.

## Existing Caddy

This stack does not start Caddy and does not bind ports 80 or 443.

### Caddy on the host

In `.env`:

```bash
TCGDEX_HOST=cards.example.com
TCGDEX_UPSTREAM=127.0.0.1:8080
```

Import the site from the Caddyfile you already run:

```caddyfile
import /path/to/this/repo/caddy/tcgdex.caddy
```

Reload Caddy, then open `https://cards.example.com/v2/en/cards` and `https://cards.example.com/manage`.

### Caddy in Docker

Point `CADDY_NETWORK` at the network that container already uses (`docker network ls`). The default name is `caddy`.

```bash
TCGDEX_HOST=cards.example.com
TCGDEX_UPSTREAM=tcgdex-manager:8080
CADDY_NETWORK=caddy
```

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Import `caddy/tcgdex.caddy` the same way. Caddy reaches the API at `http://tcgdex-manager:8080`.

## Management UI

Open `/manage` and enter `MANAGEMENT_TOKEN`. The token is only required for the UI and the `/manage/api/` routes. The card API stays public, matching TCGdex.

The dashboard shows request counts, error counts, average latency, an approximate p95 from recent samples, the busiest paths, and the latest calls. Counts are kept for 24 hours in `data/metrics.json`.

## Custom cards, sets, and series

Create records in the UI, or copy the examples into the data directory and restart is not required (the manager watches the folder):

```bash
cp -a examples/cards examples/sets examples/series data/
```

Files are stored as:

```text
data/cards/<language>/<id>.json
data/sets/<language>/<id>.json
data/series/<language>/<id>.json
data/images/<file>.png
```

Languages are the ones TCGdex publishes: `en`, `fr`, `es`, `es-mx`, `it`, `pt`, `pt-br`, `pt-pt`, `de`, `nl`, `pl`, `ru`, `ja`, `ko`, `zh-tw`, `id`, `th`, `zh-cn`.

A saved card uses the same JSON shape as `GET /v2/{lang}/cards/{id}`. Saving an id that already exists upstream replaces that card everywhere the REST catalog lists it. A new id is added next to the official data. Sets and series work the same way. Cards inside a set are collected from the card files, so a set file does not embed its card list.

To override an official card, use **Import upstream** in the UI. Card ids look like `swsh3-136` or `exu-M`. For set-scoped cards you can also enter `set/localId` (for example `exu/M` for Unown M from Unseen Forces Unown Collection).

Uploaded images are served from `/assets/<name>`. The card `image` field is stored as that base path, without a file extension, matching official TCGdex. Clients then request:

```text
https://cards.example.com/assets/<name>/high.webp
https://cards.example.com/assets/<name>/low.webp
```

`/high.png` and `/low.png` work the same way. A single upload is used for both qualities. To serve a smaller preview, upload a low-res file in the editor or add `data/images/<name>/low.webp`. Existing `/assets/<file>.png` values are rewritten to the extensionless form in API responses so SDKs that append `/high.webp` keep working.

Put the public site origin in the editor's base URL field so the card's `image` value is an absolute URL.

These REST paths include the local catalog:

- `/v2/{lang}/cards`, `/v2/{lang}/cards/{id}`, `/v2/{lang}/sets/{set}/{localId}`
- `/v2/{lang}/sets`, `/v2/{lang}/sets/{id}`
- `/v2/{lang}/series`, `/v2/{lang}/series/{id}`
- category, type, rarity, HP, and the other card facet lists

List filters use the TCGdex operators (`name=pikachu`, `name=eq:Furret`, `hp=gte:50`, `set=demo`, plus `sort:field`, `sort:order`, `pagination:page`, and `pagination:itemsPerPage`). Pagination is applied after custom records are merged. Sorting is reapplied when the sort field is one of the fields on the list objects (`id`, `localId`, `name`, `image` for cards). A sort such as `hp` keeps the upstream order and appends new cards, because list responses do not include HP.

`/v2/graphql` and `/v2/{lang}/random/*` are proxied to the official server and do not see custom records.

## Configuration

| Variable | Purpose |
| --- | --- |
| `TCGDEX_IMAGE` | Image to run. Default `tcgdex/server:edge`. |
| `MAX_WORKERS` | TCGdex worker processes. Default `2`. |
| `TCGDEX_USER_AGENT` | Contact string sent when downloading TCGcsv prices. Default `self-hosted-tcgdex`. |
| `UPSTREAM_CACHE_TTL` | Seconds to cache upstream JSON before merging custom records. Default `300`. |
| `MANAGEMENT_TOKEN` | Required. At least 16 characters. |
| `MANAGER_BIND` / `MANAGER_PORT` | Host address for the manager. Default `127.0.0.1:8080`. |
| `CADDY_NETWORK` | Existing Docker network for `docker-compose.caddy.yml`. |
| `TCGDEX_HOST` / `TCGDEX_UPSTREAM` | Read by `caddy/tcgdex.caddy`. |

## Development

The manager is a Node.js program with no dependencies. Tests use a fake upstream and do not need Docker:

```bash
cd manager
npm test
```
