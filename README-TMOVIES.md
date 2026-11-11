# T MOVIES — Dark Cinema Edition

**Website name:** T MOVIES  
**Creator credit:** Omi  
**Design direction:** Immersive dark cinema / neon editorial  
**Hosting:** GitHub Pages (static, multi-page)

T MOVIES is a multi-page movie-discovery and personal-archive website. It uses the existing vanilla HTML/CSS/JavaScript approach rather than introducing a frontend framework or build system.

## What changed

- Rebuilt the interface around a deep midnight palette with violet, electric cyan, rose and warm gold accents.
- Introduced a layered typography system: Bebas Neue for cinematic display headings, Playfair Display for editorial contrast, Space Grotesk for interface text, Syne for branding and IBM Plex Mono for metadata.
- Replaced hash-based single-page navigation with real, bookmarkable HTML pages.
- Added restrained cinematic motion: hero image transitions, scroll reveals, subtle parallax, button magnetism, poster depth, and browser-supported cross-page transitions.
- Kept the creator credit discreet in the footer only; no owner watermark, hero signature or creator metadata is displayed.
- Reworked the responsive layouts for mobile, including a dedicated mobile navigation menu and reduced-motion support.
- Added a live, site-wide TMDB poster mural mixing trending movies and TV series, plus an expanded eight-poster cinematic hero collage.
- Added layered parallax, cursor-follow lighting, subtle magnetic controls, scroll-driven mural movement, poster tilt, neon edge lighting and animated image transitions.

## Website pages

| File | Purpose |
|---|---|
| `index.html` | Cinematic homepage and featured discovery |
| `discover.html` | Genre-led discovery and trending films |
| `movies.html` | Movie browsing and sorting |
| `series.html` | TV series discovery and archive series |
| `movie.html?id=TMDB_ID` | Movie details, cast, trailers and verified Drive match |
| `series-details.html?id=TMDB_ID` | TV details and series archive match |
| `genre.html?id=GENRE_ID&name=GENRE_NAME` | Genre collection |
| `search.html?q=QUERY` | Dedicated search results page |
| `my-list.html` | Saved movies and archive titles |
| `archive.html?folder=DRIVE_FOLDER_ID` | Existing Google Drive folder and episode browsing |
| `watch.html?id=DRIVE_FILE_ID` | Google Drive playback and download access |

The navigation uses actual document URLs. Movie and series details, search results, genres, archive folders and watch pages can be bookmarked or opened directly.

## Preserved integrations and browser data

The existing Google Apps Script endpoint remains unchanged. The site reads the existing shared Drive folders and videos; it does not write to, replace, migrate or invent Drive links.

The existing localStorage keys and data shapes are retained:

- `tm_index`
- `tm_history`
- `tm_favs`
- `tm_tmdb`
- `tm_art2`
- `tm_fcache`
- `tm_cats`
- `tm_genres`
- `tm_epview`

The Drive matching flow uses the existing indexed file IDs and TMDB filename verification. A Watch action is only offered when a sufficiently strong match is found. Playback uses the same Google Drive preview URL pattern and download links point to the same file ID. Existing cache data and watch history remain in the browser.

A redacted reference copy of the original uploaded HTML is in `backup/`. It is included for comparison only; do not use it as the live homepage.

## TMDB setup and key security

The uploaded original HTML contained the TMDB API key that you asked to keep using. The same key is configured in `tmovies-config.js` for this private-use build. Because it is sent from the browser, it is visible to anyone who can access the site. If the key has been exposed outside your intended audience, rotate it in TMDB and update the config. For stronger protection, the included Cloudflare Worker proxy can be configured instead:

1. Install Node.js and Wrangler if they are not already installed:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
2. From this folder, deploy the Worker:
   ```bash
   wrangler deploy
   ```
3. Add the TMDB key as a Worker secret:
   ```bash
   wrangler secret put TMDB_API_KEY
   ```
4. In Cloudflare → Workers & Pages → your Worker → Settings → Variables and Secrets, add `ALLOWED_ORIGIN` with the exact website origin, such as `https://YOUR-USERNAME.github.io`. Do not include a repository path or trailing slash. For a custom domain, use that domain's origin.
5. Set the Worker URL in `tmovies-config.js`, retaining the `/tmdb/3` suffix:
   ```js
   window.TMOVIES_CONFIG = Object.freeze({
     tmdbProxyUrl: 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/tmdb/3',
     tmdbApiKey: ''
   });
   ```
6. Keep the TMDB key only in the Worker secret. Never commit it to GitHub or put it in `tmovies-config.js`.

The current build works directly with the supplied key when `tmdbProxyUrl` is blank. If you configure the Worker URL, the Worker takes precedence and the browser key can be set to an empty string.

## Publish through GitHub Pages

1. Download and extract the project ZIP.
2. Back up the current GitHub repository before replacing files.
3. Upload the contents of this folder to the configured GitHub Pages publishing root (usually the repository root or `/docs`). Preserve the `assets/` folder structure.
4. Configure `tmovies-config.js` with your deployed Worker URL.
5. Make sure the publishing root contains `index.html`, the other `.html` pages, `tmovies-config.js`, `assets/css/site.css` and `assets/js/app.js`.
6. Commit and push the files.
7. In GitHub → Repository → Settings → Pages, confirm the correct branch and folder are selected.
8. Open the published site and test each page and integration.

No frontend package install, bundler or build command is needed. The website is static HTML/CSS/JavaScript. Wrangler is only required for the optional secure TMDB proxy.

## Verification performed in this delivery

- JavaScript syntax validation with Node.js.
- Static route audit: no hash-router navigation remains in the new app.
- Page inventory and relative asset path checks.
- Legacy localStorage key and Drive endpoint preservation checks.
- ZIP integrity validation.
- A headless browser run could not complete in the available container, so no visual browser pass is claimed. External TMDB and Drive service success must still be verified with your configured production endpoints.

## Still requiring your live environment

Only the original `tmovies.html` file was provided; the full GitHub repository, deployment configuration and Apps Script source were not supplied. Therefore this package cannot verify your real Drive permissions, TMDB account key, Cloudflare Worker deployment, or GitHub Pages settings. After configuration, verify:

- TMDB home discovery, search, movie details, genre pages, cast, trailers and similar titles.
- Drive root and nested folders, movie/series matching, playback and download.
- My List and Continue Watching using the browser that contains your existing localStorage.
- Desktop and mobile navigation and animations.
- GitHub Pages deep links for `movie.html?id=...`, `archive.html?folder=...` and `watch.html?id=...`.

## Attribution

Movie metadata and artwork are provided by TMDB. T MOVIES is an independent discovery and personal-archive interface, not an official TMDB product. The creator credit is discreetly placed in the footer only; there is no owner watermark or hidden owner-identifying code in the interface.


## Movie character artwork and motion

The homepage hero uses real TMDB backdrops and a small collage of movie poster artwork from the live trending selection. This makes the featured movie characters/artwork part of the visual composition without baking in unrelated stock images or fabricating poster URLs. Detail pages also use each title's TMDB backdrop and cast profiles.

Desktop-only motion includes a soft pointer-follow light, subtle cursor parallax, magnetic buttons, poster tilt, and scroll-driven orbit/poster movement. Mobile simplifies these effects, and `prefers-reduced-motion` disables them.

## Private-site note

GitHub Pages does not provide built-in password protection for a published site. A private GitHub repository does not automatically make its Pages website private. Google Drive files still depend on their existing sharing permissions. The TMDB API key in `tmovies-config.js` is browser-visible; use the included Worker proxy if you need to keep it server-side.


## Dark cinema visual system

The current design uses midnight black/navy surfaces, ultraviolet, electric cyan, rose and gold accents. Typography has distinct roles: Bebas Neue for high-impact cinematic display headings, Playfair Display for editorial headings, Space Grotesk for body/UI, Syne for the T MOVIES brand and IBM Plex Mono for technical labels and metadata.

Every page has a subtle dynamic background mural populated from TMDB trending movies and TV series. The homepage adds a larger collage of eight posters mixing films and series. These images are loaded from TMDB at runtime; they are not fabricated local assets.

Desktop interactions include pointer tracking, a soft cursor glow, hero parallax, magnetic buttons, poster tilt, scroll-driven movement and layered image transitions. On mobile, the mural and motion are simplified. `prefers-reduced-motion` is respected.
