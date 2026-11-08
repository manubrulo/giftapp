# Regalos

Self-hosted gift wishlists for a household. The app uses profile-based sessions, product link previews, editable wishlists, alternatives, and surprise reservations.

## Run locally

Requirements: Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm dev:server
```

In a second terminal, run `pnpm dev:web` and open `http://localhost:5173`.

The API listens on port `3000`. `DATA_DIR` selects where SQLite and downloaded product images are stored; it defaults to `./data`. `PORT` changes the API port.

## Install on TrueNAS SCALE

The local [`docker-compose.yml`](docker-compose.yml) builds from the current source directory, so it is for running from a checkout. TrueNAS Apps' YAML installer needs a container image it can pull. Build and push the image to a registry first, then use [`truenas-compose.yml`](truenas-compose.yml).

### Update the frontend without rebuilding the app image

The server serves static frontend files from a mounted directory. On first start, if that directory has no `index.html`, the container copies the frontend bundled in its image into it. This makes a fresh deployment self-contained and seeds the persistent host directory. For frontend-only updates, build locally with `pnpm build` and copy the contents of `dist/web` into the mounted directory; the server reads files on each request, so no container restart is needed. Replace assets first and `index.html` last. Keep the backend API compatible with the frontend version; API or database changes still require an app image update. The mounted directory must be writable by the container user (`568:568` on TrueNAS).

1. Build and publish a Linux image to a container registry you control. For GitHub Container Registry, from this project directory run (replace the username and choose a version tag):

   ```sh
   docker buildx build --platform linux/amd64 -t ghcr.io/YOUR_GITHUB_USERNAME/giftapp:latest --push .
   ```

   Make that GHCR package public if you want TrueNAS to pull it without registry credentials. If your TrueNAS machine is ARM64, build for `linux/arm64` instead. Keep the same tag in the YAML below, or publish a versioned tag and use that.

2. In TrueNAS, create a dataset or directory for persistent app data, for example `/mnt/tank/apps/giftapp`. GiftApp stores both the SQLite database and downloaded thumbnails under `/data`, so this mount is essential for preserving the list when the container is updated or recreated. The YAML runs as UID/GID `568:568` (the usual TrueNAS Apps identity); grant that identity write access to the dataset.

3. Open **Apps > Discover > Custom App > ⋮ > Install via YAML**. Set the app name to `giftapp`, paste the contents of `truenas-compose.yml`, and replace `ghcr.io/your-github-username/giftapp:latest` and `/mnt/YOUR_POOL/apps/giftapp` with your image and dataset path. If port 3000 is already in use, change the left side of `3000:3000`, for example `3005:3000`.

4. Save and wait for the app to start. Open `http://TRUENAS_IP:3000` (or the alternate host port you chose). On first use, create the household's first profile; it becomes the admin. Back up the dataset regularly or enable TrueNAS snapshots to protect the database and images.

These are the current TrueNAS Apps steps for deploying a Compose YAML custom app; menu labels can vary slightly by TrueNAS release. See the official [installing custom apps guide](https://apps.truenas.com/managing-apps/installing-custom-apps/) and [Custom App YAML screen reference](https://www.truenas.com/docs/scale/26/apps/installcustomappscreens/).

## Probe product links through the API

With GiftApp running and a profile session active in its database, send one or more URLs without using the UI:

```sh
pnpm probe:scrape https://shop.example/product https://another-shop.example/item
```

The script calls the authenticated `POST /api/scrape` endpoint sequentially and prints each API response plus `imageDownloaded`. Add `--add` to also create wishlist entries through `POST /api/items`; those entries are marked with category `Prueba de extracción`, and an existing item with the same URL is updated instead of duplicated. Use `pnpm probe:scrape --cleanup` to delete all wishes with that test category. Preview images that were downloaded remain in `DATA_DIR/images`, just as they do after a normal preview. Set `API_BASE_URL` if GiftApp is not at `http://127.0.0.1:3000`.

### Reverse proxy under a URL prefix

GiftApp supports being served at `/` or from a subdirectory. For the Caddy `handle /giftapp/*` configuration, set `BASE_PATH=/giftapp` in the container environment. Keep the prefix on the upstream request (do not use `handle_path`); the server removes the configured prefix internally. The TrueNAS compose example already sets this value. The app uses relative frontend assets, API requests, and image paths, so the same image can be mounted at either location.

## Check the project

```sh
pnpm typecheck
pnpm test
pnpm build
```

The tests exercise profile and PIN flows, wishlist and alternative CRUD, claim ownership, URL metadata parsing, and SSRF rejection. The owner wishlist endpoint deliberately does not query the `claims` table, and its response remains identical when another profile reserves one of the owner’s items.

## Product behavior

- Profiles have optional 4–8 digit PINs. PINs are stored as scrypt hashes; sessions use an HTTP-only cookie. The first profile on a fresh install is an administrator. Existing databases are upgraded by making their oldest profile an administrator if no admin exists.
- Members can edit their name, avatar, and PIN, and clear their own complete wishlist. Administrators can edit profile details, reset or remove PINs, promote members, and remove profiles. At least one administrator must remain; admins cannot delete or demote themselves from the admin panel.
- Adding a product starts with any HTTP or HTTPS URL. The server attempts JSON-LD, Open Graph, and page fallbacks; the preview remains editable before saving.
- Wishlist owners can manage items and alternatives. Other signed-in profiles can view lists and reserve one item each; visitor views show the buyer’s name.
- Owners never receive reservation state, buyer names, counts, or other fields derived from claims.
- URL and image requests reject private, loopback, link-local, and reserved addresses, including after redirects. Product images are saved locally.
- If a store blocks the local fetch or returns incomplete metadata, the app can optionally ask Iframely for a generic link preview. Configure `IFRAMELY_API_KEY` in the environment before starting the server (or add it to the `.env` file used by Docker Compose). Only the product URL is sent to Iframely; the user's wishlist and profile data are not. The fallback is off when no key is configured, and Iframely may still be unable to preview some stores.

## Project files

The handoff notes remain in [`regalos-handoff/`](regalos-handoff/); this project root is the active app and contains its package lockfile and Docker files.
