// Trailerio Lite - Ultra Fast Edition
// Focado em Apple TV (PT Priority) e IMDb

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.4.0',
  name: 'Trailerio Fast',
  description: 'Trailers: Apple TV & IMDb (Ultra Fast)',
  logo: 'https://raw.githubusercontent.com/9mousaa/trailerio-lite/main/icon.png',
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
  'tt0105695': { 'IMDb': 0 }
};

const APPLETV_ID_OVERRIDES = {
  'tt22022452': { id: 'umc.cmc.1i9m3zsyxnwssydez7vjeax6l', locale: 'pt' },
  'tt13622970': { id: 'umc.cmc.6a0vv8bp0aa4fij9rn6fak8lt', locale: 'pt' },
  'tt29623480': { id: 'umc.cmc.3vk9rngh0rrmpnyhv2qwzm582', locale: 'pt' },
  'tt0468569':  { id: 'umc.cmc.1uf4c3neuc9yxhnjv7t4rd5wa', locale: 'pt' },
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
  try {
    const pageUrl = isShow 
      ? `https://tv.apple.com/${locale}/show/${appleId}` 
      : `https://tv.apple.com/${locale}/movie/${appleId}`;

    const pageRes = await fetchWithTimeout(pageUrl, { 
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } 
    }, 1200);

    if (!pageRes.ok) return null;
    const html = await pageRes.text();
    const hlsMatch = html.match(/https:\/\/play[^"]*\.m3u8[^"]*/);
    
    if (!hlsMatch) return null;
    return { 
      url: hlsMatch[0].replace(/&amp;/g, '&'), 
      provider: `Apple TV`, 
      bitrate: 5000, width: 1920, height: 1080, 
      locale 
    };
  } catch { return null; }
}

async function resolveAppleTV(imdbId, wikidataIdsPromise) {
  if (APPLETV_ID_OVERRIDES[imdbId]) {
    const ov = APPLETV_ID_OVERRIDES[imdbId];
    return resolveAppleTVForLocale(ov.id, false, ov.locale);
  }

  const wikidataIds = await wikidataIdsPromise;
  if (!wikidataIds?.appleTvId) return null;

  // Mantém a tua prioridade PT: Tenta PT primeiro, se falhar tenta US
  const pt = await resolveAppleTVForLocale(wikidataIds.appleTvId, wikidataIds.isAppleTvShow, 'pt');
  if (pt) return pt;

  return await resolveAppleTVForLocale(wikidataIds.appleTvId, wikidataIds.isAppleTvShow, 'us');
}

async function resolveIMDb(imdbId) {
  try {
    const res = await fetchWithTimeout('https://caching.graphql.imdb.com/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        query: `query Q($c:ID!){title(id:$c){primaryVideos(first:1){edges{node{id}}}}}`,
        variables: { c: imdbId }
      })
    }, 1000);
    
    const data = await res.json();
    const vidId = data?.data?.title?.primaryVideos?.edges?.[0]?.node?.id;
    if (!vidId) return null;

    const pRes = await fetchWithTimeout('https://caching.graphql.imdb.com/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query Q($c:ID!){video(id:$c){playbackURLs{url}}}`,
        variables: { c: vidId }
      })
    }, 800);
    
    const pData = await pRes.json();
    const url = pData?.data?.video?.playbackURLs?.[0]?.url;
    return url ? { url, provider: 'IMDb', bitrate: 0, width: 0, height: 1080 } : null;
  } catch { return null; }
}

// ============== MAIN RESOLVER ==============

async function resolveTrailers(imdbId, type, env, ctx, fresh = false) {
  const cacheKey = `trailer:fast:v1:${imdbId}`;
  
  if (!fresh && env.KV) {
    const cached = await env.KV.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const wikidataReady = deferred();
  
  const metaPipeline = (async () => {
    try {
      const res = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`, {}, 900);
      const data = await res.json();
      const movie = data.movie_results?.[0] || data.tv_results?.[0];
      
      if (!movie) { 
        wikidataReady.resolve({}); 
        return imdbId; 
      }
      
      const title = movie.title || movie.name;
      
      // Busca rápida de IDs externos
      const extRes = await fetchWithTimeout(`https://api.themoviedb.org/3/${movie.title ? 'movie' : 'tv'}/${movie.id}/external_ids?api_key=${TMDB_API_KEY}`, {}, 700);
      const extData = await extRes.json();
      
      if (!extData.wikidata_id) {
        wikidataReady.resolve({});
        return title;
      }

      // Procura no Wikidata com timeout agressivo
      const wikiRes = await fetchWithTimeout(`https://www.wikidata.org/wiki/Special:EntityData/${extData.wikidata_id}.json`, {}, 1100);
      const wData = await wikiRes.json();
      const ent = wData.entities?.[extData.wikidata_id];
      
      wikidataReady.resolve({
        appleTvId: ent?.claims?.P9586?.[0]?.mainsnak?.datavalue?.value || ent?.claims?.P9751?.[0]?.mainsnak?.datavalue?.value,
        isAppleTvShow: !!ent?.claims?.P9751
      });

      return title;
    } catch {
      wikidataReady.resolve({});
      return imdbId;
    }
  })();

  // Dispara as procuras principais em paralelo
  const [imdbResult, appleResult, title] = await Promise.all([
    resolveIMDb(imdbId),
    resolveAppleTV(imdbId, wikidataReady.promise),
    metaPipeline
  ]);

  const links = [appleResult, imdbResult]
    .filter(Boolean)
    .map((r, i) => ({
      trailers: r.url,
      provider: i === 0 ? `⭐ ${r.provider}` : r.provider
    }));

  const result = { title, links };

  // Cache em background (não bloqueia a resposta)
  if (links.length > 0 && env.KV) {
    ctx.waitUntil(env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL }));
  }

  return result;
}

// ============== HANDLER ==============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = { 
      'Access-Control-Allow-Origin': '*', 
      'Content-Type': 'application/json' 
    };

    if (url.pathname === '/manifest.json') {
      return new Response(JSON.stringify(MANIFEST), { headers: corsHeaders });
    }

    const metaMatch = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const imdbId = metaMatch[2].split(':')[0];
      const fresh = url.searchParams.has('fresh');

      const result = await resolveTrailers(imdbId, metaMatch[1], env, ctx, fresh);

      return new Response(JSON.stringify({
        meta: {
          id: imdbId,
          type: metaMatch[1],
          name: result.title,
          links: result.links
        }
      }), {
        headers: {
          ...corsHeaders,
          'Cache-Control': 'public, max-age=172800, stale-while-revalidate=86400'
        }
      });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders });
  }
};
