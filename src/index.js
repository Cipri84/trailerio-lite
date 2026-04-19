// Trailerio Lite - Cloudflare Workers Edition
// KV storage, Parallelized resolving
// Versão: 1.2.1 (Cache V7)

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.2.1',
  name: 'Trailerio',
  description: 'Trailer addon - Fandango, Apple TV, Rotten Tomatoes, MUBI, IMDb',
  logo: 'https://raw.githubusercontent.com/9mousaa/trailerio-lite/main/icon.png',
  resources: [{ name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 172800; // 48 horas
const TMDB_API_KEY = 'bfe73358661a995b992ae9a812aa0d2f';

// ============== CONFIGURAÇÕES ==============

const PROVIDER_OVERRIDES = {
  'tt0108052': { 'Rotten Tomatoes': null },
  'tt0105695': { 'IMDb': 0 }
};

const APPLETV_LOCALE_OVERRIDES = {
  'tt0114709': 'us',
  'tt26743210': 'us'
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

async function fetchWithTimeout(url, options = {}, timeout = 2500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

function parseSMIL(smilXml) {
  const videoTags = [...smilXml.matchAll(/<video[^>]+src="(https:\/\/video\.fandango\.com[^"]+\.mp4)"[^>]*/g)];
  const videos = videoTags.map(m => {
    const tag = m[0];
    const heightMatch = tag.match(/height="(\d+)"/);
    const height = heightMatch ? parseInt(heightMatch[1]) : 0;
    const widthMatch = tag.match(/width="(\d+)"/);
    const width = widthMatch ? parseInt(widthMatch[1]) : Math.round(height * 16 / 9);
    const bitrateMatch = tag.match(/system-bitrate="(\d+)"/);
    return { url: m[1], width, height, bitrate: bitrateMatch ? Math.round(parseInt(bitrateMatch[1]) / 1000) : 0 };
  });
  if (videos.length === 0) return null;
  videos.sort((a, b) => b.bitrate - a.bitrate || b.width - a.width);
  return videos[0];
}

// ============== METADATA & SOURCES ==============

async function getTMDBMetadata(imdbId, type) {
  try {
    const findRes = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
    const findData = await findRes.json();
    let results = type === 'series' ? findData.tv_results : findData.movie_results;
    if (!results?.length) return null;
    const tmdbId = results[0].id;
    const extRes = await fetchWithTimeout(`https://api.themoviedb.org/3/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`);
    const extData = await extRes.json();
    return { title: results[0].title || results[0].name, wikidataId: extData.wikidata_id };
  } catch { return null; }
}

async function getWikidataIds(wikidataId) {
  if (!wikidataId) return {};
  try {
    const res = await fetchWithTimeout(`https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    const entity = data.entities?.[wikidataId];
    return {
      appleTvId: entity?.claims?.P9586?.[0]?.mainsnak?.datavalue?.value || entity?.claims?.P9751?.[0]?.mainsnak?.datavalue?.value,
      isAppleTvShow: !!entity?.claims?.P9751,
      rtSlug: entity?.claims?.P1258?.[0]?.mainsnak?.datavalue?.value,
      fandangoId: entity?.claims?.P5693?.[0]?.mainsnak?.datavalue?.value,
      mubiId: entity?.claims?.P7299?.[0]?.mainsnak?.datavalue?.value
    };
  } catch { return {}; }
}

async function resolveIMDb(imdbId) {
  try {
    const headers = { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' };
    const res = await fetchWithTimeout('https://caching.graphql.imdb.com/', {
      method: 'POST', headers, body: JSON.stringify({
        query: `query Q($c:ID!){title(id:$c){primaryVideos(first:1){edges{node{id}}}}}`,
        variables: { c: imdbId }
      })
    });
    const vidId = (await res.json())?.data?.title?.primaryVideos?.edges[0]?.node?.id;
    if (!vidId) return null;
    const pRes = await fetchWithTimeout('https://caching.graphql.imdb.com/', {
      method: 'POST', headers, body: JSON.stringify({
        query: `query Q($c:ID!){video(id:$c){playbackURLs{displayName{value}url videoMimeType}}}`,
        variables: { c: vidId }
      })
    });
    const urls = (await pRes.json())?.data?.video?.playbackURLs || [];
    const best = urls.find(u => u.displayName.value.includes('1080p')) || urls[0];
    return { url: best.url, provider: `IMDb ${best.displayName.value}` };
  } catch { return null; }
}

async function resolveAppleTV(appleId, isShow, locale = 'pt') {
  if (!appleId) return null;
  try {
    const url = `https://tv.apple.com/${locale}/${isShow ? 'show' : 'movie'}/${appleId}`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const m3u8 = html.match(/https:\/\/play[^"]*\.m3u8[^"]*/)?.[0]?.replace(/&amp;/g, '&');
    return m3u8 ? { url: m3u8, provider: 'Apple TV 4K', locale } : null;
  } catch { return null; }
}

// ============== MAIN RESOLVER ==============

async function resolveTrailers(imdbId, type, env, fresh = false) {
  const cacheKey = `trailer:v7:${imdbId}`; // Versão V7 para reset

  // 1. Tenta KV imediatamente (Resposta Instantânea se existir)
  if (!fresh && env.KV) {
    const cached = await env.KV.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  // 2. Se não estiver na cache, acelera a primeira vez correndo tudo em paralelo
  const tmdbMetaPromise = getTMDBMetadata(imdbId, type);
  const imdbPromise = resolveIMDb(imdbId);

  // Precisamos do TMDB para chegar à Wikidata e depois aos outros
  const tmdbMeta = await tmdbMetaPromise;
  const wikidata = await getWikidataIds(tmdbMeta?.wikidataId);

  const applePromise = resolveAppleTV(wikidata.appleTvId, wikidata.isAppleTvShow, 'pt');
  
  // Corre as outras fontes
  const [imdbResult, appleResult] = await Promise.all([imdbPromise, applePromise]);

  const links = [];
  if (appleResult) links.push({ trailers: appleResult.url, provider: `⭐ ${appleResult.provider}` });
  if (imdbResult) links.push({ trailers: imdbResult.url, provider: imdbResult.provider });

  const result = {
    title: tmdbMeta?.title || imdbId,
    links: links
  };

  // 3. Guarda no KV para a próxima vez
  if (links.length > 0 && env.KV) {
    await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL });
  }

  return result;
}

// ============== HANDLER ==============

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

    if (url.pathname === '/health') 
      return new Response(JSON.stringify({ status: 'ok', hasKV: !!env.KV }), { headers: cors });

    const metaMatch = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;
      const imdbId = id.split(':')[0];
      const result = await resolveTrailers(imdbId, type, env, url.searchParams.has('fresh'));
      
      return new Response(JSON.stringify({
        meta: { id: imdbId, type, name: result.title, links: result.links }
      }), { headers: cors });
    }

    return new Response('Not Found', { status: 404 });
  }
};
