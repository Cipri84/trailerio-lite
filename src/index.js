// Trailerio Lite - Ultra Fast (Apple TV PT Priority)
const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.6.0',
  name: 'Trailerio Pro',
  description: 'Prioridade: Apple TV (PT > US) & IMDb',
  logo: 'https://raw.githubusercontent.com/9mousaa/trailerio-lite/main/icon.png',
  resources: [{ name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 172800;
const META_CACHE_TTL = 604800; // 1 semana para IDs de metadados
const TMDB_API_KEY = 'bfe73358661a995b992ae9a812aa0d2f';

// ============== CONFIGURAÇÕES ==============
const APPLETV_ID_OVERRIDES = {
  'tt22022452': { id: 'umc.cmc.1i9m3zsyxnwssydez7vjeax6l', locale: 'pt' },
  'tt13622970': { id: 'umc.cmc.6a0vv8bp0aa4fij9rn6fak8lt', locale: 'pt' },
  'tt29623480': { id: 'umc.cmc.3vk9rngh0rrmpnyhv2qwzm582', locale: 'pt' },
};

// ============== UTILITIES ==============
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function fetchWithTimeout(url, options = {}, timeout = 1500) {
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
  const res = await fetchWithTimeout(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 1500);
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/https:\/\/play[^"]*\.m3u8[^"]*/);
  return m ? { url: m[0].replace(/&amp;/g, '&'), provider: `Apple TV`, height: 1080, locale } : null;
}

async function resolveAppleTV(imdbId, wikidataPromise) {
  // 1. Verificar Overrides primeiro (Velocidade máxima)
  if (APPLETV_ID_OVERRIDES[imdbId]) {
    const ov = APPLETV_ID_OVERRIDES[imdbId];
    return resolveAppleTVForLocale(ov.id, false, ov.locale);
  }

  // 2. Esperar pelos IDs do Wikidata
  const w = await wikidataPromise;
  if (!w?.appleTvId) return null;

  // 3. PRIORIDADE PT PRIMEIRO
  const pt = await resolveAppleTVForLocale(w.appleTvId, w.isAppleTvShow, 'pt');
  if (pt) return pt;

  // 4. PRIORIDADE US SEGUNDO
  return await resolveAppleTVForLocale(w.appleTvId, w.isAppleTvShow, 'us');
}

async function resolveIMDb(imdbId) {
  const res = await fetchWithTimeout('https://caching.graphql.imdb.com/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `query Q($c:ID!){title(id:$c){primaryVideos(first:1){edges{node{id}}}}}`, variables: { c: imdbId } })
  }, 1200);
  
  const data = await res.json();
  const vidId = data?.data?.title?.primaryVideos?.edges?.[0]?.node?.id;
  if (!vidId) return null;

  const pRes = await fetchWithTimeout('https://caching.graphql.imdb.com/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `query Q($c:ID!){video(id:$c){playbackURLs{url}}}`, variables: { c: vidId } })
  }, 1000);
  
  const pData = await pRes.json();
  const url = pData?.data?.video?.playbackURLs?.[0]?.url;
  return url ? { url, provider: 'IMDb', height: 1080 } : null;
}

// ============== MAIN ==============

async function resolveTrailers(imdbId, type, env, ctx, fresh = false) {
  const cacheKey = `trailer:v100:${imdbId}`;
  const metaCacheKey = `meta:v100:${imdbId}`;

  // Se estiver em cache, devolve imediatamente
  if (!fresh && env.KV) {
    const cached = await env.KV.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const wikidataReady = deferred();
  
  // Pipeline de Metadados com Cache Interno para IDs
  const metaPipeline = (async () => {
    try {
      // Tentar carregar IDs da cache para saltar o Wikidata
      if (env.KV) {
        const cachedMeta = await env.KV.get(metaCacheKey);
        if (cachedMeta) {
          const m = JSON.parse(cachedMeta);
          wikidataReady.resolve(m.wIds);
          return m.title;
        }
      }

      const res = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`, {}, 1200);
      const data = await res.json();
      const movie = data.movie_results?.[0] || data.tv_results?.[0];
      if (!movie) { wikidataReady.resolve({}); return imdbId; }

      const title = movie.title || movie.name;

      const ext = await fetchWithTimeout(`https://api.themoviedb.org/3/${movie.title ? 'movie' : 'tv'}/${movie.id}/external_ids?api_key=${TMDB_API_KEY}`, {}, 1000);
      const extData = await ext.json();
      
      if (!extData.wikidata_id) { wikidataReady.resolve({}); return title; }

      const wiki = await fetchWithTimeout(`https://www.wikidata.org/wiki/Special:EntityData/${extData.wikidata_id}.json`, {}, 1800);
      const wData = await wiki.json();
      const ent = wData.entities?.[extData.wikidata_id];
      
      const wIds = {
        appleTvId: ent?.claims?.P9586?.[0]?.mainsnak?.datavalue?.value || ent?.claims?.P9751?.[0]?.mainsnak?.datavalue?.value,
        isAppleTvShow: !!ent?.claims?.P9751
      };

      wikidataReady.resolve(wIds);
      
      // Guardar metadados em background
      ctx.waitUntil(env.KV.put(metaCacheKey, JSON.stringify({ title, wIds }), { expirationTtl: META_CACHE_TTL }));
      
      return title;
    } catch { wikidataReady.resolve({}); return imdbId; }
  })();

  // Corrida: Apple TV e IMDb em paralelo
  // Nota: resolveAppleTV vai esperar internamente pelo wikidataReady.promise
  const [imdb, apple, title] = await Promise.all([
    resolveIMDb(imdbId),
    resolveAppleTV(imdbId, wikidataReady.promise),
    metaPipeline
  ]);

  // Montar lista respeitando a tua ordem
  const links = [];
  if (apple) links.push({ trailers: apple.url, provider: `⭐ Apple TV` });
  if (imdb) links.push({ trailers: imdb.url, provider: apple ? `IMDb` : `⭐ IMDb` });

  const result = { title, links };

  if (links.length > 0 && env.KV) {
    ctx.waitUntil(env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL }));
  }
  return result;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    
    if (url.pathname === '/manifest.json') return new Response(JSON.stringify(MANIFEST), { headers: cors });

    const match = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (match) {
      const imdbId = match[2].split(':')[0];
      const res = await resolveTrailers(imdbId, match[1], env, ctx, url.searchParams.has('fresh'));
      return new Response(JSON.stringify({ 
        meta: { id: imdbId, type: match[1], name: res.title, links: res.links } 
      }), {
        headers: { ...cors, 'Cache-Control': 'public, max-age=172800, stale-while-revalidate=86400' }
      });
    }
    return new Response('Not Found', { status: 404 });
  }
};
