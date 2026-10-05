// Kino plugin: Caracol TV (Caracol Streaming / Ditu) — series, películas y canales en vivo.
// Plugin id `caracol-tv`; el id `ditu` está reservado por Kino para evitar choques con la versión
// nativa, que sigue activa como `ResolveOnlySource` para resolver las refs que ya están guardadas
// en las bibliotecas de las personas (pre-plugin).
//
// Hosts declarados: la API de Caracol (middleware.ditu.caracoltv.com), el CDN de posters
// (image-registry.ditu.caracoltv.com) y el CDN de logos de Caracol TV que llega en el JSON
// (image-registry.avscaracoltv.com). Los streams son DASH, vienen de hosts que Caracol elige en
// tiempo de ejecución (mdstrm.com y otros), por eso `streamHosts: "any"` y `liveStreamHosts: "any"`.

const BASE = "https://middleware.ditu.caracoltv.com/AGL/1.6/A/ENG/ANDROID/ALL";
const LICENSE = BASE + "/CONTENT/LICENSE";
const CDN_IMAGES = "https://image-registry.ditu.caracoltv.com/";
const POSTER_FILE = "portrait-thin-promotional-tablet.jpg";
const BACKDROP_FILE = "landscape-regular-clean-tablet.jpg";
const COOKIE_TOKEN = "playback_token";

// User-Agent propio de okhttp/4.12.0: sin él el CDN responde 403 al manifest y a los segmentos,
// y el error se lee como "el video no existe". Los otros dos (`restful`, `Accept`) son lo que el
// backend de Caracol exige para tomar la petición.
const REQUEST_HEADERS = {
  "restful": "yes",
  "Accept": "application/json, text/plain, */*",
  "User-Agent": "okhttp/4.12.0",
};

const PREFIX = "cditu1";
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h

// kino.log en builds de release puede lanzar él mismo (medido: un rename de R8 lo rompe); envolverlo
// para que un log fallido no se convierta en un search o Home roto.
function log(...args) {
  try {
    kino.log(...args);
  } catch {
    // el log se pierde, el resultado no
  }
}

// ---------- helpers de bajo nivel (ref, JSON, imágenes) ------------------------------

/** "cditu1:<contentType>:<contentId>" — contentId al final para que pueda llevar ":" sin problema. */
function encodeRef(contentId, contentType) {
  return PREFIX + ":" + contentType + ":" + contentId;
}

function decodeRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith(PREFIX + ":")) return null;
  const parts = ref.split(":", 3);
  if (parts.length < 3 || !parts[2]) return null;
  return { contentId: parts[2], contentType: parts[1] || "VOD" };
}

/** Concatena path a BASE y concatena query params. URLSearchParams hace el encoding. */
function api(path, params = {}) {
  const u = new URL(BASE + "/" + path);
  for (const [k, v] of Object.entries(params)) if (v !== "" && v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.toString();
}

/** GET a BASE; lanza Error con mensaje legible si algo falla. */
async function get(path, params = {}) {
  const r = await kino.fetch(api(path, params), { headers: { ...REQUEST_HEADERS } });
  if (!r.ok) {
    const err = new Error("Caracol respondió " + r.status + " en " + path);
    // Fuera de Colombia la API entera responde 403 (bloqueo geográfico): no es una falla del plugin.
    err.outsideColombia = r.status === 403;
    throw err;
  }
  return r.json();
}

/** GET a BASE; devuelve también la cookie `playback_token` (via Set-Cookie, no viene en el JSON). */
async function getWithToken(path) {
  const url = api(path);
  const r = await kino.fetch(url, { headers: { ...REQUEST_HEADERS } });
  if (!r.ok) throw new Error("Caracol respondió " + r.status + " en " + path);
  // El cookie lo puso el Set-Cookie de la respuesta anterior; `kino.cookies.get` lo lee por host.
  const token = kino.cookies.get(url, COOKIE_TOKEN) || "";
  return { json: r.json(), token };
}

/** resultObj.containers, o [] si la respuesta no tiene la forma esperada. */
function containers(json) {
  const arr = json && json.resultObj && Array.isArray(json.resultObj.containers) ? json.resultObj.containers : [];
  return arr.filter((c) => c && typeof c === "object");
}

// Cuatro dígitos al principio de un campo de año/release; "" si no.
function yearFrom(metadata) {
  if (!metadata) return "";
  for (const field of ["releaseDate", "releaseYear", "year"]) {
    const v = String(metadata[field] || "");
    if (v.length >= 4 && v.slice(0, 4).split("").every((c) => c >= "0" && c <= "9")) return v.slice(0, 4);
  }
  return "";
}

/** Poster vertical desde el CDN de Caracol; si no hay pictureUrl, del posterList[fileType=icon]. */
function posterFrom(c) {
  const pic = c && c.metadata && c.metadata.pictureUrl ? String(c.metadata.pictureUrl).trim() : "";
  if (pic) return CDN_IMAGES + pic + "/" + POSTER_FILE;
  const list = Array.isArray(c && c.posterList) ? c.posterList : [];
  const icon = list.find((p) => p && p.fileType === "icon" && p.fileUrl);
  return icon ? String(icon.fileUrl) : "";
}

/** Backdrop landscape desde el CDN de Caracol, o "" si no hay pictureUrl. */
function backdropFrom(c) {
  const pic = c && c.metadata && c.metadata.pictureUrl ? String(c.metadata.pictureUrl).trim() : "";
  return pic ? CDN_IMAGES + pic + "/" + BACKDROP_FILE : "";
}

/** El assetId del primer MASTER con assetId != 0; si no, el primer asset con assetId != 0. */
function assetMaster(c) {
  const list = Array.isArray(c && c.assets) ? c.assets : [];
  const master = list.find((a) => a && a.assetType === "MASTER" && a.assetId);
  if (master) return master.assetId;
  const any = list.find((a) => a && a.assetId);
  return any ? any.assetId : null;
}

// ---------- catálogo (búsqueda + home) ----------------------------------------------

/** Qué guardar del catálogo: el id estable, título, kind (movie/series), año, poster y ref. */
// Genre del vocabulario cerrado del contrato: las películas van a "peliculas", las series a
// "series". Caracol no expone un género más fino en TRAY/SEARCH/VOD (no hay campo de categoría
// en su metadata), así que esta es la granularidad que podemos darle al app sin inventar nada.
function genresOf(kind) {
  return kind === "movie" ? ["peliculas"] : ["series"];
}

function itemOf(c) {
  const m = (c.metadata || {});
  const contentType = String(m.contentType || "").toUpperCase();
  const subtype = String(m.contentSubtype || m.contentSubType || "").toUpperCase();
  let refType;
  if (contentType === "BUNDLE" || contentType === "GROUP_OF_BUNDLES") refType = contentType;
  else if (contentType === "VOD" && subtype === "MOVIE") refType = "VOD";
  else return null; // clips, LIVE suelto, promos: no son títulos que se puedan abrir
  const id = String(c.id || "").trim();
  const title = String(m.title || "").trim();
  if (!id || !title) return null;
  const kind = refType === "VOD" ? "movie" : "series";
  return {
    id,
    ref: encodeRef(id, refType),
    title,
    kind,
    genres: genresOf(kind),
    year: yearFrom(m),
    poster: posterFrom(c),
    backdrop: backdropFrom(c),
  };
}

/** Catálogo completo (búsqueda con query vacío ~330 títulos en una sola llamada). */
async function fullCatalog() {
  const json = await get("TRAY/SEARCH/VOD", { query: "" });
  return containers(json).map(itemOf).filter(Boolean);
}

/** Búsqueda; mismo endpoint con query lleno. */
async function searchCatalog(q) {
  const json = await get("TRAY/SEARCH/VOD", { query: q });
  return containers(json).map(itemOf).filter(Boolean);
}

/** Caché del catálogo por 6h (lo que duraba la nativa). Evita volver a traerla cada vez que se entra al Home. */
async function cachedCatalog(force = false) {
  const cached = kino.storage.get("catalog");
  let entry = null;
  if (cached) {
    try { entry = JSON.parse(cached); } catch { entry = null; }
  }
  if (!force && entry && entry.expiresAt > Date.now() && Array.isArray(entry.titles)) return entry.titles;
  const titles = await fullCatalog();
  kino.storage.set("catalog", JSON.stringify({ titles, expiresAt: Date.now() + CATALOG_TTL_MS }));
  return titles;
}

// ---------- capacidades exportadas --------------------------------------------------

// Caracol Streaming solo sirve en Colombia: Caracol mismo devuelve el bloqueo geográfico
// ("solo disponible en Colombia") en su endpoint de USERDATA. Se anuncia en la descripción del
// manifiesto (sale en la hoja de consentimiento al instalar) y en cada resultado con "SOLO COLOMBIA"
// para que no parezca un bug del app cuando un título no carga fuera del país.
const REGION_BADGE = "SOLO COLOMBIA";

export async function search(query) {
  if (!query || !query.q) return [];
  let items;
  try {
    items = await searchCatalog(query.q);
  } catch (e) {
    if (e.outsideColombia) return { items: [] };
    log("search failed", e.message);
    throw e;
  }
  return { items: items.map((t) => ({ ...t, badges: [REGION_BADGE] })) };
}

const ROW_PAGES = 60;

export async function home() {
  let titles;
  try {
    titles = await cachedCatalog(false);
  } catch (e) {
    // Fuera de Colombia no hay nada que mostrar: sin filas, en vez de un error en el Home.
    if (e.outsideColombia) return [];
    throw e;
  }
  const series = titles.filter((t) => t.kind === "series").slice(0, ROW_PAGES);
  const movies = titles.filter((t) => t.kind === "movie").slice(0, ROW_PAGES);
  const rows = [];
  if (series.length) rows.push({ id: "series", title: "Series de Caracol (solo Colombia)", ref: "series", items: series.map((t) => ({ ...t, badges: [REGION_BADGE] })) });
  if (movies.length) rows.push({ id: "movies", title: "Películas de Caracol (solo Colombia)", ref: "movies", items: movies.map((t) => ({ ...t, badges: [REGION_BADGE] })) });
  return rows;
}

export async function browse(ref, cursor) {
  await null; // los chequeos pueden lanzar: nunca antes del primer await
  if (ref !== "series" && ref !== "movies") throw kino.error("not_found", "esa fila ya no existe");
  const page = cursor ? Number(cursor) : 1;
  if (!Number.isInteger(page) || page < 1 || page > 50) throw kino.error("not_found", "página inválida");
  const titles = await cachedCatalog(false);
  const pool = titles.filter((t) => (ref === "series" ? t.kind === "series" : t.kind === "movie"));
  const start = (page - 1) * ROW_PAGES;
  const items = pool.slice(start, start + ROW_PAGES).map((t) => ({ ...t, badges: [REGION_BADGE] }));
  return { items, next: start + ROW_PAGES < pool.length ? String(page + 1) : undefined };
}

// ---------- capítulos de una serie --------------------------------------------------

/** Capítulos de un BUNDLE (una temporada). position es el fallback del número. */
async function episodesOfBundle(bundleId, forcedSeason) {
  const detail = await get("CONTENT/DETAIL/BUNDLE/" + encodeURIComponent(bundleId));
  const outer = containers(detail)[0];
  if (!outer) return { episodes: [], seriesTitle: "", posterUrl: "", backdropUrl: "", season: 1 };
  const raw = Array.isArray(outer.containers) ? outer.containers : [];
  const episodes = [];
  raw.forEach((ep, i) => {
    const id = ep && ep.id ? String(ep.id).trim() : "";
    if (!id) return;
    if (!assetMaster(ep)) return; // sin assetId no se puede reproducir; ofrecerlo sería prometer y fallar
    const m = (ep.metadata || {});
    const number = (m.episodeNumber && m.episodeNumber > 0) ? m.episodeNumber : (i + 1);
    const season = forcedSeason > 0 ? forcedSeason : (m.season && m.season > 0 ? m.season : 1);
    const title = String(m.episodeTitle || "").trim() || ("Episodio " + number);
    episodes.push({ season, number, ref: encodeRef(id, "VOD"), title });
  });
  const meta = outer.metadata || {};
  return {
    episodes,
    seriesTitle: String(meta.title || "").trim(),
    posterUrl: posterFrom(outer),
    backdropUrl: backdropFrom(outer),
    season: forcedSeason > 0 ? forcedSeason : (episodes[0] ? episodes[0].season : 1),
  };
}

/** Capítulos de un GROUP_OF_BUNDLES (varias temporadas): aplana los BUNDLE hijos. */
async function episodesOfGroup(groupId) {
  const json = await get("TRAY/SEARCH/VOD", { filter_parentId: groupId, filter_contentType: "BUNDLE" });
  const ids = containers(json).map((c) => c && c.id ? String(c.id).trim() : "").filter(Boolean);
  const all = [];
  let head = null;
  for (let i = 0; i < ids.length; i++) {
    const t = await episodesOfBundle(ids[i], i + 1);
    if (!head) head = t;
    all.push(...t.episodes);
  }
  return {
    episodes: all,
    seriesTitle: head ? head.seriesTitle : "",
    posterUrl: head ? head.posterUrl : "",
    backdropUrl: head ? head.backdropUrl : "",
    season: 1,
  };
}

export async function episodes(ref) {
  await null;
  const own = decodeRef(ref);
  if (!own) throw kino.error("not_found", "esa referencia no es de Caracol");
  let season;
  try {
    season = own.contentType === "GROUP_OF_BUNDLES" ? await episodesOfGroup(own.contentId) : await episodesOfBundle(own.contentId, 0);
  } catch (e) {
    log("episodes failed", own.contentId, e.message);
    throw e;
  }
  if (!season.episodes.length) throw new Error("no hay capítulos disponibles");
  return {
    series: {
      title: season.seriesTitle,
      poster: season.posterUrl,
      backdrop: season.backdropUrl,
    },
    episodes: season.episodes,
    season: season.season,
  };
}

// ---------- resolución (VOD / serie) ------------------------------------------------

/** El primer mensaje de los 7 flags, en el orden de la nativa. */
const BLOCKS = [
  ["isGeoBlocked", "solo disponible en Colombia"],
  ["isChannelNotSubscribed", "requiere suscripción"],
  ["isPCBlocked", "control parental activo"],
  ["isContentOOHBlocked", "contenido OOH bloqueado"],
  ["isGeofencedBlocked", "geofence bloqueado"],
  ["isSportBlackoutBlocked", "deportes en blackout"],
  ["isPlatformBlacklisted", "plataforma no permitida"],
];

function entitlementBlock(userData) {
  const list = userData && userData.resultObj && Array.isArray(userData.resultObj.containers) ? userData.resultObj.containers : [];
  const ent = list[0] && list[0].entitlement;
  if (!ent) return null;
  for (const [flag, message] of BLOCKS) {
    // `=== true` y no Boolean(ent[flag]): el API manda strings, y un Boolean truthy diría "true" para "false".
    if (ent[flag] === true) return message;
  }
  return null;
}

async function checkEntitlement(path) {
  const data = await get(path);
  const reason = entitlementBlock(data);
  if (reason) throw new Error("Caracol: " + reason);
}

/** Id y assetId del primer capítulo reproducible: 1 capítulo para BUNDLE, primer VOD reproducible
 *   del primer hijo de cada BUNDLE para GROUP_OF_BUNDLES. */
async function firstPlayableOfGroup(groupId) {
  const json = await get("TRAY/SEARCH/VOD", { filter_parentId: groupId, filter_contentType: "BUNDLE" });
  const ids = containers(json).map((c) => c && c.id ? String(c.id).trim() : "").filter(Boolean);
  for (const bundleId of ids) {
    try {
      const detail = await get("CONTENT/DETAIL/BUNDLE/" + encodeURIComponent(bundleId));
      const outer = containers(detail)[0];
      if (!outer) continue;
      const raw = Array.isArray(outer.containers) ? outer.containers : [];
      for (const ep of raw) {
        if (!ep || !ep.id) continue;
        const asset = assetMaster(ep);
        if (asset) return { contentId: String(ep.id).trim(), assetId: asset };
      }
    } catch (e) {
      log("firstPlayable failed on bundle", bundleId, e.message);
    }
  }
  throw new Error("ningún capítulo de la serie está disponible para reproducir");
}

async function firstPlayableOfBundle(bundleId) {
  const detail = await get("CONTENT/DETAIL/BUNDLE/" + encodeURIComponent(bundleId));
  const outer = containers(detail)[0];
  if (!outer) throw new Error("Caracol no devolvió el detalle de " + bundleId);
  const raw = Array.isArray(outer.containers) ? outer.containers : [];
  for (const ep of raw) {
    if (!ep || !ep.id) continue;
    const asset = assetMaster(ep);
    if (asset) return { contentId: String(ep.id).trim(), assetId: asset };
  }
  throw new Error("ningún capítulo de " + bundleId + " se puede reproducir");
}

async function firstPlayableOfVod(vodId) {
  const detail = await get("CONTENT/DETAIL/VOD/" + encodeURIComponent(vodId));
  const outer = containers(detail)[0];
  if (!outer) throw new Error("Caracol no devolvió el detalle de " + vodId);
  const asset = assetMaster(outer);
  if (!asset) throw new Error("Caracol no tiene un asset reproducible para " + vodId);
  return { contentId: vodId, assetId: asset };
}

/** Tres pasos: DETAIL → USERDATA (entitlement) → VIDEOURL. Devuelve { url, mime, drm }. */
async function vodPlayable(contentId, assetId) {
  await checkEntitlement("CONTENT/USERDATA/VOD/" + encodeURIComponent(contentId));
  const r = await getWithToken("CONTENT/VIDEOURL/VOD/" + encodeURIComponent(contentId) + "/" + assetId);
  const src = r.json && r.json.resultObj ? String(r.json.resultObj.src || "").trim() : "";
  if (!src) throw new Error("Caracol no devolvió una URL de video para " + contentId);
  const drm = { type: "widevine", licenseUrl: LICENSE, licenseHeaders: {} };
  if (r.token) drm.licenseHeaders.Cookie = COOKIE_TOKEN + "=" + r.token;
  // Headers Required por el CDN en TODA request (manifest, segmentos y licencia): sin ellos el server
  // responde HTML/403 aunque el .mpd sea válido. El SDK del plugin solo adjunta `headers` en cada
  // request del Stream, y `licenseHeaders` solo en la licencia -- mandamos ambos grupos en `headers`
  // para que viajen en todo.
  const streamHeaders = { ...REQUEST_HEADERS };
  if (r.token) streamHeaders.Cookie = COOKIE_TOKEN + "=" + r.token;
  return { url: src, mime: "application/dash+xml", drm, headers: streamHeaders };
}

export async function resolve(ref) {
  await null;
  const own = decodeRef(ref);
  if (!own) throw kino.error("not_found", "esa referencia no es de Caracol");
  let pair;
  try {
    if (own.contentType === "GROUP_OF_BUNDLES") pair = await firstPlayableOfGroup(own.contentId);
    else if (own.contentType === "BUNDLE") pair = await firstPlayableOfBundle(own.contentId);
    else pair = await firstPlayableOfVod(own.contentId);
  } catch (e) {
    log("resolve detail failed", own.contentId, e.message);
    throw e;
  }
  try {
    return await vodPlayable(pair.contentId, pair.assetId);
  } catch (e) {
    log("resolve playable failed", pair.contentId, e.message);
    throw e;
  }
}

// ---------- canales en vivo (apiVersion 3, capability `channels`) --------------------

/** Logo del canal: logoMedium, sino Big, sino Small. */
function channelLogo(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return list.find((a) => a && a.logoMedium) ? String(list.find((a) => a.logoMedium).logoMedium)
    : list.find((a) => a && a.logoBig) ? String(list.find((a) => a.logoBig).logoBig)
    : list.find((a) => a && a.logoSmall) ? String(list.find((a) => a.logoSmall).logoSmall)
    : "";
}

function channelOf(c) {
  const m = (c.metadata || {});
  if (m.isActive !== true) return null;
  const id = m.channelId && m.channelId !== 0 ? m.channelId : null;
  const name = String(m.channelName || "").trim();
  const assetId = assetMaster(c);
  if (!id || !name || !assetId) return null;
  return { channelId: id, name, assetId, logo: channelLogo(c.assets) };
}

/** Resuelve un canal a su stream DASH (2 pasos: USERDATA + VIDEOURL). */
async function livePlayable(channelId, assetId, name) {
  await checkEntitlement("CONTENT/USERDATA/LIVE/" + channelId);
  const r = await getWithToken("CONTENT/VIDEOURL/LIVE/" + channelId + "/" + assetId);
  const src = r.json && r.json.resultObj ? String(r.json.resultObj.src || "").trim() : "";
  if (!src) throw new Error("Caracol no devolvió una URL de video para " + name);
  const drm = { type: "widevine", licenseUrl: LICENSE, licenseHeaders: {} };
  if (r.token) drm.licenseHeaders.Cookie = COOKIE_TOKEN + "=" + r.token;
  // Mismo motivo que en [vodPlayable]: el CDN de Caracol exige `restful: yes`, `User-Agent` y la
  // cookie `playback_token` en cada request, no solo en la licencia.
  const streamHeaders = { ...REQUEST_HEADERS };
  if (r.token) streamHeaders.Cookie = COOKIE_TOKEN + "=" + r.token;
  return { url: src, mime: "application/dash+xml", drm, headers: streamHeaders };
}

export async function liveCategories() {
  return { categories: [{ id: "all", title: "Canales en vivo" }], playlists: [] };
}

export async function liveChannels({ categoryId, cursor }) {
  await null;
  const json = await get("TRAY/LIVECHANNELS", { orderBy: "orderId", sortOrder: "asc" });
  const channels = containers(json).map(channelOf).filter(Boolean);
  const items = [];
  for (const ch of channels) {
    let stream = null;
    try {
      stream = await livePlayable(ch.channelId, ch.assetId, ch.name);
    } catch (e) {
      log("channel failed", ch.name, e.message);
      continue;
    }
    items.push({
      id: String(ch.channelId),
      title: ch.name,
      ref: "",
      logo: ch.logo,
      number: 0,
      categoryId: "all",
      stream,
    });
  }
  return { items, next: null };
}