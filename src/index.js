// Trailerio Lite - Cloudflare Workers Edition (IMDb Stable + Overrides Completos v60)

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.2.0',
  name: 'Trailerio',
  description: 'Trailer addon - Fandango, Apple TV, Rotten Tomatoes, Plex, MUBI, IMDb',
  logo: 'https://raw.githubusercontent.com/9mousaa/trailerio-lite/main/icon.png',
  resources: [{ name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 172800; 
const TMDB_API_KEY = 'bfe73358661a995b992ae9a812aa0d2f';

// ============== CONFIGURAÇÕES DE EXCEPÇÃO ==============

const PROVIDER_OVERRIDES = {
  'tt0108052': { 'Rotten Tomatoes': null },          // Schindler's List - RT removido (vírgula corrigida)
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

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function fetchWithTimeout(url, options = {}, timeout = 2000) { 
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

// ============== SMIL PARSER ==============

function parseSMIL(smilXml) {
  const videoTags = [...smilXml.matchAll(/<video[^>]+src="(https:\/\/video\.fandango\.com[^"]+\.mp4)"[^>]*/g)];
  const videos = videoTags.map(m => {
    const tag = m[0];
    const heightMatch = tag.match(/height="(\d+)"/);
    const bitrateMatch = tag.match(/system-bitrate="(\d+)"/);
    const height = heightMatch ? parseInt(heightMatch[1]) : 0;
    return { url: m[1], height, bitrate: bitrateMatch ? Math.round(parseInt(bitrateMatch[1]) / 1000) : 0 };
  });
  if (videos.length === 0) return null;
  videos.sort((a, b) => b.bitrate - a.bitrate);
  return videos[0];
}

// ============== TMDB METADATA ==============

async function getTMDBMetadata(imdbId, type = 'movie') {
  try {
    const findRes = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`, {}, 1500);
    const findData = await findRes.json();
    let results = type === 'series' ? findData.tv_results : findData.movie_results;
    if (!results || results.length === 0) results = findData.movie_results || findData.tv_results;
    if (!results || results.length === 0) return null;

    const actualType = results[0].title ? 'movie' : 'tv';
    const extRes = await fetchWithTimeout(`https://api.themoviedb.org/3/${actualType}/${results[0].id}/external_ids?api_key=${TMDB_API_KEY}`, {}, 1500);
    const extData = await extRes.json();

    return { tmdbId: results[0].id, title: results[0].title || results[0].name, wikidataId: extData.wikidata_id, actualType: actualType === 'tv' ? 'series' : 'movie' };
  } catch (e) { return null; }
}

async function getWikidataIds(wikidataId) {
  if (!wikidataId) return {};
  try {
    const res = await fetchWithTimeout(`https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`, { headers: { 'Accept': 'application/json', 'User-Agent': 'TrailerioLite/1.0' } }, 2000);
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

// ============== SOURCE RESOLVERS ==============

async function resolveAppleTVForLocale(appleId, isShow, locale) {
  try {
    const pageUrl = `https://tv.apple.com/${locale}/${isShow ? 'show' : 'movie'}/${appleId}`;
    const pageRes = await fetchWithTimeout(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 2000);
    const html = await pageRes.text();
    const hls = html.match(/https:\/\/play[^"]*\.m3u8[^"]*/)?.[0].replace(/&amp;/g, '&');
    return hls ? { url: hls, provider: 'Apple TV', height: 2160, locale } : null;
  } catch (e) { return null; }
}

async function resolveAppleTV(imdbId, wikidataIdsPromise) {
  const idOverride = APPLETV_ID_OVERRIDES[imdbId];
  if (idOverride) return await resolveAppleTVForLocale(idOverride.id, false, idOverride.locale);
  const w = await wikidataIdsPromise;
  if (!w?.appleTvId) return null;
  const pt = await resolveAppleTVForLocale(w.appleTvId, w.isAppleTvShow, 'pt');
  return pt || await resolveAppleTVForLocale(w.appleTvId, w.isAppleTvShow, 'us');
}

async function resolvePlex(imdbId, tmdbMetaPromise) {
  try {
    const [tokenRes, tmdbMeta] = await Promise.all([
      fetchWithTimeout('https://plex.tv/api/v2/users/anonymous', { method: 'POST', headers: { 'X-Plex-Client-Identifier': 'trailerio-lite' } }, 1500),
      tmdbMetaPromise
    ]);
    const { authToken } = await tokenRes.json();
    const matchRes = await fetchWithTimeout(`https://metadata.provider.plex.tv/library/metadata/matches?type=${tmdbMeta?.actualType === 'series' ? 2 : 1}&guid=imdb://${imdbId}`, { headers: { 'X-Plex-Token': authToken } }, 1500);
    const plexId = (await matchRes.json()).MediaContainer?.Metadata?.[0]?.ratingKey;
    if (!plexId) return null;
    const extrasRes = await fetchWithTimeout(`https://metadata.provider.plex.tv/library/metadata/${plexId}/extras`, { headers: { 'X-Plex-Token': authToken } }, 1500);
    const trailer = (await extrasRes.json()).MediaContainer?.Metadata?.find(m => m.subtype === 'trailer');
    return trailer?.Media?.[0]?.url ? { url: trailer.Media[0].url, provider: 'Plex 1080p', height: 1080 } : null;
  } catch (e) { return null; }
}

async function resolveRottenTomatoes(wikidataIdsPromise) {
  try {
    const w = await wikidataIdsPromise;
    if (!w?.rtSlug) return null;
    const res = await fetchWithTimeout(`https://www.rottentomatoes.com/${w.rtSlug.replace(/^(m|tv)\//, '')}/videos`, {}, 2000);
    const html = await res.text();
    const scriptMatch = html.match(/<script\s+id="videos"[^>]*>([\s\S]*?)<\/script>/i);
    const trailer = JSON.parse(scriptMatch[1]).find(v => v.videoType === 'TRAILER' && v.file?.includes('theplatform'));
    const smilRes = await fetchWithTimeout(trailer.file.split('?')[0] + '?format=SMIL', {}, 1500);
    const best = parseSMIL(await smilRes.text());
    return best ? { url: best.url, provider: `Rotten Tomatoes ${best.height}p`, height: best.height } : null;
  } catch (e) { return null; }
}

async function resolveFandango(wikidataIdsPromise) {
  try {
    const w = await wikidataIdsPromise;
    if (!w?.fandangoId) return null;
    const res = await fetchWithTimeout(`https://www.fandango.com/x-${w.fandangoId}/movie-overview`, {}, 2000);
    const tpMatch = (await res.text()).match(/(https:\/\/link\.theplatform\.com\/s\/[^"'\s?]+)/);
    const smilRes = await fetchWithTimeout(tpMatch[1] + '?format=SMIL&formats=mpeg4', {}, 1500);
    const best = parseSMIL(await smilRes.text());
    return best ? { url: best.url, provider: `Fandango ${best.height}p`, height: best.height } : null;
  } catch (e) { return null; }
}

async function resolveMUBI(wikidataIdsPromise, tmdbMetaPromise) {
  try {
    const [w, t] = await Promise.all([wikidataIdsPromise, tmdbMetaPromise]);
    if (!w?.mubiId || !t?.title) return null;
    const res = await fetchWithTimeout(`https://mubi.com/en/us/films/${t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, {}, 2000);
    const url = (await res.text()).match(/https:\/\/trailers\.mubicdn\.net\/[^"']+\.mp4/);
    return url ? { url: url[0], provider: 'MUBI 1080p', height: 1080 } : null;
  } catch (e) { return null; }
}

const IMDB_GQL_HEADERS = {
  'accept': 'application/graphql+json, application/json',
  'content-type': 'application/json',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'origin': 'https://www.imdb.com',
  'referer': 'https://www.imdb.com/',
  'x-imdb-client-name': 'imdb-web-next-localized',
};

async function resolveIMDb(imdbId) {
  try {
    const galleryRes = await fetchWithTimeout('https://caching.graphql.imdb.com/', { 
      method: 'POST', headers: IMDB_GQL_HEADERS, 
      body: JSON.stringify({ query: `query Q($c:ID!){title(id:$c){primaryVideos(first:5){edges{node{id contentType{displayName{value}}}}}}}`, variables: { c: imdbId }})
    }, 1800);
    const edges = (await galleryRes.json())?.data?.title?.primaryVideos?.edges || [];
    const vidId = edges.find(e => /trailer/i.test(e.node?.contentType?.displayName?.value))?.node?.id || edges[0]?.node?.id;
    if (!vidId) return null;

    const playbackRes = await fetchWithTimeout('https://caching.graphql.imdb.com/', { 
      method: 'POST', headers: IMDB_GQL_HEADERS, 
      body: JSON.stringify({ query: `query Q($c:ID!){video(id:$c){playbackURLs{displayName{value}url videoMimeType}}}`, variables: { c: vidId }})
    }, 1800);
    const urls = (await playbackRes.json())?.data?.video?.playbackURLs?.filter(u => u.videoMimeType?.includes('mp4')) || [];
    const best = urls.find(u => u.displayName?.value?.includes('1080p')) || urls[0];
    return best ? { url: best.url, provider: 'IMDb 1080p', height: 1080 } : null;
  } catch (e) { return null; }
}

// ============== MAIN RESOLVER ==============

async function resolveTrailers(imdbId, type, cache, fresh = false) {
  const cacheKey = `trailer:v60:${imdbId}`;
  if (!fresh) {
    const cached = await cache.match(new Request(`https://cache/${cacheKey}`));
    if (cached) return await cached.json();
  }

  const tmdbReady = deferred();
  const wikidataReady = deferred();

  const metaPipeline = (async () => {
    const tmdbMeta = await getTMDBMetadata(imdbId, type);
    tmdbReady.resolve(tmdbMeta);
    const wikidataIds = tmdbMeta?.wikidataId ? await getWikidataIds(tmdbMeta.wikidataId) : {};
    wikidataReady.resolve(wikidataIds);
    return { tmdbMeta, wikidataIds };
  })();

  const [imdb, apple, plex, rt, fandango, mubi, meta] = await Promise.all([
    resolveIMDb(imdbId), resolveAppleTV(imdbId, wikidataReady.promise),
    resolvePlex(imdbId, tmdbReady.promise), resolveRottenTomatoes(wikidataReady.promise),
    resolveFandango(wikidataReady.promise), resolveMUBI(wikidataReady.promise, tmdbReady.promise),
    metaPipeline
  ]);

  const overrides = PROVIDER_OVERRIDES[imdbId] || {};
  const order = (r) => {
    for (const [name, val] of Object.entries(overrides)) { if (r.provider.includes(name) && val !== null) return val; }
    if (r.provider.includes('Apple TV') && r.locale === 'pt') return 10;
    if (r.provider.includes('Apple TV')) return 11;
    if (r.provider.includes('IMDb')) return 12;
    return 13 + (2160 - r.height);
  };

  const links = [imdb, apple, plex, rt, fandango, mubi]
    .filter(r => r && !overrides[Object.keys(overrides).find(k => r.provider.includes(k))] === null)
    .sort((a, b) => order(a) - order(b))
    .map((r, i) => ({ trailers: r.url, provider: i === 0 ? `⭐ ${r.provider}` : r.provider }));

  const result = { title: meta.tmdbMeta?.title || imdbId, links };
  if (links.length) await cache.put(new Request(`https://cache/${cacheKey}`), new Response(JSON.stringify(result), { headers: { 'Cache-Control': `max-age=${CACHE_TTL}` } }));
  return result;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (url.pathname === '/manifest.json') return new Response(JSON.stringify(MANIFEST), { headers: cors });
    const match = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (match) {
      const res = await resolveTrailers(match[2].split(':')[0], match[1], caches.default, url.searchParams.has('fresh'));
      return new Response(JSON.stringify({ meta: { id: match[2].split(':')[0], type: match[1], name: res.title, links: res.links } }), { headers: cors });
    }
    return new Response(null, { status: 404 });
  }
};
