// Trailerio Lite - Cloudflare Workers Edition
// KV storage, edge-deployed trailer resolver for Fusion

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.2.0',
  name: 'Trailerio',
  description: 'Trailer addon - Fandango, Apple TV, Rotten Tomatoes, MUBI, IMDb',
  logo: 'https://raw.githubusercontent.com/9mousaa/trailerio-lite/main/icon.png',
  resources: [
    {
      name: 'meta',
      types: ['movie', 'series'],
      idPrefixes: ['tt']
    }
  ],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 172800; // 48 horas (usado no KV)
const TMDB_API_KEY = 'bfe73358661a995b992ae9a812aa0d2f';

// ============== CONFIGURAÇÕES DE EXCEPÇÃO ==============

const PROVIDER_OVERRIDES = {
  'tt0108052': { 'Rotten Tomatoes': null },          // Schindler's List - RT removido
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
  'tt0468569':  { id: 'umc.cmc.1uf4c3neuc9yxhnjv7t4rd5wa', locale: 'pt' },  // O Cavaleiro das Trevas
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
    const widthMatch = tag.match(/width="(\d+)"/);
    const heightMatch = tag.match(/height="(\d+)"/);
    const bitrateMatch = tag.match(/system-bitrate="(\d+)"/);
    const height = heightMatch ? parseInt(heightMatch[1]) : 0;
    const width = widthMatch ? parseInt(widthMatch[1]) : Math.round(height * 16 / 9);
    return { url: m[1], width, height, bitrate: bitrateMatch ? Math.round(parseInt(bitrateMatch[1]) / 1000) : 0 };
  });
  if (videos.length === 0) return null;
  videos.sort((a, b) => b.bitrate - a.bitrate || b.width - a.width);
  return videos[0];
}

// ============== TMDB METADATA ==============

async function getTMDBMetadata(imdbId, type = 'movie') {
  try {
    const findRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );
    const findData = await findRes.json();

    let results = type === 'series' ? findData.tv_results : findData.movie_results;
    let actualType = type;

    if (!results || results.length === 0) {
      results = type === 'series' ? findData.movie_results : findData.tv_results;
      actualType = type === 'series' ? 'movie' : 'series';
    }

    if (!results || results.length === 0) return null;

    const tmdbId = results[0].id;
    const title = results[0].title || results[0].name;

    const extRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3/${actualType === 'series' ? 'tv' : 'movie'}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
    );
    const extData = await extRes.json();

    return { tmdbId, title, wikidataId: extData.wikidata_id, imdbId, actualType };
  } catch (e) {
    return null;
  }
}

async function getWikidataIds(wikidataId) {
  if (!wikidataId) return {};
  try {
    const res = await fetchWithTimeout(
      `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'TrailerioLite/1.0' } },
      3500
    );
    const data = await res.json();
    const entity = data.entities?.[wikidataId];
    if (!entity) return {};

    const appleTvMovieId = entity.claims?.P9586?.[0]?.mainsnak?.datavalue?.value;
    const appleTvShowId = entity.claims?.P9751?.[0]?.mainsnak?.datavalue?.value;

    return {
      appleTvId: appleTvMovieId || appleTvShowId,
      isAppleTvShow: !!appleTvShowId && !appleTvMovieId,
      rtSlug: entity.claims?.P1258?.[0]?.mainsnak?.datavalue?.value,
      fandangoId: entity.claims?.P5693?.[0]?.mainsnak?.datavalue?.value,
      mubiId: entity.claims?.P7299?.[0]?.mainsnak?.datavalue?.value
    };
  } catch (e) {
    return {};
  }
}

// ============== SOURCE RESOLVERS ==============

async function resolveAppleTVForLocale(appleId, isShow, locale) {
  try {
    const pageUrl = isShow
      ? `https://tv.apple.com/${locale}/show/${appleId}`
      : `https://tv.apple.com/${locale}/movie/${appleId}`;

    const pageRes = await fetchWithTimeout(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      redirect: 'follow'
    });

    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    const hlsRaw = [...html.matchAll(/https:\/\/play[^"]*\.m3u8[^"]*/g)];
    if (hlsRaw.length === 0) return null;

    const junk = /teaser|clip|behind|featurette|sneak|opening/i;
    const candidates = hlsRaw.map(m => ({
      url: m[0].replace(/&amp;/g, '&'),
      ctx: html.substring(Math.max(0, m.index - 500), m.index).toLowerCase()
    }));
    candidates.sort((a, b) => {
      const score = v => {
        if (v.ctx.includes('trailer') && !junk.test(v.ctx)) return 0;
        if (v.ctx.includes('trailer')) return 1;
        return 2;
      };
      return score(a) - score(b);
    });

    for (const candidate of candidates.slice(0, 3)) {
      try {
        const m3u8Res = await fetchWithTimeout(candidate.url, {}, 1500);
        const m3u8Text = await m3u8Res.text();

        if (candidates.length > 1) {
          const durMatch = m3u8Text.match(/com\.apple\.hls\.feature\.duration.*?VALUE="([\d.]+)"/);
          if (durMatch) {
            const dur = parseFloat(durMatch[1]);
            if (dur < 60 || dur > 300) continue;
          }
        }

        const streamMatches = [...m3u8Text.matchAll(/#EXT-X-STREAM-INF:.*?BANDWIDTH=(\d+)(?:.*?RESOLUTION=(\d+)x(\d+))?/g)];
        if (streamMatches.length === 0) continue;

        streamMatches.sort((a, b) => parseInt(b[1]) - parseInt(a[1]));
        const width = streamMatches[0][2] ? parseInt(streamMatches[0][2]) : 0;
        const height = streamMatches[0][3] ? parseInt(streamMatches[0][3]) : 0;
        const bitrate = Math.round(parseInt(streamMatches[0][1]) / 1000);

        const hasDV = /dvh1/i.test(m3u8Text) || /VIDEO-RANGE=PQ/i.test(m3u8Text);
        const hasHDR = hasDV || /VIDEO-RANGE=HLG/i.test(m3u8Text) || /hev1\.\d+\.\d+\.L\d+/i.test(m3u8Text);
        const hasAtmos = /atmos|ec-3/i.test(m3u8Text);
        const hasSurround = hasAtmos || /CHANNELS="6"|CHANNELS="8"|ac-3/i.test(m3u8Text);

        let quality = width >= 3840 ? '4K' : width >= 1900 ? '1080p' : width >= 1200 ? '720p' : '1080p';
        if (hasDV) quality += ' DV';
        else if (hasHDR) quality += ' HDR';
        if (hasAtmos) quality += ' Atmos';
        else if (hasSurround) quality += ' 5.1';

        return { url: candidate.url, provider: `Apple TV ${quality}`, bitrate, width, height, locale };
      } catch (e) { continue; }
    }

    if (candidates.length > 0) {
      return { url: candidates[0].url, provider: 'Apple TV', bitrate: 0, width: 0, height: 0, locale };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

async function resolveAppleTV(imdbId, wikidataIdsPromise) {
  const idOverride = APPLETV_ID_OVERRIDES[imdbId];
  if (idOverride) {
    return await resolveAppleTVForLocale(idOverride.id, false, idOverride.locale);
  }

  const wikidataIds = await wikidataIdsPromise;
  const appleId = wikidataIds?.appleTvId;
  if (!appleId) return null;

  const isShow = wikidataIds?.isAppleTvShow || false;
  const localeOverride = APPLETV_LOCALE_OVERRIDES[imdbId];
  if (localeOverride) {
    return await resolveAppleTVForLocale(appleId, isShow, localeOverride);
  }

  const ptResult = await resolveAppleTVForLocale(appleId, isShow, 'pt');
  if (ptResult) return ptResult;

  return await resolveAppleTVForLocale(appleId, isShow, 'us');
}

async function resolveRottenTomatoes(wikidataIdsPromise) {
  try {
    const wikidataIds = await wikidataIdsPromise;
    let rtSlug = wikidataIds?.rtSlug;
    if (!rtSlug) return null;

    const isTV = rtSlug.startsWith('tv/');
    rtSlug = rtSlug.replace(/^(m|tv)\//, '');

    const videosUrl = isTV
      ? `https://www.rottentomatoes.com/tv/${rtSlug}/videos`
      : `https://www.rottentomatoes.com/m/${rtSlug}/videos`;
    const pageRes = await fetchWithTimeout(videosUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!pageRes.ok) return null;

    const html = await pageRes.text();
    const scriptMatch = html.match(/<script\s+id="videos"[^>]*>([\s\S]*?)<\/script>/i);
    if (!scriptMatch) return null;

    let videos;
    try { videos = JSON.parse(scriptMatch[1]); } catch (e) { return null; }
    if (!Array.isArray(videos) || videos.length === 0) return null;

    const junk = /teaser|clip|behind|featurette|sneak peek|opening|sequence/i;
    const priority = v => {
      const t = (v.title || '').toLowerCase();
      if (v.videoType === 'TRAILER' && t.includes('trailer') && !junk.test(t)) return 0;
      if (v.videoType === 'TRAILER' && !junk.test(t)) return 1;
      if (v.videoType === 'TRAILER') return 2;
      return 3;
    };
    videos.sort((a, b) => priority(a) - priority(b));

    for (const trailer of videos) {
      if (!trailer.file) continue;
      if (trailer.file.includes('theplatform.com') || trailer.file.includes('link.theplatform')) {
        try {
          const smilUrl = trailer.file.split('?')[0] + '?format=SMIL';
          const smilRes = await fetchWithTimeout(smilUrl, { headers: { 'Accept': 'application/smil+xml' } }, 1500);
          if (smilRes.ok) {
            const best = parseSMIL(await smilRes.text());
            if (best) {
              const quality = best.width >= 1900 ? '1080p' : `${best.height}p`;
              return { url: best.url, provider: `Rotten Tomatoes ${quality}`, bitrate: best.bitrate || 5000, width: best.width, height: best.height };
            }
          }
        } catch (e) { /* try next */ }
      }
    }
  } catch (e) { /* silent fail */ }
  return null;
}

async function resolveFandango(wikidataIdsPromise) {
  try {
    const wikidataIds = await wikidataIdsPromise;
    const fandangoId = wikidataIds?.fandangoId;
    if (!fandangoId) return null;

    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    const pageRes = await fetchWithTimeout(
      `https://www.fandango.com/x-${fandangoId}/movie-overview`,
      { headers, redirect: 'follow' }
    );
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    const jwMatch = html.match(/jwPlayerData\s*=\s*(\{[\s\S]*?\});/);
    if (jwMatch) {
      try {
        const jwData = JSON.parse(jwMatch[1]);
        if (jwData.contentURL?.includes('theplatform.com')) {
          const smilRes = await fetchWithTimeout(jwData.contentURL.split('?')[0] + '?format=SMIL&formats=mpeg4', { headers: { 'Accept': 'application/smil+xml' } }, 1500);
          if (smilRes.ok) {
            const best = parseSMIL(await smilRes.text());
            if (best) {
              const quality = best.width >= 1900 ? '1080p' : `${best.height}p`;
              return { url: best.url, provider: `Fandango ${quality}`, bitrate: best.bitrate || 8000, width: best.width, height: best.height };
            }
          }
        }
      } catch { /* next strategy */ }
    }

    const fandangoMp4 = html.match(/https:\/\/video\.fandango\.com\/[^"'\s]+\.mp4/);
    if (fandangoMp4) {
      return { url: fandangoMp4[0], provider: 'Fandango 1080p', bitrate: 8000, width: 1920, height: 1080 };
    }

    const tpMatch = html.match(/(https:\/\/link\.theplatform\.com\/s\/[^"'\s?]+)/);
    if (tpMatch) {
      const smilRes = await fetchWithTimeout(tpMatch[1] + '?format=SMIL&formats=mpeg4', { headers: { 'Accept': 'application/smil+xml' } }, 1500);
      if (smilRes.ok) {
        const best = parseSMIL(await smilRes.text());
        if (best) {
          const quality = best.width >= 1900 ? '1080p' : `${best.height}p`;
          return { url: best.url, provider: `Fandango ${quality}`, bitrate: best.bitrate || 8000, width: best.width, height: best.height };
        }
      }
    }
  } catch (e) { /* silent fail */ }
  return null;
}

async function resolveMUBI(wikidataIdsPromise, tmdbMetaPromise) {
  try {
    const [wikidataIds, tmdbMeta] = await Promise.all([wikidataIdsPromise, tmdbMetaPromise]);
    const mubiId = wikidataIds?.mubiId;
    if (!mubiId) return null;

    const title = tmdbMeta?.title;
    if (!title) return null;

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const pageRes = await fetchWithTimeout(
      `https://mubi.com/en/us/films/${slug}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
    );
    if (!pageRes.ok) return null;

    const html = await pageRes.text();
    const trailerUrls = [...html.matchAll(/https:\/\/trailers\.mubicdn\.net\/\d+\/optimised\/(\d+)p[^"'\s]+\.mp4/g)];
    if (trailerUrls.length === 0) return null;

    trailerUrls.sort((a, b) => parseInt(b[1]) - parseInt(a[1]));
    const height = parseInt(trailerUrls[0][1]) || 720;
    return { url: trailerUrls[0][0], provider: `MUBI ${height}p`, bitrate: 0, width: Math.round(height * 16 / 9), height };
  } catch (e) { /* silent fail */ }
  return null;
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
    const galleryRes = await fetchWithTimeout(
      'https://caching.graphql.imdb.com/',
      { method: 'POST', headers: IMDB_GQL_HEADERS, body: JSON.stringify({
        query: `query Q($c:ID!){title(id:$c){primaryVideos(first:5){edges{node{id contentType{displayName{value}}}}}}}`,
        operationName: 'Q', variables: { c: imdbId }
      })}
    );
    if (!galleryRes.ok) return null;

    const edges = (await galleryRes.json())?.data?.title?.primaryVideos?.edges || [];
    const trailerEdge = edges.find(e => /trailer/i.test(e.node?.contentType?.displayName?.value)) || edges[0];
    if (!trailerEdge) return null;

    const playbackRes = await fetchWithTimeout(
      'https://caching.graphql.imdb.com/',
      { method: 'POST', headers: IMDB_GQL_HEADERS, body: JSON.stringify({
        query: `query Q($c:ID!){video(id:$c){playbackURLs{displayName{value}url videoMimeType}}}`,
        operationName: 'Q', variables: { c: trailerEdge.node.id }
      })}
    );
    if (!playbackRes.ok) return null;

    const urls = (await playbackRes.json())?.data?.video?.playbackURLs || [];
    if (urls.length === 0) return null;

    const mp4s = urls.filter(u => u.videoMimeType?.includes('mp4'));
    let best = null;
    for (const q of ['1080p', '720p', '480p', '360p', 'SD']) {
      best = mp4s.find(u => u.displayName?.value?.includes(q));
      if (best) break;
    }
    if (!best) best = mp4s[0] || urls[0];
    if (!best?.url) return null;

    const heightMatch = (best.displayName?.value || '').match(/(\d+)p/);
    const height = heightMatch ? parseInt(heightMatch[1]) : 0;
    return { url: best.url, provider: `IMDb ${heightMatch ? height + 'p' : 'SD'}`, bitrate: 0, width: 0, height };
  } catch (e) { /* silent fail */ }
  return null;
}

// ============== MAIN RESOLVER ==============

async function resolveTrailers(imdbId, type, env, fresh = false) {
  const cacheKey = `trailer:v82:${imdbId}`;

  // 1. Tenta ir buscar ao KV primeiro e devolve IMEDIATAMENTE se encontrar
  if (!fresh && env.KV) {
    const cached = await env.KV.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  }

  const tmdbReady = deferred();
  const wikidataReady = deferred();

  const metaPipeline = (async () => {
    try {
      const tmdbMeta = await getTMDBMetadata(imdbId, type);
      tmdbReady.resolve(tmdbMeta);

      const wikidataIds = tmdbMeta?.wikidataId
        ? await getWikidataIds(tmdbMeta.wikidataId)
        : {};
      wikidataReady.resolve(wikidataIds);

      return { tmdbMeta, wikidataIds };
    } catch (e) {
      tmdbReady.resolve(null);
      wikidataReady.resolve({});
      return { tmdbMeta: null, wikidataIds: {} };
    }
  })();

  const [imdbResult, appleTvResult, rtResult, fandangoResult, mubiResult, metaResult] =
    await Promise.all([
      resolveIMDb(imdbId),
      resolveAppleTV(imdbId, wikidataReady.promise),
      resolveRottenTomatoes(wikidataReady.promise),
      resolveFandango(wikidataReady.promise),
      resolveMUBI(wikidataReady.promise, tmdbReady.promise),
      metaPipeline
    ]);

  const tmdbMeta = metaResult?.tmdbMeta;
  const tier = (w, h) => { const m = Math.max(w, h); return m >= 3840 ? 3 : m >= 1900 ? 2 : m >= 1200 ? 1 : 0; };
  const overrides = PROVIDER_OVERRIDES[imdbId] || {};

  const isExcluded = (r) => {
    for (const [name, value] of Object.entries(overrides)) {
      if (r.provider.includes(name) && value === null) return true;
    }
    return false;
  };

  const providerOrder = (r) => {
    for (const [name, order] of Object.entries(overrides)) {
      if (r.provider.includes(name) && order !== null) return order;
    }
    if (r.provider.includes('Apple TV') && r.locale === 'pt') return 10;
    if (r.provider.includes('Apple TV')) return 11;
    const t = tier(r.width, r.height);
    if (t === 3) return 12;
    if (t === 2 && r.provider.includes('Rotten Tomatoes')) return 13;
    if (r.provider.includes('IMDb')) return 14;
    if (r.provider.includes('MUBI')) return 15;
    return 16 + (3 - t);
  };

  const seen = new Set();
  const links = [imdbResult, appleTvResult, rtResult, fandangoResult, mubiResult]
    .filter(r => r !== null)
    .filter(r => !isExcluded(r))
    .sort((a, b) => providerOrder(a) - providerOrder(b) || b.bitrate - a.bitrate)
    .filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .map((r, index) => ({
      trailers: r.url,
      provider: index === 0 ? `⭐ ${r.provider}` : r.provider
    }));

  const result = {
    title: tmdbMeta?.title || imdbId,
    links: links
  };

  // 2. Guarda no KV para a próxima vez
  if (links.length > 0 && env.KV) {
    await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL });
  }

  return result;
}

// ============== REQUEST HANDLER ==============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/manifest.json') {
      return new Response(JSON.stringify(MANIFEST), {
        headers: {
          ...corsHeaders,
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', edge: request.cf?.colo, hasKV: !!env.KV }), {
        headers: {
          ...corsHeaders,
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    const metaMatch = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;
      const imdbId = id.split(':')[0];
      const fresh = url.searchParams.has('fresh');

      const result = await resolveTrailers(imdbId, type, env, fresh);

      return new Response(JSON.stringify({
        meta: {
          id: imdbId,
          type: type,
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

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: corsHeaders
    });
  }
};
