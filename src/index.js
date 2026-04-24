// Trailerio Lite - FAST PRIORITY EDITION

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '2.0.0',
  name: 'Trailerio',
  description: 'Fast priority trailer resolver',
  logo: 'https://raw.githubusercontent.com/9mousaa/trailerio-lite/main/icon.png',
  resources: [{ name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 172800;
const META_CACHE_TTL = 432000;
const TMDB_API_KEY = 'bfe73358661a995b992ae9a812aa0d2f';

// ================= OVERRIDES (INALTERADOS) =================

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
  'tt30017619': { id: 'umc.cmc.2ewfnaq853ueokr49pv4brr1d', locale: 'pt' }
};

// ================= UTIL =================

async function fetchWithTimeout(url, options = {}, timeout = 1500) {
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

// ================= TMDB + WIKIDATA =================

async function getMeta(imdbId, type) {
  try {
    const findRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );
    const data = await findRes.json();

    let r = type === 'series' ? data.tv_results : data.movie_results;
    if (!r || !r.length) return null;

    const tmdbId = r[0].id;
    const title = r[0].title || r[0].name;

    const extRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
    );
    const ext = await extRes.json();

    return { title, wikidataId: ext.wikidata_id };
  } catch {
    return null;
  }
}

async function getWikidata(wikidataId) {
  if (!wikidataId) return {};
  try {
    const res = await fetchWithTimeout(
      `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`,
      {},
      2000
    );
    const data = await res.json();
    const e = data.entities?.[wikidataId];

    return {
      appleTvId: e?.claims?.P9586?.[0]?.mainsnak?.datavalue?.value,
      rtSlug: e?.claims?.P1258?.[0]?.mainsnak?.datavalue?.value,
      fandangoId: e?.claims?.P5693?.[0]?.mainsnak?.datavalue?.value
    };
  } catch {
    return {};
  }
}

// ================= RESOLVERS (SIMPLIFICADOS + RÁPIDOS) =================

async function resolveApple(imdbId, wiki, locale) {
  try {
    const idOverride = APPLETV_ID_OVERRIDES[imdbId];
    const appleId = idOverride?.id || wiki.appleTvId;
    if (!appleId) return null;

    const loc = idOverride?.locale || locale;
    const url = `https://tv.apple.com/${loc}/movie/${appleId}`;

    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const html = await res.text();
    const m = html.match(/https:\/\/play[^"]+\.m3u8/);

    if (!m) return null;

    return {
      url: m[0],
      provider: `Apple TV ${loc === 'pt' ? 'PT' : 'US'}`,
      width: 1920,
      height: 1080,
      locale: loc
    };
  } catch {
    return null;
  }
}

async function resolveRT(wiki) {
  try {
    if (!wiki.rtSlug) return null;

    const res = await fetchWithTimeout(
      `https://www.rottentomatoes.com/m/${wiki.rtSlug.replace('m/', '')}/videos`
    );

    const html = await res.text();
    const m = html.match(/https:\/\/[^"]+\.mp4/);

    if (!m) return null;

    return {
      url: m[0],
      provider: 'Rotten Tomatoes 1080p',
      width: 1920,
      height: 1080
    };
  } catch {
    return null;
  }
}

async function resolveIMDb(imdbId) {
  try {
    const res = await fetchWithTimeout(`https://www.imdb.com/title/${imdbId}/`);
    const html = await res.text();
    const m = html.match(/https:\/\/[^"]+\.mp4/);

    if (!m) return null;

    return {
      url: m[0],
      provider: 'IMDb',
      width: 1280,
      height: 720
    };
  } catch {
    return null;
  }
}

async function resolveFandango(wiki) {
  try {
    if (!wiki.fandangoId) return null;

    const res = await fetchWithTimeout(
      `https://www.fandango.com/x-${wiki.fandangoId}/movie-overview`
    );
    const html = await res.text();

    const m = html.match(/https:\/\/video\.fandango\.com\/[^"]+\.mp4/);
    if (!m) return null;

    return {
      url: m[0],
      provider: 'Fandango 1080p',
      width: 1920,
      height: 1080
    };
  } catch {
    return null;
  }
}

// ================= CORE =================

async function resolveTrailers(imdbId, type, env, ctx, fresh = false) {
  const cacheKey = `fast:v1:${imdbId}`;
  const metaKey = `meta:v1:${imdbId}`;

  // ⚡ FAST CACHE RETURN
  if (!fresh && env.KV) {
    const cached = await env.KV.get(cacheKey);
    if (cached) {
      // refresh async
      ctx.waitUntil(resolveTrailers(imdbId, type, env, ctx, true));
      return JSON.parse(cached);
    }
  }

  // META (cache ou fetch)
  let meta = env.KV && !fresh ? await env.KV.get(metaKey) : null;
  let parsedMeta = meta ? JSON.parse(meta) : await getMeta(imdbId, type);

  const wiki = parsedMeta?.wikidataId
    ? await getWikidata(parsedMeta.wikidataId)
    : {};

  // ================= PRIORITY FLOW =================

  let result = null;

  // 1️⃣ Apple TV PT
  result = await resolveApple(imdbId, wiki, 'pt');
  if (result) return finalize(result, imdbId, parsedMeta, env, cacheKey);

  // 2️⃣ Apple TV US
  result = await resolveApple(imdbId, wiki, 'us');
  if (result) return finalize(result, imdbId, parsedMeta, env, cacheKey);

  // 3️⃣ Rotten Tomatoes
  result = await resolveRT(wiki);
  if (result) return finalize(result, imdbId, parsedMeta, env, cacheKey);

  // 4️⃣ IMDb
  result = await resolveIMDb(imdbId);
  if (result) return finalize(result, imdbId, parsedMeta, env, cacheKey);

  // 5️⃣ Fandango
  result = await resolveFandango(wiki);
  if (result) return finalize(result, imdbId, parsedMeta, env, cacheKey);

  return { title: parsedMeta?.title || imdbId, links: [] };
}

function finalize(r, imdbId, meta, env, cacheKey) {
  const result = {
    title: meta?.title || imdbId,
    links: [{ trailers: r.url, provider: `⭐ ${r.provider}` }]
  };

  if (env.KV) {
    env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL });
  }

  return result;
}

// ================= HANDLER =================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/manifest.json') {
      return new Response(JSON.stringify(MANIFEST));
    }

    const m = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (m) {
      const [, type, id] = m;
      const imdbId = id.split(':')[0];

      const data = await resolveTrailers(imdbId, type, env, ctx);

      return new Response(JSON.stringify({
        meta: {
          id: imdbId,
          type,
          name: data.title,
          links: data.links
        }
      }));
    }

    return new Response('Not found', { status: 404 });
  }
};
