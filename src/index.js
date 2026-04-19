// Trailerio Lite - Cloudflare Workers Edition
// Versão: 1.2.2 (Cache V8 - Todos os provedores restaurados)

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.2.2',
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

// ============== CONFIGURAÇÕES DE EXCEPÇÃO ==============
const PROVIDER_OVERRIDES = { 'tt0108052': { 'Rotten Tomatoes': null }, 'tt0105695': { 'IMDb': 0 } };
const APPLETV_LOCALE_OVERRIDES = { 'tt0114709': 'us', 'tt26743210': 'us' };
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
    const h = tag.match(/height="(\d+)"/)?.[1] || 0;
    const w = tag.match(/width="(\d+)"/)?.[1] || Math.round(h * 16 / 9);
    const b = tag.match(/system-bitrate="(\d+)"/)?.[1] || 0;
    return { url: m[1], width: parseInt(w), height: parseInt(h), bitrate: Math.round(parseInt(b) / 1000) };
  });
  if (videos.length === 0) return null;
  videos.sort((a, b) => b.bitrate - a.bitrate || b.width - a.width);
  return videos[0];
}

// ============== TMDB & WIKIDATA ==============
async function getTMDBMetadata(imdbId, type) {
  try {
    const findRes = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
    const findData = await findRes.json();
    let results = type === 'series' ? findData.tv_results : findData.movie_results;
    if (!results?.length) return null;
    const tmdbId = results[0].id;
    const extRes = await fetchWithTimeout(`https://api.themoviedb.org/3/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`);
    const extData = await extRes.json();
    return { title: results[0].title || results[0].name, wikidataId: extData.wikidata_id, tmdbId };
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

// ============== RESOLVERS (RESTAURADOS) ==============

async function resolveIMDb(imdbId) {
  try {
    const res = await fetchWithTimeout('https://caching.graphql.imdb.com/', {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify({ query: `query Q($c:ID!){title(id:$c){primaryVideos(first:1){edges{node{id}}}}}`, variables: { c: imdbId } })
    });
    const vidId = (await res.json())?.data?.title?.primaryVideos?.edges[0]?.node?.id;
    if (!vidId) return null;
    const pRes = await fetchWithTimeout('https://caching.graphql.imdb.com/', {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify({ query: `query Q($c:ID!){video(id:$c){playbackURLs{displayName{value}url videoMimeType}}}`, variables: { c: vidId } })
    });
    const urls = (await pRes.json())?.data?.video?.playbackURLs || [];
    const best = urls.find(u => u.displayName.value.includes('1080p')) || urls[0];
    return { url: best.url, provider: `IMDb ${best.displayName.value}` };
  } catch { return null; }
}

async function resolveAppleTVForLocale(appleId, isShow, locale) {
  try {
    const url = `https://tv.apple.com/${locale}/${isShow ? 'show' : 'movie'}/${appleId}`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const m3u8 = html.match(/https:\/\/play[^"]*\.m3u8[^"]*/)?.[0]?.replace(/&amp;/g, '&');
    return m3u8 ? { url: m3u8, provider: 'Apple TV 4K', locale } : null;
  } catch { return null; }
}

async function resolveRottenTomatoes(wikidataReady) {
  try {
    const wd = await wikidataReady;
    if (!wd.rtSlug) return null;
    const url = `https://www.rottentomatoes.com/${wd.rtSlug.startsWith('tv/') ? '' : 'm/'}${wd.rtSlug}/videos`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const file = html.match(/"file":"([^"]+theplatform\.com[^"]+)"/)?.[1];
    if (!file) return null;
    const smilRes = await fetchWithTimeout(file.split('?')[0] + '?format=SMIL', { headers: { 'Accept': 'application/smil+xml' } });
    const best = parseSMIL(await smilRes.text());
    return best ? { url: best.url, provider: `Rotten Tomatoes ${best.height}p` } : null;
  } catch { return null; }
}

async function resolveFandango(wikidataReady) {
  try {
    const wd = await wikidataReady;
    if (!wd.fandangoId) return null;
    const res = await fetchWithTimeout(`https://www.fandango.com/x-${wd.fandangoId}/movie-overview`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const mp4 = html.match(/https:\/\/video\.fandango\.com\/[^"']+\.mp4/)?.[0];
    return mp4 ? { url: mp4, provider: 'Fandango 1080p' } : null;
  } catch { return null; }
}

async function resolveMUBI(wikidataReady, tmdbMeta) {
  try {
    const wd = await wikidataReady;
    if (!wd.mubiId || !tmdbMeta?.title) return null;
    const slug = tmdbMeta.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const res = await fetchWithTimeout(`https://mubi.com/en/us/films/${slug}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const trailer = html.match(/https:\/\/trailers\.mubicdn\.net\/[^\s"']+\.mp4/)?.[0];
    return trailer ? { url: trailer, provider: 'MUBI' } : null;
  } catch { return null; }
}

// ============== MAIN RESOLVER ==============
async function resolveTrailers(imdbId, type, env, fresh = false) {
  const cacheKey = `trailer:v8:${imdbId}`;

  // 1. KV FIRST - Resposta Instantânea
  if (!fresh && env.KV) {
    const cached = await env.KV.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  // 2. FETCH DATA IN PARALLEL
  const tmdbMeta = await getTMDBMetadata(imdbId, type);
  const wikidataReady = getWikidataIds(tmdbMeta?.wikidataId);

  const [imdb, apple, rt, fandango, mubi] = await Promise.all([
    resolveIMDb(imdbId),
    wikidataReady.then(wd => resolveAppleTVForLocale(wd.appleTvId, wd.isAppleTvShow, 'pt')),
    resolveRottenTomatoes(wikidataReady),
    resolveFandango(wikidataReady),
    resolveMUBI(wikidataReady, tmdbMeta)
  ]);

  const links = [apple, rt, fandango, mubi, imdb]
    .filter(r => r !== null)
    .map((r, i) => ({ trailers: r.url, provider: i === 0 ? `⭐ ${r.provider}` : r.provider }));

  const result = { title: tmdbMeta?.title || imdbId, links };

  if (links.length > 0 && env.KV) {
    await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL });
  }
  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (url.pathname === '/health') return new Response(JSON.stringify({ status: 'ok', hasKV: !!env.KV }), { headers: cors });
    const metaMatch = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const imdbId = metaMatch[2].split(':')[0];
      const result = await resolveTrailers(imdbId, metaMatch[1], env, url.searchParams.has('fresh'));
      return new Response(JSON.stringify({ meta: { id: imdbId, type: metaMatch[1], name: result.title, links: result.links } }), { headers: cors });
    }
    return new Response('Not Found', { status: 404 });
  }
};
