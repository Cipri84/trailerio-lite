// Trailerio Lite - Cloudflare Workers Edition (Base Plex Estável v57)

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.2.0',
  name: 'Trailerio',
  description: 'Trailer addon - Fandango, Apple TV, Rotten Tomatoes, MUBI, IMDb, Plex',
  logo: 'https://raw.githubusercontent.com/9mousaa/trailerio-lite/main/icon.png',
  resources: [{ name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 172800; // 48 horas
const TMDB_API_KEY = 'bfe73358661a995b992ae9a812aa0d2f';

// ============== CONFIGURAÇÕES DE EXCEPÇÃO ==============

const PROVIDER_OVERRIDES = {
  'tt0108052': { 'Rotten Tomatoes': null },          // Schindler's List - RT indisponível
  'tt0105695': { 'IMDb': 0 }                         // Unforgiven - IMDb em primeiro
};

const APPLETV_LOCALE_OVERRIDES = { 
  'tt0114709': 'us',   // Toy Story 1995
  'tt26743210': 'us'   // How to Train Your Dragon
};

const APPLETV_ID_OVERRIDES = {
  'tt22022452': { id: 'umc.cmc.1i9m3zsyxnwssydez7vjeax6l', locale: 'pt' },  // Inside Out 2
  'tt13622970': { id: 'umc.cmc.6a0vv8bp0aa4fij9rn6fak8lt', locale: 'pt' },  // Vaiana 2
  'tt29623480': { id: 'umc.cmc.3vk9rngh0rrmpnyhv2qwzm582', locale: 'pt' },  // Robot Selvagem
  'tt30017619': { id: 'umc.cmc.2ewfnaq853ueokr49pv4brr1d', locale: 'pt' },  // Os Mauzões 2
  'tt0468569': { id: 'umc.cmc.1uf4c3neuc9yxhnjv7t4rd5wa', locale: 'pt' },   // O Cavaleiro das Trevas
};

// ============== UTILITIES ==============

async function fetchWithTimeout(url, options = {}, timeout = 2500) { // Timeout otimizado para 2.5s
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

// ============== RESOLVERS ==============

async function resolveIMDb(imdbId) {
  try {
    const headers = { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' };
    const g1 = await fetchWithTimeout('https://caching.graphql.imdb.com/', { method: 'POST', headers, body: JSON.stringify({ query: `query Q($c:ID!){title(id:$c){primaryVideos(first:1){edges{node{id}}}}}`, variables: { c: imdbId }}) });
    const vidId = (await g1.json()).data?.title?.primaryVideos?.edges[0]?.node?.id;
    if (!vidId) return null;
    const g2 = await fetchWithTimeout('https://caching.graphql.imdb.com/', { method: 'POST', headers, body: JSON.stringify({ query: `query Q($c:ID!){video(id:$c){playbackURLs{displayName{value}url videoMimeType}}}`, variables: { c: vidId }}) });
    const urls = (await g2.json()).data?.video?.playbackURLs?.filter(u => u.videoMimeType.includes('mp4'));
    const best = urls.find(u => u.displayName.value.includes('1080p')) || urls[0];
    return { url: best.url, provider: `IMDb ${best.displayName.value}`, height: 1080 };
  } catch (e) { return null; }
}

async function resolvePlex(imdbId) {
  try {
    const login = await fetchWithTimeout('https://users.plex.tv/users/sign_in.json', { method: 'POST', headers: { 'X-Plex-Client-Identifier': 'trailerio' } });
    const token = (await login.json()).user?.authToken;
    const search = await fetchWithTimeout(`https://metadata.provider.plex.tv/library/metadata/matches?guid=com.plexapp.agents.imdb%3A%2F%2F${imdbId}%3Flang%3Den&X-Plex-Token=${token}`);
    const ratingKey = (await search.text()).match(/ratingKey="(\d+)"/)?.[1];
    if (!ratingKey) return null;
    const meta = await fetchWithTimeout(`https://metadata.provider.plex.tv/library/metadata/${ratingKey}?X-Plex-Token=${token}`);
    const video = (await meta.text()).match(/<Video[^>]+url="(https:[^"]+)"[^>]+subtype="trailer"/);
    return video ? { url: video[1], provider: 'Plex 1080p', height: 1080 } : null;
  } catch (e) { return null; }
}

async function resolveAppleTV(imdbId, wikidataPromise) {
  const idOverride = APPLETV_ID_OVERRIDES[imdbId];
  const w = await wikidataPromise;
  const appleId = idOverride?.id || w?.appleTvId;
  if (!appleId) return null;

  const resolveLocale = async (loc) => {
    try {
      const res = await fetchWithTimeout(`https://tv.apple.com/${loc}/movie/${appleId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const hls = (await res.text()).match(/https:\/\/play[^"]*\.m3u8[^"]*/)?.[0].replace(/&amp;/g, '&');
      return hls ? { url: hls, provider: 'Apple TV', height: 2160, locale: loc } : null;
    } catch { return null; }
  };
  return (await resolveLocale(idOverride?.locale || 'pt')) || (await resolveLocale('us'));
}

async function resolveRottenTomatoes(wikidataPromise) {
  try {
    const w = await wikidataPromise;
    if (!w?.rtSlug) return null;
    const res = await fetchWithTimeout(`https://www.rottentomatoes.com/${w.rtSlug}/videos`);
    const match = (await res.text()).match(/<script\s+id="videos"[^>]*>([\s\S]*?)<\/script>/i);
    const trailer = JSON.parse(match[1]).find(v => v.videoType === 'TRAILER' && v.file?.includes('theplatform'));
    const smil = await fetchWithTimeout(trailer.file.split('?')[0] + '?format=SMIL');
    const best = parseSMIL(await smil.text());
    return best ? { url: best.url, provider: `Rotten Tomatoes ${best.height}p`, height: best.height } : null;
  } catch { return null; }
}

async function resolveFandango(wikidataPromise) {
  try {
    const w = await wikidataPromise;
    if (!w?.fandangoId) return null;
    const res = await fetchWithTimeout(`https://www.fandango.com/x-${w.fandangoId}/movie-overview`);
    const tp = (await res.text()).match(/(https:\/\/link\.theplatform\.com\/s\/[^"'\s?]+)/);
    const smil = await fetchWithTimeout(tp[1] + '?format=SMIL&formats=mpeg4');
    const best = parseSMIL(await smil.text());
    return best ? { url: best.url, provider: `Fandango ${best.height}p`, height: best.height } : null;
  } catch { return null; }
}

async function resolveMUBI(wikidataPromise, title) {
  try {
    const w = await wikidataPromise;
    if (!w?.mubiId) return null;
    const res = await fetchWithTimeout(`https://mubi.com/en/us/films/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    const url = (await res.text()).match(/https:\/\/trailers\.mubicdn\.net\/[^"']+\.mp4/);
    return url ? { url: url[0], provider: 'MUBI 1080p', height: 1080 } : null;
  } catch { return null; }
}

// ============== MAIN ==============

async function resolveTrailers(imdbId, type, cache) {
  const cacheKey = `trailer:v57:${imdbId}`;
  const cached = await cache.match(new Request(`https://cache/${cacheKey}`));
  if (cached) return await cached.json();

  const findRes = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
  const tmdb = (await findRes.json()).movie_results?.[0] || (await findRes.json()).tv_results?.[0];
  
  const wikidataPromise = tmdb ? fetchWithTimeout(`https://api.themoviedb.org/3/${tmdb.title ? 'movie' : 'tv'}/${tmdb.id}/external_ids?api_key=${TMDB_API_KEY}`)
    .then(r => r.json())
    .then(ext => fetchWithTimeout(`https://www.wikidata.org/wiki/Special:EntityData/${ext.wikidata_id}.json`, { headers: { 'User-Agent': 'Mozilla/5.0' } }))
    .then(r => r.json())
    .then(d => {
      const e = Object.values(d.entities)[0];
      return {
        appleTvId: e.claims?.P9586?.[0]?.mainsnak?.datavalue?.value || e.claims?.P9751?.[0]?.mainsnak?.datavalue?.value,
        rtSlug: e.claims?.P1258?.[0]?.mainsnak?.datavalue?.value,
        fandangoId: e.claims?.P5693?.[0]?.mainsnak?.datavalue?.value,
        mubiId: e.claims?.P7299?.[0]?.mainsnak?.datavalue?.value
      };
    }) : Promise.resolve({});

  const [imdb, plex, apple, rt, fandango, mubi] = await Promise.all([
    resolveIMDb(imdbId), resolvePlex(imdbId), resolveAppleTV(imdbId, wikidataPromise),
    resolveRottenTomatoes(wikidataPromise), resolveFandango(wikidataPromise),
    resolveMUBI(wikidataPromise, tmdb?.title || tmdb?.name || '')
  ]);

  const overrides = PROVIDER_OVERRIDES[imdbId] || {};
  const order = (r) => {
    for (const [n, o] of Object.entries(overrides)) { if (r.provider.includes(n) && o !== null) return o; }
    if (r.provider.includes('Apple TV') && r.locale === 'pt') return 10;
    if (r.provider.includes('Apple TV')) return 11;
    if (r.provider.includes('IMDb')) return 12;
    if (r.provider.includes('Plex')) return 13;
    if (r.provider.includes('MUBI')) return 14;
    return 15 + (2160 - r.height);
  };

  const links = [imdb, plex, apple, rt, fandango, mubi]
    .filter(r => r && !(overrides[Object.keys(overrides).find(k => r.provider.includes(k))] === null))
    .sort((a, b) => order(a) - order(b))
    .map((r, i) => ({ trailers: r.url, provider: i === 0 ? `⭐ ${r.provider}` : r.provider }));

  const res = { title: tmdb?.title || tmdb?.name || imdbId, links };
  if (links.length) await cache.put(new Request(`https://cache/${cacheKey}`), new Response(JSON.stringify(res), { headers: { 'Cache-Control': `max-age=${CACHE_TTL}` } }));
  return res;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (url.pathname === '/manifest.json') return new Response(JSON.stringify(MANIFEST), { headers: cors });
    const match = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (match) {
      const res = await resolveTrailers(match[2].split(':')[0], match[1], caches.default);
      return new Response(JSON.stringify({ meta: { id: match[2], type: match[1], name: res.title, links: res.links } }), { headers: cors });
    }
    return new Response(null, { status: 404 });
  }
};
