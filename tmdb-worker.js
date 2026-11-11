/**
 * Cloudflare Worker: private TMDB API proxy for the static T Movies site.
 * Required secret: TMDB_API_KEY
 * Required variable: ALLOWED_ORIGIN (for example https://yourname.github.io)
 * Deploy with: wrangler secret put TMDB_API_KEY
 */
const TMDB_ORIGIN = 'https://api.themoviedb.org/3';

function corsHeaders(origin, allowedOrigin) {
  const allowed = allowedOrigin === '*' || origin === allowedOrigin;
  return {
    'Access-Control-Allow-Origin': allowed ? (allowedOrigin === '*' ? '*' : allowedOrigin) : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || '';
    const cors = corsHeaders(origin, allowedOrigin);

    if (request.method === 'OPTIONS') {
      if (allowedOrigin !== '*' && origin !== allowedOrigin) return new Response('Origin not allowed', { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    if (allowedOrigin !== '*' && origin !== allowedOrigin) return new Response('Origin not allowed', { status: 403, headers: cors });
    if (!env.TMDB_API_KEY) return new Response('TMDB_API_KEY secret is not configured', { status: 503, headers: cors });

    // The static site calls: /tmdb/3/movie/popular?language=en-US
    if (!url.pathname.startsWith('/tmdb/3/')) return new Response('Not found', { status: 404, headers: cors });
    const path = url.pathname.slice('/tmdb/3/'.length);
    if (!path || path.includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(path)) return new Response('Invalid TMDB path', { status: 400, headers: cors });

    const upstream = new URL(`${TMDB_ORIGIN}/${path}`);
    url.searchParams.forEach((value, key) => {
      if (key !== 'api_key') upstream.searchParams.set(key, value);
    });
    upstream.searchParams.set('api_key', env.TMDB_API_KEY);

    try {
      const response = await fetch(upstream.toString(), {
        headers: { 'Accept': 'application/json' },
        cf: { cacheTtl: 900, cacheEverything: true }
      });
      const headers = new Headers(response.headers);
      Object.entries(cors).forEach(([key, value]) => headers.set(key, value));
      headers.set('Cache-Control', 'public, max-age=300, s-maxage=900');
      headers.delete('Set-Cookie');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'TMDB upstream unavailable' }), {
        status: 502,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }
};
