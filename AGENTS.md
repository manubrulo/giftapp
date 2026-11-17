# Project overview

- Run GiftApp, a self-hosted household gift wishlist with profile sessions, family visibility, product previews, alternatives, and surprise reservations.
- Keep the Fastify API, SQLite data layer, and React client compatible; the same app serves at `/` or under `BASE_PATH`.

# Structure and architecture

- `src/server/index.ts`: Fastify app, authentication, profile/family/item/claim/notification routes, static frontend serving, and server startup.
- `src/server/db.ts`: SQLite connection, schema creation, and in-place migrations. Database file: `${DATA_DIR}/regalos.db`.
- `src/server/scrape.ts`: product metadata and image fetching, SSRF protections, image storage, and optional Iframely fallback.
- `src/web/`: React/Vite client; `api.ts` builds API and image URLs relative to the app mount point.
- `scripts/dev.mjs`: starts server and Vite together. `scripts/probe-scrape.ts`: authenticated CLI for probing product links.
- `Dockerfile`: builds the web bundle and runs the server. `docker-compose.yml` is for a source checkout; `truenas-compose.yml` is a registry-image example.
- Data flow: browser calls `/api/*`; Fastify validates profile/family ownership and reads/writes SQLite; scrape requests fetch remote metadata/images and persist image files under `${DATA_DIR}/images`; Fastify serves local images and frontend assets.
- Preserve the privacy invariant in `src/server/index.ts` and `src/server/db.ts`: owner wishlist reads must never query, join, count, or expose `claims` data. Buyer views may include reservation identity.

# Stack

- TypeScript, ESM, Node.js 22+; pnpm 10 is pinned in Docker and CI. `pnpm-lock.yaml` is authoritative.
- Fastify `^5.12.7`, `@fastify/cookie` `^11.0.0`, `@fastify/static` `^10.1.8`, `better-sqlite3` `^13.0.3`, `tsx` `^4.19.0`.
- React/React DOM `^19.0.0`, Vite `^6.4.5`, React Vite plugin `^4.3.0`, Tailwind CSS and Vite plugin `^4.0.0`, TypeScript `^5.6.0`.
- SQLite is the only configured database. Optional external preview service: Iframely, enabled by `IFRAMELY_API_KEY`.
- CI uses GitHub Actions, Docker Buildx/QEMU, and publishes multi-platform images to GHCR.

# Local development

- Install Node.js 22 or newer and pnpm 10; install dependencies with `pnpm install`.
- Run both development processes with `pnpm dev`, or run API and Vite in separate terminals:

  ```sh
  pnpm install
  pnpm dev
  ```

- Open `http://localhost:5173`; Vite proxies `/api/` to `http://localhost:3000`.
- Configure environment variables by name only:
  - `DATA_DIR`: SQLite database and downloaded images directory; defaults to `./data`.
  - `PORT`: API listen port; defaults to `3000`.
  - `WEB_DIR`: optional frontend directory to serve instead of bundled `dist/web`.
  - `BASE_PATH`: optional absolute URL prefix such as `/giftapp`; reverse proxies must preserve the prefix upstream.
  - `IFRAMELY_API_KEY`: optional key for generic link-preview fallback.
  - `NODE_ENV`: disables Fastify logging when set to `test`; Docker sets `production`.
  - `API_BASE_URL`: probe script only; defaults to `http://127.0.0.1:3000`.
- Run build, typecheck, and tests with:

  ```sh
  pnpm build
  pnpm typecheck
  pnpm test
  ```

- Run the product-link probe with `pnpm probe:scrape <url> [url…]`; `--add` creates/updates test-category wishes and `--cleanup` deletes those wishes. The script reads the latest session token from the same `DATA_DIR` database.
- No lint or formatter script/config is present. TODO: confirm preferred lint/format tools if they are introduced.

# Deployment

- GitHub Actions workflow `.github/workflows/ci-publish.yml` validates on pushes to `main`/`master`, `v*` tags, pull requests, and manual dispatch. It runs install, typecheck, tests, and build before publishing.
- On non-PR workflow runs, publish `ghcr.io/<repository-owner>/giftapp` for `linux/amd64` and `linux/arm64`; default-branch pushes create `latest`, tags create their ref tag, and all builds get a SHA tag.
- `docker-compose.yml` builds from the checkout and mounts `./data` plus `./frontend`; Docker Compose can load optional `IFRAMELY_API_KEY` from `.env`.
- For TrueNAS, build/push an image and install `truenas-compose.yml` through Apps YAML. Replace the image and host dataset paths; preserve writable `568:568` access to `/data` and `/frontend`.
- Back up the persistent data directory; it contains SQLite and downloaded images. On first start, an empty mounted frontend directory is seeded from the image.
- For frontend-only updates, build with `pnpm build`, copy `dist/web` contents to the mounted frontend directory, and replace `index.html` last. Keep backend API compatibility. API/database changes require an image update.
- TODO: no automated deployment target, staging environment, or rollback procedure is specified. Document the operator's actual registry and recovery steps before changing deployment guidance.

# Release versioning

- `package.json` is the version source (`0.3.0` at this checkout); Vite embeds it in the frontend.
- Git history uses `v`-prefixed tags through `v0.3.0`; CI publishes a matching image tag for `v*` tags.
- TODO: the repository does not document the version bump process, release-note process, or exact action that creates tags/releases. Do not infer these from the tags alone.

# Changelog

- No `CHANGELOG` file or changelog automation is present.
- TODO: confirm whether releases require a changelog and, if so, the file format and section/entry rules before adding one.

# Conventions and working rules

- Match existing TypeScript style: strict mode, ESM imports, single quotes, semicolons, and small focused modules. No lint/format automation is configured.
- Add or update Node test-runner tests alongside server changes (`src/server/*.test.ts`); existing tests cover app behavior, scraping, and database migrations. CI requires `pnpm typecheck`, `pnpm test`, and `pnpm build` to pass.
- Use `codex/` branch prefixes when creating task branches; observed history uses pull requests and merge commits. TODO: no formal commit-message or PR template/policy is checked in.
- Preserve schema compatibility: `src/server/db.ts` performs startup migrations directly. Add migrations in a way that supports existing `regalos.db` installations; never assume a fresh database.
- Keep URL fetching protections in `src/server/scrape.ts`: validate public addresses and redirects, enforce size/time limits, and store downloaded images locally. Do not bypass these checks.
- Keep image/static paths relative-compatible with `BASE_PATH`; test any changes to API, asset URLs, or static serving at a prefixed mount.
- Do not commit `.env`, `data/`, `dist/`, `node_modules/`, or the ignored `regalos-handoff/` directory. `.codex/environments/environment.toml` is autogenerated; do not edit it manually.
- Avoid changing `claims` access in owner-only paths; reservation privacy is a documented and tested product guarantee.
