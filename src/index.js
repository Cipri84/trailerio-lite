// Trailerio Lite - Cloudflare Workers Edition (Optimized v55)

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.2.0',
  name: 'Trailerio',
  description: 'Trailer addon - Fandango, Apple TV, Rotten Tomatoes, MUBI, IMDb',
  logo: 'https://raw.githubusercontent.com/9mousaa/trailerio-lite/main/icon.png',
  resources: [{ name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 172800; // 48 hours
const TMDB_API_KEY = 'bfe73358661a995b992ae9a812aa0d2f';

// ============== CONFIGURAÇÕES DE EXCEPÇÃO ==============

const PROVIDER_OVERRIDES = {
  'tt0108052': { 'Rotten Tomatoes': null },          // Schindler's List - RT incorreto ou indisponível
  'tt0105695': { 'IMDb': 0 }                         // Unforgiven - IMDb em primeiro (Prioridade 0)
};

const APPLETV_LOCALE_OVERRIDES = { 
  'tt0114709': 'us',   // Toy Story 1995
  'tt26743210': 'us'   // How to Train Your Dragon
};

const APPLETV_ID_OVERRIDES = {
  'tt22022452': { id: 'umc.cmc.1i9m3zsyxnwssydez7vjeax6l', locale: 'pt' },  // Inside Out 2
  'tt13622970': { id: 'umc.cmc.6a0vv8bp0aa4fij9rn6fak8lt', locale: 'pt' },  // Vaiana 2
  'tt29623480': { id: 'umc.cmc.3vk9rngh0rrmpnyhv2qwzm582', locale: 'pt' },  // Robot Selvagem
  'tt30017619': { id: 'umc.cmc.2ewfnaq853ueokr49pv4brr1d', locale: 'pt' },   // Os Mauzões 2
  'tt0468569': { id: 'umc.cmc.1uf4c3neuc9yxhnjv7t4rd5wa', locale: 'pt' },   // O Cavaleiro das Trevas
};

// ============== UTILITIES ==============

async function fetchWithTimeout(url, options = {}, timeout = 3000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) { clearTimeout(id); throw e; }
}

function parseSMIL(smilXml) {
  const videoTags = [...smilXml.matchAll(/<video[^>]+src="(https:\/\/video\.fandango\.com[^"]+\.mp4)"[^>]*/g)];
  const videos = videoTags.map(m => {
    const tag = m[0];
    const height = tag.match(/height="(\d+)"/)?.[1] || 0;
    const bitrate = tag.match(/system-bitrate="(\d+)"/)?.[1] || 0;
    return { url: m[1], height: parseInt(height), bitrate: Math.round(parseInt(bitrate)/1000) };
  });
  return videos.sort((a, b) => b.bitrate - a.bitrate)[0];
}

// ============== METADATA ==============

async function getTMDBMetadata(imdbId, type = 'movie') {
  try {
    const findRes = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
    const findData = await findRes.json();
    let results = type === 'series' ? findData.tv_results : findData.movie_results;
    if (!results?.length) results = findData.movie_results || findData.tv_results;
    if (!results?.length) return null;
    const item = results[0];
    const extRes = await fetchWithTimeout(`https://api.themoviedb.org/3/${item.title ? 'movie' : 'tv'}/${item.id}/external_ids?api_key=${TMDB_API_KEY}`);
    const extData = await extRes.json();
    return { tmdbId: item.id, title: item.title || item.name, wikidataId: extData.wikidata_id, actualType: item.title ? 'movie' : 'series' };
  } catch (e) { return null; }
}

async function getWikidataIds(wikidataId) {
  if (!wikidataId) return {};
  try {
    const res = await fetchWithTimeout(`https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const entity = data.entities?.[wikidataId];
    return {
      appleTvId: entity?.claims?.P9586?.[0]?.mainsnak?.datavalue?.value || entity?.claims?.P9751?.[0]?.mainsnak?.datavalue?.value,
      isAppleTvShow: !!entity?.claims?.P9751?.[0]?.mainsnak?.datavalue?.value,
      rtSlug: entity?.claims?.P1258?.[0]?.mainsnak?.datavalue?.value,
      fandangoId: entity?.claims?.P5693?.[0]?.mainsnak?.datavalue?.value,
      mubiId: entity?.claims?.P7299?.[0]?.mainsnak?.datavalue?.value
    };
  } catch (e) { return {}; }
}

// ============== RESOLVERS ==============

async function resolveIMDb(imdbId) {
  try {
    const headers = { 
      'content-type': 'application/json', 
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'x-imdb-client-name': 'imdb-web-next-localized'
    };
    const query1 = { query: `query Q($c:ID!){title(id:$c){primaryVideos(first:5){edges{node{id contentType{displayName{value}}}}}}}`, variables: { c: imdbId } };
    const g1 = await fetchWithTimeout('https://caching.graphql.imdb.com/', { method: 'POST', headers, body: JSON.stringify(query1) });
    const edges = (await g1.json()).data?.title?.primaryVideos?.edges || [];
    const vidId = edges.find(e => /trailer/i.test(e.node?.contentType?.displayName?.value))?.node?.id || edges[0]?.node?.id;
    if (!vidId) return null;
    const query2 = { query: `query Q($c:ID!){video(id:$c){playbackURLs{displayName{value}url videoMimeType}}}`, variables: { c: vidId } };
    const g2 = await fetchWithTimeout('https://caching.graphql.imdb.com/', { method: 'POST', headers, body: JSON.stringify(query2) });
    const urls = (await g2.json()).data?.video?.playbackURLs?.filter(u => u.videoMimeType?.includes('mp4')) || [];
    const best = urls.find(u => u.displayName.value.includes('1080p')) || urls[0];
    return best ? { url: best.url, provider: `IMDb ${best.displayName.value}`, height: 1080 } : null;
  } catch (e) { return null; }
}

async function resolveAppleTVForLocale(appleId, isShow, locale) {
  try {
    const pageRes = await fetchWithTimeout(`https://tv.apple.com/${locale}/${isShow ? 'show' : 'movie'}/${appleId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await pageRes.text();
    const hls = html.match(/https:\/\/play[^"]*\.m3u8[^"]*/)?.[0].replace(/&amp;/g, '&');
    return hls ? { url: hls, provider: 'Apple TV', height: 2160, locale } : null;
  } catch (e) { return null; }
}

async function resolveAppleTV(imdbId, wikidataPromise) {
  const idOverride = APPLETV_ID_OVERRIDES[imdbId];
  if (idOverride) return await resolveAppleTVForLocale(idOverride.id, false, idOverride.locale);
  const w = await wikidataPromise;
  if (!w?.appleTvId) return null;
  const pt = await resolveAppleTVForLocale(w.appleTvId, w.isAppleTvShow, 'pt');
  return pt || await resolveAppleTVForLocale(w.appleTvId, w.isAppleTvShow, 'us');
}

async function resolveRottenTomatoes(wikidataPromise) {
  try {
    const w = await wikidataPromise;
    if (!w?.rtSlug) return null;
    const pageRes = await fetchWithTimeout(`https://www.rottentomatoes.com/${w.rtSlug.startsWith('tv/') ? 'tv' : 'm'}/${w.rtSlug.replace(/^(m|tv)\//, '')}/videos`);
    const scriptMatch = (await pageRes.text()).match(/<script\s+id="videos"[^>]*>([\s\S]*?)<\/script>/i);
    const trailer = JSON.parse(scriptMatch[1]).find(v => v.videoType === 'TRAILER' && v.file?.includes('theplatform'));
    const smilRes = await fetchWithTimeout(trailer.file.split('?')[0] + '?format=SMIL');
    const best = parseSMIL(await smilRes.text());
    return best ? { url: best.url, provider: `Rotten Tomatoes ${best.height}p`, height: best.height } : null;
  } catch (e) { return null; }
}

async function resolveFandango(wikidataPromise) {
  try {
    const w = await wikidataPromise;
    if (!w?.fandangoId) return null;
    const res = await fetchWithTimeout(`https://www.fandango.com/x-${w.fandangoId}/movie-overview`);
    const tpMatch = (await res.text()).match(/(https:\/\/link\.theplatform\.com\/s\/[^"'\s?]+)/);
    const smilRes = await fetchWithTimeout(tpMatch[1] + '?format=SMIL&formats=mpeg4');
    const best = parseSMIL(await smilRes.text());
    return best ? { url: best.url, provider: `Fandango ${best.height}p`, height: best.height } : null;
  } catch (e) { return null; }
}

async function resolveMUBI(wikidataPromise, tmdbPromise) {
  try {
    const [w, t] = await Promise.all([wikidataPromise, tmdbPromise]);
    if (!w?.mubiId || !t?.title) return null;
    const res = await fetchWithTimeout(`https://mubi.com/en/us/films/${t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    const match = (await res.text()).match(/https:\/\/trailers\.mubicdn\.net\/[^"']+\.mp4/);
    return match ? { url: match[0], provider: 'MUBI 1080p', height: 1080 } : null;
  } catch (e) { return null; }
}

// ============== MAIN ==============

async function resolveTrailers(imdbId, type, cache, fresh = false) {
  const cacheKey = `trailer:v55:${imdbId}`; // Versão v55 para nova cache
  if (!fresh) {
    const cached = await cache.match(new Request(`https://cache/${cacheKey}`));
    if (cached) return await cached.json();
  }
  const tmdbMetaPromise = getTMDBMetadata(imdbId, type);
  const wikidataPromise = tmdbMetaPromise.then(m => getWikidataIds(m?.wikidataId));
  const [imdb, apple, rt, fandango, mubi, tmdb] = await Promise.all([
    resolveIMDb(imdbId), resolveAppleTV(imdbId, wikidataPromise),
    resolveRottenTomatoes(wikidataPromise), resolveFandango(wikidataPromise),
    resolveMUBI(wikidataPromise, tmdbMetaPromise), tmdbMetaPromise
  ]);
  
  const overrides = PROVIDER_OVERRIDES[imdbId] || {};
  const providerOrder = (r) => {
    for (const [name, order] of Object.entries(overrides)) { 
      if (r.provider.includes(name) && order !== null) return order; 
    }
    if (r.provider.includes('Apple TV') && r.locale === 'pt') return 10;
    if (r.provider.includes('Apple TV')) return 11;
    if (r.provider.includes('IMDb')) return 12; // IMDb acima do MUBI
    if (r.provider.includes('MUBI')) return 13;
    return 14 + (2160 - r.height);
  };

  const links = [imdb, apple, rt, fandango, mubi]
    .filter(r => r && !(overrides[Object.keys(overrides).find(k => r.provider.includes(k))] === null))
    .sort((a, b) => providerOrder(a) - providerOrder(b))
    .map((r, i) => ({ trailers: r.url, provider: i === 0 ? `⭐ ${r.provider}` : r.provider }));

  const result = { title: tmdb?.title || imdbId, links };
  if (links.length) await cache.put(new Request(`https://cache/${cacheKey}`), new Response(JSON.stringify(result), { headers: { 'Cache-Control': `max-age=${CACHE_TTL}` } }));
  return result;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (url.pathname === '/manifest.json') return new Response(JSON.stringify(MANIFEST), { headers: cors });
    const metaMatch = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const imdbId = metaMatch[2].split(':')[0];
      const result = await resolveTrailers(imdbId, metaMatch[1], caches.default, url.searchParams.has('fresh'));
      return new Response(JSON.stringify({ meta: { id: imdbId, type: metaMatch[1], name: result.title, links: result.links } }), { headers: cors });
    }
    return new Response(null, { status: 404 });
  }
};
