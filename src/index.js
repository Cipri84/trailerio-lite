// Trailerio Lite - Ultra Fast Edition
const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.3.0',
  name: 'Trailerio (Fast)',
  description: 'Trailer addon - Apple TV, RT, Fandango, IMDb',
  resources: [{ name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 172800;
const META_CACHE_TTL = 432000;
const TMDB_API_KEY = 'bfe73358661a995b992ae9a812aa0d2f';

// ============== CONFIGURAÇÕES ==============
const PROVIDER_OVERRIDES = {
  'tt0108052': { 'Rotten Tomatoes': null },
  'tt0105695': { 'IMDb': 0 }
};

const APPLETV_ID_OVERRIDES = {
  'tt22022452': { id: 'umc.cmc.1i9m3zsyxnwssydez7vjeax6l', locale: 'pt' },
  'tt13622970': { id: 'umc.cmc.6a0vv8bp0aa4fij9rn6fak8lt', locale: 'pt' },
  'tt29623480': { id: 'umc.cmc.3vk9rngh0rrmpnyhv2qwzm582', locale: 'pt' },
  'tt0468569':  { id: 'umc.cmc.1uf4c3neuc9yxhnjv7t4rd5wa', locale: 'pt' },
  'tt30017619': { id: 'umc.cmc.2ewfnaq853ueokr49pv4brr1d', locale: 'pt' },
};

// ============== UTILITIES ==============
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function fetchWithTimeout(url, options = {}, timeout = 1000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    return { ok: false, text: () => "", json: () => ({}) };
  }
}

// ============== RESOLVERS ==============

async function resolveAppleTVForLocale(appleId, isShow, locale) {
  const pageUrl = isShow ? `https://tv.apple.com/${locale}/show/${appleId}` : `https://tv.apple.com/${locale}/movie/${appleId}`;
  const pageRes = await fetchWithTimeout(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 1200);
  if (!pageRes.ok) return null;
  const html = await pageRes.text();
  const hlsMatch = html.match(/https:\/\/play[^"]*\.m3u8[^"]*/);
  if (!hlsMatch) return null;
  return { url: hlsMatch[0].replace(/&amp;/g, '&'), provider: `Apple TV`, bitrate: 5000, width: 1920, height: 1080, locale };
}

async function resolveAppleTV(imdbId, wikidataIdsPromise) {
  if (APPLETV_ID_OVERRIDES[imdbId]) {
    const ov = APPLETV_ID_OVERRIDES[imdbId];
    return resolveAppleTVForLocale(ov.id, false, ov.locale);
  }
  const wikidataIds = await wikidataIdsPromise;
  if (!wikidataIds?.appleTvId) return null;
  const pt = await resolveAppleTVForLocale(wikidataIds.appleTvId, wikidataIds.isAppleTvShow, 'pt');
  return pt || resolveAppleTVForLocale(wikidataIds.appleTvId, wikidataIds.isAppleTvShow, 'us');
}

async function resolveIMDb(imdbId) {
  const res = await fetchWithTimeout('https://caching.graphql.imdb.com/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
    body: JSON.stringify({
      query: `query Q($c:ID!){title(id:$c){primaryVideos(first:1){edges{node{id}}}}}`,
      variables: { c: imdbId }
    })
  }, 1000);
  const vidId = (await res.json())?.data?.title?.primaryVideos?.edges?.[0]?.node?.id;
  if (!vidId) return null;

  const pRes = await fetchWithTimeout('https://caching.graphql.imdb.com/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query Q($c:ID!){video(id:$c){playbackURLs{url}}}`,
      variables: { c: vidId }
    })
  }, 800);
  const url = (await pRes.json())?.data?.video?.playbackURLs?.[0]?.url;
  return url ? { url, provider: 'IMDb', bitrate: 0, width: 0, height: 1080 } : null;
}

// ============== MAIN ==============

async function resolveTrailers(imdbId, type, env, ctx, fresh = false) {
  const cacheKey = `trailer:v95:${imdbId}`;
  if (!fresh && env.KV) {
    const cached = await env.KV.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const wikidataReady = deferred();
  const tmdbReady = deferred();

  // Pipeline de Metadados acelerado
  const metaPipeline = (async () => {
    const res = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`, {}, 1000);
    const data = await res.json();
    const movie = data.movie_results?.[0] || data.tv_results?.[0];
    if (!movie) { wikidataReady.resolve({}); return null; }
    
    tmdbReady.resolve(movie.title || movie.name);
    
    const ext = await fetchWithTimeout(`https://api.themoviedb.org/3/${movie.title ? 'movie' : 'tv'}/${movie.id}/external_ids?api_key=${TMDB_API_KEY}`, {}, 800);
    const extData = await ext.json();
    
    if (!extData.wikidata_id) { wikidataReady.resolve({}); return movie.title; }

    const wiki = await fetchWithTimeout(`https://www.wikidata.org/wiki/Special:EntityData/${extData.wikidata_id}.json`, {}, 1200);
    const wData = await wiki.json();
    const ent = wData.entities?.[extData.wikidata_id];
    
    const wIds = {
      appleTvId: ent?.claims?.P9586?.[0]?.mainsnak?.datavalue?.value || ent?.claims?.P9751?.[0]?.mainsnak?.datavalue?.value,
      isAppleTvShow: !!ent?.claims?.P9751
    };
    wikidataReady.resolve(wIds);
    return movie.title || movie.name;
  })();

  const [imdb, apple, title] = await Promise.all([
    resolveIMDb(imdbId),
    resolveAppleTV(imdbId, wikidataReady.promise),
    metaPipeline
  ]);

  const links = [apple, imdb].filter(Boolean).map((r, i) => ({
    trailers: r.url,
    provider: i === 0 ? `⭐ ${r.provider}` : r.provider
  }));

  const result = { title: title || imdbId, links };

  if (links.length > 0 && env.KV) {
    ctx.waitUntil(env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL }));
  }

  return result;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/manifest.json') return new Response(JSON.stringify(MANIFEST), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

    const metaMatch = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const imdbId = metaMatch[2].split(':')[0];
      const result = await resolveTrailers(imdbId, metaMatch[1], env, ctx, url.searchParams.has('fresh'));
      return new Response(JSON.stringify({ meta: { id: imdbId, type: metaMatch[1], name: result.title, links: result.links } }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=172800, stale-while-revalidate=86400' }
      });
    }
    return new Response('Not Found', { status: 404 });
  }
};
