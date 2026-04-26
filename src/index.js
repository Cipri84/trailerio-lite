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

const CACHE_TTL      = 172800;  // 48 horas — trailers
const META_CACHE_TTL = 432000;  // 5 dias  — metadados (título + IDs Wikidata)
const TMDB_API_KEY   = 'bfe73358661a995b992ae9a812aa0d2f';

// ============== TIMEOUTS ==============

const TIMEOUT_API      = 1500;  // APIs rápidas: TMDB, IMDb GraphQL
const TIMEOUT_PAGE     = 2000;  // Páginas HTML completas: Apple TV, RT, Fandango, MUBI
const TIMEOUT_STREAM   = 1000;  // Ficheiros de metadados pequenos: m3u8, SMIL
const TIMEOUT_WIKIDATA = 2000;  // Wikidata pode ser lento consoante o edge

// ============== CONFIGURAÇÕES DE EXCEPÇÃO ==============

const PROVIDER_OVERRIDES = {
  'tt0108052': { 'Rotten Tomatoes': null },          // Schindler's List - RT removido
  'tt0105695': { 'IMDb': 0 },                        // Unforgiven - IMDb em primeiro
  'tt14205554': { 'MUBI': 10 },                      // Kpop Demon Hunters - MUBI em primeiro
  'tt0167260':  { 'Rotten Tomatoes': null },         // O Regresso do Rei - RT removido
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
  'tt30017619': { id: 'umc.cmc.2ewfnaq853ueokr49pv4brr1d', locale: 'pt' },  // The Bad Guys 2
};

// ============== UTILITIES ==============

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function fetchWithTimeout(url, options = {}, timeout = TIMEOUT_API) {
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

// ============== WIKIDATA ==============

async function getWikidataIds(wikidataId) {
  if (!wikidataId) return {};
  try {
    const res = await fetchWithTimeout(
      `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'TrailerioLite/1.0' } },
      TIMEOUT_WIKIDATA
    );
    const data = await res.json();
    const entity = data.entities?.[wikidataId];
    if (!entity) return {};

    const appleTvMovieId = entity.claims?.P9586?.[0]?.mainsnak?.datavalue?.value;
    const appleTvShowId  = entity.claims?.P9751?.[0]?.mainsnak?.datavalue?.value;

    return {
      appleTvId:    appleTvMovieId || appleTvShowId,
      isAppleTvShow: !!appleTvShowId && !appleTvMovieId,
      rtSlug:       entity.claims?.P1258?.[0]?.mainsnak?.datavalue?.value,
      fandangoId:   entity.claims?.P5693?.[0]?.mainsnak?.datavalue?.value,
      mubiId:       entity.claims?.P7299?.[0]?.mainsnak?.datavalue?.value
    };
  } catch (e) {
    console.error(`[Wikidata] ${wikidataId}:`, e?.message ?? e);
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
    }, TIMEOUT_PAGE);

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
        const m3u8Res = await fetchWithTimeout(candidate.url, {}, TIMEOUT_STREAM);
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
        const width   = streamMatches[0][2] ? parseInt(streamMatches[0][2]) : 0;
        const height  = streamMatches[0][3] ? parseInt(streamMatches[0][3]) : 0;
        const bitrate = Math.round(parseInt(streamMatches[0][1]) / 1000);

        const hasDV      = /dvh1/i.test(m3u8Text) || /VIDEO-RANGE=PQ/i.test(m3u8Text);
        const hasHDR     = hasDV || /VIDEO-RANGE=HLG/i.test(m3u8Text) || /hev1\.\d+\.\d+\.L\d+/i.test(m3u8Text);
        const hasAtmos   = /atmos|ec-3/i.test(m3u8Text);
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
  } catch (e) { console.error(`[AppleTV:${locale}] ${appleId}:`, e?.message ?? e); }
  return null;
}

// PT e US correm em paralelo no Promise.all — US é suprimido se PT tiver resultado.
async function resolveAppleTV(imdbId, wikidataIdsPromise, locale) {
  const idOverride = APPLETV_ID_OVERRIDES[imdbId];
  if (idOverride) {
    if (idOverride.locale !== locale) return null;
    return await resolveAppleTVForLocale(idOverride.id, false, locale);
  }

  const localeOverride = APPLETV_LOCALE_OVERRIDES[imdbId];
  if (localeOverride && localeOverride !== locale) return null;

  const wikidataIds = await wikidataIdsPromise;
  const appleId = wikidataIds?.appleTvId;
  if (!appleId) return null;

  const isShow = wikidataIds?.isAppleTvShow || false;
  return await resolveAppleTVForLocale(appleId, isShow, locale);
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
    }, TIMEOUT_PAGE);
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
          const smilRes = await fetchWithTimeout(smilUrl, { headers: { 'Accept': 'application/smil+xml' } }, TIMEOUT_STREAM);
          if (smilRes.ok) {
            const best = parseSMIL(await smilRes.text());
            if (best) {
              const quality = best.width >= 1900 ? '1080p' : `${best.height}p`;
              return { url: best.url, provider: `Rotten Tomatoes ${quality}`, bitrate: best.bitrate || 5000, width: best.width, height: best.height };
            }
          }
        } catch (e) { /* try next */ }
        continue;
      }

      if (/\.mp4(\?|$)/i.test(trailer.file)) {
        const heightMatch = (trailer.title || '').match(/(\d{3,4})p/i);
        const height = heightMatch ? parseInt(heightMatch[1]) : 1080;
        const width = Math.round(height * 16 / 9);
        const quality = height >= 1080 ? '1080p' : `${height}p`;
        return { url: trailer.file, provider: `Rotten Tomatoes ${quality}`, bitrate: 5000, width, height };
      }

      if (/\.m3u8(\?|$)/i.test(trailer.file) || trailer.file.includes('akamai') || trailer.file.includes('cloudfront') || trailer.file.includes('fwmrm') || trailer.file.includes('anvato')) {
        try {
          const m3u8Res = await fetchWithTimeout(trailer.file, {}, TIMEOUT_STREAM);
          if (!m3u8Res.ok) continue;
          const m3u8Text = await m3u8Res.text();
          const streamMatches = [...m3u8Text.matchAll(/#EXT-X-STREAM-INF:.*?BANDWIDTH=(\d+)(?:.*?RESOLUTION=(\d+)x(\d+))?/g)];
          if (streamMatches.length > 0) {
            streamMatches.sort((a, b) => parseInt(b[1]) - parseInt(a[1]));
            const width  = streamMatches[0][2] ? parseInt(streamMatches[0][2]) : 1920;
            const height = streamMatches[0][3] ? parseInt(streamMatches[0][3]) : 1080;
            const quality = height >= 1080 ? '1080p' : `${height}p`;
            return { url: trailer.file, provider: `Rotten Tomatoes ${quality}`, bitrate: Math.round(parseInt(streamMatches[0][1]) / 1000), width, height };
          }
          return { url: trailer.file, provider: 'Rotten Tomatoes 1080p', bitrate: 5000, width: 1920, height: 1080 };
        } catch (e) { /* try next */ }
      }
    }
  } catch (e) { console.error(`[RT]:`, e?.message ?? e); }
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
      { headers, redirect: 'follow' },
      TIMEOUT_PAGE
    );
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    const jwMatch = html.match(/jwPlayerData\s*=\s*(\{[\s\S]*?\});/);
    if (jwMatch) {
      try {
        const jwData = JSON.parse(jwMatch[1]);
        if (jwData.contentURL?.includes('theplatform.com')) {
          const smilRes = await fetchWithTimeout(jwData.contentURL.split('?')[0] + '?format=SMIL&formats=mpeg4', { headers: { 'Accept': 'application/smil+xml' } }, TIMEOUT_STREAM);
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
      const smilRes = await fetchWithTimeout(tpMatch[1] + '?format=SMIL&formats=mpeg4', { headers: { 'Accept': 'application/smil+xml' } }, TIMEOUT_STREAM);
      if (smilRes.ok) {
        const best = parseSMIL(await smilRes.text());
        if (best) {
          const quality = best.width >= 1900 ? '1080p' : `${best.height}p`;
          return { url: best.url, provider: `Fandango ${quality}`, bitrate: best.bitrate || 8000, width: best.width, height: best.height };
        }
      }
    }
  } catch (e) { console.error(`[Fandango]:`, e?.message ?? e); }
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
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } },
      TIMEOUT_PAGE
    );
    if (!pageRes.ok) return null;

    const html = await pageRes.text();
    const trailerUrls = [...html.matchAll(/https:\/\/trailers\.mubicdn\.net\/\d+\/optimised\/(\d+)p[^"'\s]+\.mp4/g)];
    if (trailerUrls.length === 0) return null;

    trailerUrls.sort((a, b) => parseInt(b[1]) - parseInt(a[1]));
    const height = parseInt(trailerUrls[0][1]) || 720;
    return { url: trailerUrls[0][0], provider: `MUBI ${height}p`, bitrate: 0, width: Math.round(height * 16 / 9), height };
  } catch (e) { console.error(`[MUBI]:`, e?.message ?? e); }
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

function pickBestIMDb(urls) {
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
}

async function resolveIMDb(imdbId) {
  try {
    const combinedRes = await fetchWithTimeout(
      'https://caching.graphql.imdb.com/',
      { method: 'POST', headers: IMDB_GQL_HEADERS, body: JSON.stringify({
        query: `query Q($c:ID!){title(id:$c){primaryVideos(first:5){edges{node{id contentType{displayName{value}}playbackURLs{displayName{value}url videoMimeType}}}}}}`,
        operationName: 'Q', variables: { c: imdbId }
      })}
    );

    if (combinedRes.ok) {
      const edges = (await combinedRes.json())?.data?.title?.primaryVideos?.edges || [];
      const trailerEdge = edges.find(e => /trailer/i.test(e.node?.contentType?.displayName?.value)) || edges[0];

      if (trailerEdge) {
        const urls = trailerEdge.node?.playbackURLs || [];

        if (urls.length > 0) return pickBestIMDb(urls);

        const playbackRes = await fetchWithTimeout(
          'https://caching.graphql.imdb.com/',
          { method: 'POST', headers: IMDB_GQL_HEADERS, body: JSON.stringify({
            query: `query Q($c:ID!){video(id:$c){playbackURLs{displayName{value}url videoMimeType}}}`,
            operationName: 'Q', variables: { c: trailerEdge.node.id }
          })}
        );
        if (!playbackRes.ok) return null;
        const urls2 = (await playbackRes.json())?.data?.video?.playbackURLs || [];
        if (urls2.length === 0) return null;
        return pickBestIMDb(urls2);
      }
    }
  } catch (e) { console.error(`[IMDb] ${imdbId}:`, e?.message ?? e); }
  return null;
}

// ============== MAIN RESOLVER ==============

async function resolveTrailers(imdbId, type, env, ctx, fresh = false) {
  const cacheKey     = `trailer:v94:${imdbId}`;
  const metaCacheKey = `meta:v1:${imdbId}`;

  // [FIX 4] Cache API — camada edge-local à frente do KV
  // Na segunda leitura no mesmo edge não toca no KV (elimina a inconsistência do "eventually consistent")
  const cacheApi    = caches.default;
  const cacheApiReq = new Request(`https://trailerio-cache/${cacheKey}`);

  if (!fresh) {
    const edgeCached = await cacheApi.match(cacheApiReq);
    if (edgeCached) return await edgeCached.json();
  }

  // [FIX 1] Ambos os reads KV correm em paralelo — elimina ~100ms de latência sequencial
  const [cachedTrailer, cachedMetaRaw] = await Promise.all([
    (env.KV && !fresh) ? env.KV.get(cacheKey)     : Promise.resolve(null),
    (env.KV && !fresh) ? env.KV.get(metaCacheKey) : Promise.resolve(null)
  ]);

  if (cachedTrailer) {
    // Propaga para a Cache API deste edge para leituras futuras
    ctx.waitUntil(cacheApi.put(cacheApiReq, new Response(cachedTrailer, {
      headers: { 'Cache-Control': `public, max-age=${CACHE_TTL}` }
    })));
    return JSON.parse(cachedTrailer);
  }

  const parsedCachedMeta = cachedMetaRaw ? JSON.parse(cachedMetaRaw) : null;

  const tmdbReady     = deferred();
  const wikidataReady = deferred();

  // Se já temos meta em cache, os deferreds resolvem imediatamente
  if (parsedCachedMeta) {
    tmdbReady.resolve({ title: parsedCachedMeta.title, imdbId, actualType: type });
    wikidataReady.resolve(parsedCachedMeta.wikidataIds);
  }

  // [FIX 2] Pipeline em duas fases: tmdbReady resolve após a 1ª chamada TMDB
  // (antes resolvia só após TMDB find + TMDB external_ids + Wikidata)
  // MUBI desbloqueia ~1500ms mais cedo em cache fria
  const metaPipeline = (async () => {
    try {
      // Fase 1: TMDB find — obtém título e tmdbId
      let tmdbPartial = null;
      try {
        const findRes = await fetchWithTimeout(
          `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
        );
        const findData = await findRes.json();
        let results   = type === 'series' ? findData.tv_results : findData.movie_results;
        let actualType = type;
        if (!results?.length) {
          results    = type === 'series' ? findData.movie_results : findData.tv_results;
          actualType = type === 'series' ? 'movie' : 'series';
        }
        if (results?.length) {
          tmdbPartial = {
            tmdbId:     results[0].id,
            title:      results[0].title || results[0].name,
            imdbId,
            actualType
          };
        }
      } catch (e) { console.error(`[TMDB find] ${imdbId}:`, e?.message ?? e); }

      // MUBI pode arrancar agora — só precisa do título
      if (!parsedCachedMeta) tmdbReady.resolve(tmdbPartial);

      // Fase 2: TMDB external_ids → Wikidata — desbloqueia Apple TV, RT, Fandango
      let wikidataIds = {};
      if (tmdbPartial?.tmdbId) {
        try {
          const endpoint = tmdbPartial.actualType === 'series' ? 'tv' : 'movie';
          const extRes   = await fetchWithTimeout(
            `https://api.themoviedb.org/3/${endpoint}/${tmdbPartial.tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
          );
          const extData    = await extRes.json();
          const wikidataId = extData.wikidata_id;
          if (wikidataId) {
            wikidataIds = await getWikidataIds(wikidataId);
          }
        } catch (e) { console.error(`[TMDB ext/Wikidata] ${imdbId}:`, e?.message ?? e); }
      }

      if (!parsedCachedMeta) wikidataReady.resolve(wikidataIds);

      // Guardar meta em cache para próximas chamadas
      const title = tmdbPartial?.title;
      if (env.KV && title) {
        ctx.waitUntil(
          env.KV.put(metaCacheKey, JSON.stringify({ title, wikidataIds }), { expirationTtl: META_CACHE_TTL })
        );
      }

      return { tmdbMeta: tmdbPartial, wikidataIds };
    } catch (e) {
      console.error(`[metaPipeline] ${imdbId}:`, e?.message ?? e);
      if (!parsedCachedMeta) {
        tmdbReady.resolve(null);
        wikidataReady.resolve({});
      }
      return { tmdbMeta: null, wikidataIds: {} };
    }
  })();

  // Todas as fontes correm em paralelo
  // Apple TV PT e US em paralelo; US suprimido na lista final se PT tiver resultado
  const [imdbResult, appleTvPTResult, appleTvUSResult, rtResult, fandangoResult, mubiResult, metaResult] =
    await Promise.all([
      resolveIMDb(imdbId),
      resolveAppleTV(imdbId, wikidataReady.promise, 'pt'),
      resolveAppleTV(imdbId, wikidataReady.promise, 'us'),
      resolveRottenTomatoes(wikidataReady.promise),
      resolveFandango(wikidataReady.promise),
      resolveMUBI(wikidataReady.promise, tmdbReady.promise),
      metaPipeline
    ]);

  const freshTitle = metaResult?.tmdbMeta?.title;
  const title = freshTitle || parsedCachedMeta?.title || imdbId;

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

  const hasPT = appleTvPTResult !== null;

  const seen = new Set();
  const links = [imdbResult, appleTvPTResult, hasPT ? null : appleTvUSResult, rtResult, fandangoResult, mubiResult]
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

  const result = { title, links };

  if (links.length > 0 && env.KV) {
    const resultJson = JSON.stringify(result);
    ctx.waitUntil(Promise.all([
      env.KV.put(cacheKey, resultJson, { expirationTtl: CACHE_TTL }),
      cacheApi.put(cacheApiReq, new Response(resultJson, {
        headers: { 'Cache-Control': `public, max-age=${CACHE_TTL}` }
      }))
    ]));
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
        headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=3600' }
      });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', edge: request.cf?.colo, hasKV: !!env.KV }), {
        headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=300' }
      });
    }

    const metaMatch = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;
      const imdbId = id.split(':')[0];
      const fresh  = url.searchParams.has('fresh');

      const result = await resolveTrailers(imdbId, type, env, ctx, fresh);

      return new Response(JSON.stringify({
        meta: {
          id:    imdbId,
          type:  type,
          name:  result.title,
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
