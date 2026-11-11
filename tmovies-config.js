/*
 * T MOVIES private-site configuration.
 * Uses the TMDB API key supplied in the original website.
 * A key in browser JavaScript is visible to anyone who can access the site.
 * Use the included Cloudflare Worker proxy for stronger protection.
 */
window.TMOVIES_CONFIG = Object.freeze({
  tmdbProxyUrl: '',
  tmdbApiKey: '0c41ce83090e2dee6ceb11530d57a9e3'
});
