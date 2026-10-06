# SLSEA Solar Generation API (Node.js + MongoDB Atlas)

JavaScript ES module REST API with locally served Swagger UI 5.33.1 and OpenAPI 3.0.3, running on Node.js and storing its data in MongoDB Atlas. All records are synthetic.

This is the Cloudflare Workers / D1 project converted to a normal Node.js server. The REST contract (routes, status codes, error bodies, ETags, pagination, access model) is unchanged.

## Quick start

Requires **Node.js 22.15 or later** and a **MongoDB Atlas** cluster (the free M0 tier is enough).

### 1. Prepare Atlas (once)

1. Create a cluster (free M0 is fine).
2. **Database Access** > add a database user with a password (the built-in "Read and write to any database" role is fine).
3. **Network Access** > add your current IP address. (`0.0.0.0/0` allows everyone and is only suitable for a short demo.)
4. **Connect** > **Drivers** > **Node.js** > copy the connection string.

### 2. Configure

```powershell
# Windows PowerShell                 # macOS / Linux
Copy-Item .env.example .env          # cp .env.example .env
npm install
npm run secrets                      # prints random values to paste into .env
```

Edit `.env`: paste your connection string into `MONGODB_URI` (replace `<db_user>` and `<db_password>`; URL-encode special characters in the password) and set `JWT_SECRET`, `DEVICE_MASTER` and `USER_PASSWORD`.

### 3. Load the data and start

```sh
npm run seed     # once: 9 provinces, 25 districts, 25 substations, 200 installations, 134 600 readings
npm start
```

Open http://localhost:8787/docs. Seeding takes from several seconds to a couple of minutes depending on your connection to Atlas, and is safe to re-run or resume.

Accounts: `national`, `western` (Western province), `colombo` (Colombo district), `asset-admin`. All use the password you set in `USER_PASSWORD`. Request a token with `POST /solar/v1.0/auth/tokens`, then use **Authorize** in Swagger UI. Device keys are derived from `DEVICE_MASTER`; for installation 1 the key is `1.` plus an HMAC (see `deviceKey()` in `src/app.js`).

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `MONGODB_URI` | yes | Atlas connection string |
| `MONGODB_DB` | no | Database name, default `slsea_solar` |
| `JWT_SECRET` | yes | Signs bearer tokens |
| `DEVICE_MASTER` | yes | Derives per-installation device keys |
| `USER_PASSWORD` | yes | Password for the four built-in accounts |
| `PORT` | no | Default `8787` |
| `PUBLIC_BASE_URL` | no | Public origin for `Link` and `Location` headers behind a proxy |
| `SKIP_SCHEMA_SETUP` | no | `true` skips index/validator creation at start-up |

The server stops with a clear message if a required variable is missing. There are no built-in default secrets.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Start the API |
| `npm run dev` | Start with automatic restart on file changes |
| `npm run seed` | Load or complete the synthetic dataset. `npm run seed -- --reset` first drops the application's collections |
| `npm run secrets` | Print random secrets for `.env` |
| `npm test` | Run the regression suite against an **in-memory MongoDB stand-in** (no database needed) |
| `npm run test:atlas` | Run the same suite against **real Atlas** in a temporary database that is dropped afterwards |
| `npm run verify:live -- --origin=URL` | HTTP checks against a running instance (uses `USER_PASSWORD` and `DEVICE_MASTER` from `.env`) |
| `npm run openapi` | Regenerate `openapi.json` |

Run `npm run test:atlas` once after setting up Atlas: it exercises the real driver, indexes, validators and transactions.

## Docker

```sh
docker build -t slsea-api .
docker run --rm -p 8787:8787 --env-file .env slsea-api
```

The container only needs outbound access to Atlas, so add the host's IP address to Atlas **Network Access**.

## Deploying to a Node host

Any host that runs Node 22 works (Render, Railway, Fly.io, a VM, and so on): build command `npm install`, start command `npm start`, set the environment variables above, and add the host's outbound IP address to Atlas **Network Access**. Run `npm run seed` once from your own machine against the same `MONGODB_URI`.

## Data model

Integer identifiers are kept (stored in `_id`), so URLs, device keys and JSON bodies are the same as before.

| Collection | Documents | Notes |
|---|---|---|
| `provinces`, `districts`, `grid_substations` | reference data | Unique names; indexes on parent ids |
| `installations` | 200 + any created through the API | Unique `meter_id`; carries `district_id` and `province_id` copied from its substation, which replaces the SQL joins for jurisdiction scoping; `version` drives `If-Match` |
| `readings` | 134 600 + ingested readings | `timestamp` is a BSON date; unique index on `(installation_id, timestamp)`; index on `(timestamp, _id)` |
| `users` | 4 | Unique `username` |
| `counters` | `installations`, `readings` | Atomic auto-increment, like `AUTOINCREMENT` |

Indexes and `$jsonSchema` validators are created at start-up by `src/schema.js` (they replace `drizzle/0000_solar_schema.sql`).

## Conversion notes (what replaced what)

| Cloudflare D1 version | Node.js + MongoDB version |
|---|---|
| `worker/index.js` with SQL strings | `src/app.js` (HTTP logic, unchanged behaviour) + `src/store.js` (all MongoDB queries) |
| `env.DB.prepare(...)` | `store` methods using the official `mongodb` driver |
| Wrangler, `wrangler.jsonc`, `.cloudflare/`, `dist/` bundle step | Plain `node src/server.js`; Swagger assets are read from `vendor/` at start-up |
| `scripts/local-server.mjs` (SQLite) | `src/http.js` (Node HTTP adapter) + `src/server.js` |
| `drizzle/*.sql` migrations | `src/schema.js` |
| `INSERT ... WHERE NOT EXISTS ... ON CONFLICT DO NOTHING` for reading ingestion | A MongoDB transaction that checks the neighbouring readings and inserts; the unique index rejects duplicates |
| Foreign keys and `ON DELETE RESTRICT` | Application checks inside the same per-installation transaction |
| Triggers making `readings` append-only | The API has no route that changes or deletes readings (PUT/DELETE/PATCH return 405). See hardening below |
| `/maintenance/bootstrap` and `/maintenance/seed` HTTP endpoints, `BOOTSTRAP_KEY` | `npm run seed` talks to MongoDB directly; the endpoints and `BOOTSTRAP_KEY` no longer exist |
| `scripts/seed-live.mjs`, `cloudflare-credentials.mjs`, `build*.mjs`, `bundle.mjs`, `validate-artifact.mjs` | Removed (not needed) |
| `tests/api.test.mjs` on SQLite | Same checks over HTTP on MongoDB (or the in-memory stand-in) |

Intentional behaviour differences:

- `POST /auth/tokens` returns 401 if `username` is not a string (this blocks MongoDB operator injection such as `{"$ne": null}`).
- A `PUT` whose `substation_id` is the string `"1"` is treated as the number 1. The D1 version treated it as a move and bumped the version.
- A database outage returns 503 instead of 500, and token validation no longer reports database errors as 401.
- `/health` reports an approximate `seed_reading_count` (from collection metadata, so it is cheap to call).
- `Link` and `Location` headers use the request's `Host` (or `PUBLIC_BASE_URL`) instead of a fixed `localhost:8787`.

## Requirements and limits

- MongoDB **transactions require a replica set**. Atlas clusters are replica sets. A standalone local `mongod` will fail on reading ingestion and asset changes with "Transaction numbers are only allowed on a replica set member"; use Atlas or a single-node replica set.
- The generation summary issues three indexed lookups per installation in the district (in parallel), which is fine at this scale.
- Prototype limitations carried over from the original: no password hashing (one shared `USER_PASSWORD`), no device-key rotation, no login throttling, offset pagination.

## Optional hardening: append-only readings at database level

SQLite triggers could block `UPDATE`/`DELETE` on `readings`; MongoDB has none. To enforce it in the database, create an Atlas custom role that allows only `find` and `insert` on `readings` (and normal read/write on the other collections), create a second database user with that role, run `npm run seed` and the first start with the privileged user, then run the API with the restricted user and `SKIP_SCHEMA_SETUP=true`. This hardening was not tested.

## Troubleshooting

- `MongoServerSelectionError` or a start-up timeout: your IP is not in Atlas **Network Access**, the connection string is wrong, or the network blocks outbound port 27017.
- `bad auth` / `Authentication failed`: wrong database user or password (URL-encode special characters in the password).
- `Missing required environment variable(s)`: fill in `.env` (copy from `.env.example`).
- The API starts but returns empty lists: run `npm run seed`.
- The log line "Could not apply the schema validator" is a warning only; the API validates every request itself.

## Repository layout

- `src/app.js`: routing, authentication, authorisation, validation, representations.
- `src/store.js`: every MongoDB query, plus transactions for ingestion and asset changes.
- `src/schema.js`: indexes and validators.
- `src/seed.js`: synthetic dataset (same fixture as before: 30 September to 7 October 2026 at 15-minute intervals, both boundary samples included).
- `src/http.js`, `src/server.js`, `src/mongo.js`, `src/config.js`, `src/assets.js`, `src/docs.js`: server plumbing.
- `scripts/`: `seed.mjs`, `generate-openapi.mjs`, `generate-secrets.mjs`, `verify-live.mjs`.
- `tests/`: `api.test.mjs` and `helpers/fake-mongo.js` (in-memory stand-in).
- `vendor/`: pinned Swagger UI and license. `openapi.json`: generated contract.

## Semantics

`/solar/v1.0` is the versioned API base. Readings paginate with limit 1 to 100 and non-negative offset; sorting is `timestamp` or `-timestamp`; time filters use RFC 3339 and the half-open interval [from, to). Jurisdiction predicates are always added server-side. GET returns representation ETags; `If-None-Match` can yield a bodyless 304. PUT and DELETE require `If-Match`. Installations with history cannot be moved between substations or deleted. Identical reading retries return 200; first creation returns 201 and Location; conflicting duplicate timestamps return 409, and so do readings whose cumulative counter would go backwards.

District summary uses Sri Lankan civil days and cumulative-counter deltas, discloses coverage and freshness, and excludes stale readings from current power. It also reports the last-known total separately.

## Access model

SLSEA users read only, scoped to national, provincial, or district jurisdiction. Devices authenticate with `X-Device-Key` and only POST readings for their installation. A separate administrative principal manages installation metadata; it cannot ingest generation with its bearer token. Meter identity belongs to an installation; there is no Device entity.
