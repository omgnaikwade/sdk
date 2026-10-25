import { Song } from "./index";
import { runOperation } from "./saavn/run-operation";
import { SaavnWebRadio } from "./saavn/operations/index.js";
import { fetchFromSaavn } from "./helpers/fetch.js";
import { mapSong } from "./saavn/common-mapper.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
  });
}

function errorDetails(error: unknown) {
  const err = error as {
    message?: string;
    code?: string;
    details?: unknown;
    cause?: unknown;
  };

  return {
    error: err.message ?? "Unknown error",
    code: err.code ?? null,
    details: err.details ?? null,
    cause: err.cause instanceof Error ? err.cause.message : null,
  };
}


type RadioResult = { stationId: string; songs: unknown[] };

// Saavn radio: next=1 pehle try karo (naye songs), fail ho to next=0
async function fetchRadioSongs(stationId: string, limit: number) {
  let lastError: unknown = null;

  for (const next of ["1", "0"] as const) {
    try {
      const result = (await runOperation(SaavnWebRadio.songs, {
        ctx: "android",
        stationid: stationId,
        k: String(limit),
        next,
      })) as RadioResult;

      if (result.songs && result.songs.length > 0) {
        return { result, next };
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Radio returned no songs");
}

async function createStation(songId: string) {
  return runOperation(SaavnWebRadio.createEntityStation, {
    ctx: "android",
    entity_type: "queue",
    entity_id: JSON.stringify([songId]),
  });
}



function decodeHtml(v: unknown) {
  if (typeof v !== "string") return v;
  return v
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanSong(song: any) {
  if (!song) return song;
  song.title = decodeHtml(song.title);
  song.subtitle = decodeHtml(song.subtitle);
  if (song.album) song.album.title = decodeHtml(song.album.title);
  return song;
}

// Saavn reco sirf ctx=android pe data deta hai, aur response { [songId]: [songs] } hota hai
async function getAndroidReco(songId: string, limit: number) {
  const res = await fetchFromSaavn({
    call: "reco.getreco",
    params: { pid: songId, ctx: "android" },
    context: "android",
  });

  const data: any = res.data;
  let list: any[] = [];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object") {
    list = Array.isArray(data[songId])
      ? data[songId]
      : (Object.values(data).find((v) => Array.isArray(v)) as any[]) ?? [];
  }

  const songs: any[] = [];
  for (const raw of list) {
    try {
      songs.push(mapSong(raw));
    } catch {
      // schema mismatch -> skip this item
    }
  }
  return songs.slice(0, limit);
}

// ---------- Vybe (saavn.dev) se stream URLs + merge ----------
const VYBE_BASE = "https://vybe.vyoma-apps.workers.dev";
const QUALITY_ORDER = ["320kbps", "160kbps", "96kbps", "48kbps", "12kbps"];

const shuffleArr = <T,>(a: T[]): T[] => {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
};

async function vybeGet(path: string): Promise<any> {
  const r = await fetch(VYBE_BASE + path, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as any);
  return r.json();
}

// IDs -> { id: vybeSong }. Pehle batch (?ids=), fail ho to ek ek karke
async function fetchVybeSongs(ids: string[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  const unique = [...new Set(ids)];

  for (let i = 0; i < unique.length; i += 10) {
    const chunk = unique.slice(i, i + 10);
    let list: any[] = [];

    try {
      const j = await vybeGet("/api/songs?ids=" + chunk.join(","));
      if (Array.isArray(j?.data)) list = j.data;
    } catch {
      // single fallback below
    }

    if (list.length === 0) {
      const singles = await Promise.all(
        chunk.map(async (id) => {
          try {
            const j = await vybeGet("/api/songs/" + id);
            return Array.isArray(j?.data) ? j.data[0] : j?.data;
          } catch {
            return null;
          }
        }),
      );
      list = singles.filter(Boolean);
    }

    for (const song of list) if (song?.id) map.set(song.id, song);
  }

  return map;
}

function mergeSong(meta: any, vy: any, quality: string) {
  const streams: Record<string, string> = {};
  for (const d of vy?.downloadUrl ?? []) {
    if (d?.quality && d?.url) streams[d.quality] = d.url;
  }

  const wanted = QUALITY_ORDER.includes(quality) ? quality : "160kbps";
  const chain = [wanted, ...QUALITY_ORDER.filter((q) => q !== wanted)];
  const streamUrl = chain.map((q) => streams[q]).find(Boolean) ?? null;

  const artists = (vy?.artists?.primary ?? meta?.artists?.primary ?? [])
    .map((a: any) => a?.name)
    .filter(Boolean);

  const imgs = vy?.image ?? meta?.images ?? [];
  const image = imgs.length ? imgs[imgs.length - 1]?.url ?? null : null;

  return {
    id: vy?.id ?? meta?.id,
    title: decodeHtml(vy?.name ?? meta?.title),
    artists: artists.map(decodeHtml),
    album: decodeHtml(vy?.album?.name ?? meta?.album?.title) ?? null,
    image,
    duration: Number(vy?.duration ?? meta?.duration) || null,
    year: vy?.year ?? meta?.year ?? null,
    language: vy?.language ?? meta?.language ?? null,
    url: streamUrl,
    streams,
  };
}

async function mergeWithStreams(metas: any[], quality: string) {
  const vy = await fetchVybeSongs(metas.map((m) => m.id));
  return metas
    .map((m) => mergeSong(m, vy.get(m.id), quality))
    .filter((s) => s.url);
}

// ================= VYBE QUEUE ENGINE v1 =================
// Idea: multi-seed collaborative signal + taste filters + diversity re-rank
//  1. Har seed (current + liked/recent good songs) ke Saavn recos lo
//  2. Jo song kai seeds ke recos me aaye, uska score badhao (consensus)
//  3. Language / artist affinity, popularity, year closeness se score adjust
//  4. Skipped artists ko penalty, liked artists ko boost, variants/duplicates hatao
//  5. Diversity re-rank: ek artist ke 2 se zyada nahi, back-to-back same artist nahi
//  6. 2 exploration songs beech me, taaki queue boring na ho
const recoCache = new Map<string, { t: number; v: any[] }>();
const RECO_TTL_MS = 30 * 60 * 1000;
const SEED_WEIGHTS = [1, 0.55, 0.4, 0.3];
const DISCOVER_SEED_WEIGHTS = [1, 0.7, 0.55, 0.4, 0.3, 0.25];

async function cachedReco(songId: string): Promise<any[]> {
  const hit = recoCache.get(songId);
  if (hit && Date.now() - hit.t < RECO_TTL_MS) return hit.v;

  let list: any[] = [];
  try {
    list = await getAndroidReco(songId, 40);
  } catch {
    list = [];
  }

  if (list.length > 0) {
    recoCache.set(songId, { t: Date.now(), v: list });
    if (recoCache.size > 300) {
      const first = recoCache.keys().next().value;
      if (first) recoCache.delete(first);
    }
  }
  return list;
}

function baseTitle(t: unknown): string {
  return String(decodeHtml(t) ?? "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(
      /\b(remix|lofi|lo-fi|reprise|unplugged|acoustic|slowed|reverb|version|cover|mashup|instrumental|from|film|movie|original|soundtrack|sped up|8d|bass boosted)\b/g,
      " ",
    )
    .replace(/[^a-z0-9\u0900-\u097f ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const artistKey = (s: any): string =>
  String(s?.artists?.primary?.[0]?.id ?? s?.artists?.primary?.[0]?.name ?? "")
    .toLowerCase();

const csv = (v: string | null): string[] =>
  (v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

async function buildQueueIds(opts: {
  seeds: string[];
  exclude: Set<string>;
  skipped: string[];
  liked: string[];
  target: number;
  debug: boolean;
}) {
  const { seeds, exclude, skipped, liked, target } = opts;
  const firstSeed = seeds[0] as string;

  // 1) recos + seed/skipped/liked metadata, parallel
  const metaIds = [
    ...new Set([...seeds, ...skipped.slice(0, 8), ...liked.slice(0, 5)]),
  ];
  const [recoLists, metaRes] = await Promise.all([
    Promise.all(seeds.map((id) => cachedReco(id))),
    Song.getById({ songIds: metaIds }).catch(() => null) as Promise<any>,
  ]);

  const meta = new Map<string, any>();
  for (const sg of (metaRes as any)?.songs ?? []) meta.set(sg.id, sg);

  const seed0 = meta.get(firstSeed);
  const lang0 = String(seed0?.language ?? "").toLowerCase();
  const year0 = Number(seed0?.year) || 0;
  const seedArtists = new Set(seeds.map((id) => artistKey(meta.get(id))).filter(Boolean));
  const skippedArtists = new Set(skipped.map((id) => artistKey(meta.get(id))).filter(Boolean));
  const likedArtists = new Set(liked.map((id) => artistKey(meta.get(id))).filter(Boolean));
  const seedTitles = new Set(
    seeds.map((id) => baseTitle(meta.get(id)?.title)).filter(Boolean),
  );

  // 2) candidates + consensus score
  const cand = new Map<string, { song: any; score: number; hits: number }>();
  const addList = (list: any[], w: number) => {
    list.forEach((song, rank) => {
      if (!song?.id || exclude.has(song.id)) return;
      const c = cand.get(song.id) ?? { song, score: 0, hits: 0 };
      c.score += w * (1 - rank / (list.length + 5));
      c.hits += 1;
      cand.set(song.id, c);
    });
  };
  recoLists.forEach((list, i) => addList(list, SEED_WEIGHTS[i] ?? 0.25));

  // 2b) 2-hop expansion: pool chhota ho to top recos ke apne recos lo (alag artists aate hain)
  let expanded = false;
  if (cand.size < 45) {
    const hop = [...cand.values()]
      .sort((x, y) => y.score - x.score)
      .slice(0, 5)
      .map((c) => c.song.id as string);
    const hopLists = await Promise.all(hop.map((id) => cachedReco(id)));
    hopLists.forEach((list) => addList(list, 0.3));
    expanded = hop.length > 0;
  }

  // 2c) abhi bhi kam ho to seed language ke trending songs (artist-search nahi)
  let usedTrending = false;
  if (cand.size < target + 6) {
    try {
      const trend: any = await Song.getTrending({ language: lang0 || "hindi" });
      const list: any[] = Array.isArray(trend) ? trend : trend?.songs ?? [];
      list.forEach((song) => {
        if (!song?.id || exclude.has(song.id) || cand.has(song.id)) return;
        cand.set(song.id, { song, score: 0.05, hits: 0 });
      });
      usedTrending = true;
    } catch {
      // ignore
    }
  }

  // 3) taste adjustments + filters
  const scored: { id: string; song: any; score: number; hits: number }[] = [];
  for (const [id, c] of cand) {
    const song = c.song;
    const dur = Number(song.duration) || 0;
    if (dur && (dur < 60 || dur > 720)) continue;

    const bt = baseTitle(song.title);
    if (bt && seedTitles.has(bt)) continue; // same song ka remix/version

    let score = c.score;
    if (c.hits > 1) score += 0.35 * (c.hits - 1);

    const lang = String(song.language ?? "").toLowerCase();
    if (lang0 && lang) score += lang === lang0 ? 0.35 : -0.25;

    const ak = artistKey(song);
    if (ak && seedArtists.has(ak)) score += 0.05; // artist ka bonus chhota, taaki queue artist-only na ho
    if (ak && likedArtists.has(ak)) score += 0.15;
    if (ak && skippedArtists.has(ak)) score -= 1.2;

    const pc = Number(song.stats?.playCount) || 0;
    score += Math.min(0.3, Math.log10(pc + 1) / 20);

    const yr = Number(song.year) || 0;
    if (year0 && yr && Math.abs(yr - year0) <= 3) score += 0.1;

    scored.push({ id, song, score, hits: c.hits });
  }

  // 4) duplicate versions hatao (same title + same artist => best score rakho)
  scored.sort((x, y) => y.score - x.score);
  const seenKey = new Set<string>();
  const unique = scored.filter((c) => {
    const key = baseTitle(c.song.title) + "|" + artistKey(c.song);
    if (seenKey.has(key)) return false;
    seenKey.add(key);
    return true;
  });

  // 5) last resort: kuch bhi na mile to search-based similar (relaxed artist cap)
  let relaxed = false;
  if (unique.length === 0) {
    try {
      const sim = await getSimilar(firstSeed, 30);
      for (const song of sim.songs) {
        if (!song?.id || exclude.has(song.id)) continue;
        unique.push({ id: song.id, song, score: 0.1, hits: 0 });
      }
      relaxed = true;
    } catch {
      // ignore
    }
  }

  if (unique.length === 0) return { ids: [] as string[], debug: [] as any[], stats: {} };

  // 6) diversity re-rank (greedy) — artist cap 2 (fill me bhi lagta hai)
  const artistCap = relaxed ? 4 : 2;
  const pool = unique.slice(0, 50);
  const chosen: typeof pool = [];
  const artistCount = new Map<string, number>();
  const albumCount = new Map<string, number>();
  let lastArtist = "";
  const exploreSlots = target >= 10 ? 2 : 0;
  const mainTarget = target - exploreSlots;
  const mainPool = pool.slice(0, 30);

  const take = (pick: (typeof pool)[number]) => {
    const ak = artistKey(pick.song);
    const al = String(pick.song.album?.id ?? pick.song.album?.title ?? "");
    artistCount.set(ak, (artistCount.get(ak) ?? 0) + 1);
    if (al) albumCount.set(al, (albumCount.get(al) ?? 0) + 1);
    lastArtist = ak;
    chosen.push(pick);
  };

  while (chosen.length < mainTarget && mainPool.length > 0) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < mainPool.length; i++) {
      const c = mainPool[i];
      if (!c) continue;
      const ak = artistKey(c.song);
      const al = String(c.song.album?.id ?? c.song.album?.title ?? "");
      if ((artistCount.get(ak) ?? 0) >= artistCap) continue;
      if (al && (albumCount.get(al) ?? 0) >= 2) continue;
      const v =
        c.score -
        0.6 * (artistCount.get(ak) ?? 0) -
        0.4 * (albumCount.get(al) ?? 0) -
        (ak && ak === lastArtist ? 1.0 : 0) +
        Math.random() * 0.15;
      if (v > bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const pick = mainPool.splice(bestIdx, 1)[0];
    if (!pick) break;
    take(pick);
  }

  // 7) exploration: neeche ranked songs me se random 2 (artist cap ke andar)
  const chosenIds = new Set(chosen.map((c) => c.id));
  const explorePool = shuffleArr(
    pool.slice(12).filter(
      (c) =>
        !chosenIds.has(c.id) &&
        (artistCount.get(artistKey(c.song)) ?? 0) < artistCap,
    ),
  ).slice(0, exploreSlots);
  explorePool.forEach((c, i) => {
    chosen.splice(Math.min(4 + i * 4, chosen.length), 0, c);
    const ak = artistKey(c.song);
    artistCount.set(ak, (artistCount.get(ak) ?? 0) + 1);
  });

  // 8) fill: bacha pool, lekin artist cap todke nahi (pehle cap, phir cap+1)
  for (const cap of [artistCap, artistCap + 1]) {
    for (const c of unique) {
      if (chosen.length >= target) break;
      if (chosen.some((x) => x.id === c.id)) continue;
      const ak = artistKey(c.song);
      if ((artistCount.get(ak) ?? 0) >= cap) continue;
      chosen.push(c);
      artistCount.set(ak, (artistCount.get(ak) ?? 0) + 1);
    }
  }

  const stats = {
    candidates: cand.size,
    afterFilter: unique.length,
    expanded,
    usedTrending,
    relaxed,
    uniqueArtists: new Set(chosen.map((c) => artistKey(c.song))).size,
  };

  return {
    ids: chosen.map((c) => c.id),
    debug: opts.debug
      ? chosen.map((c) => ({
          id: c.id,
          title: decodeHtml(c.song.title),
          artist: c.song.artists?.primary?.[0]?.name,
          score: Number(c.score.toFixed(3)),
          hits: c.hits,
        }))
      : [],
    stats,
  };
}

// ===== HOME DISCOVER ENGINE (queue se alag) =====
async function buildDiscoverIds(opts: {
  seeds: string[];
  exclude: Set<string>;
  skipped: string[];
  liked: string[];
  target: number;
  debug: boolean;
  langs: string[];
}) {
  const { seeds, exclude, skipped, liked, target, langs } = opts;
  const firstSeed = seeds[0] ?? "";

  // 1) recos + seed/skipped/liked metadata, parallel
  const metaIds = [
    ...new Set([...seeds, ...skipped.slice(0, 8), ...liked.slice(0, 5)]),
  ];
  const [recoLists, metaRes] = await Promise.all([
    Promise.all(seeds.map((id) => cachedReco(id))),
    (metaIds.length > 0
      ? Song.getById({ songIds: metaIds }).catch(() => null)
      : Promise.resolve(null)) as Promise<any>,
  ]);

  const meta = new Map<string, any>();
  for (const sg of (metaRes as any)?.songs ?? []) meta.set(sg.id, sg);

  const seed0 = meta.get(firstSeed);
  const lang0 = String(seed0?.language ?? "").toLowerCase();
  const year0 = Number(seed0?.year) || 0;
  // user ki pasandida languages (taste) > seed ki language
  const prefLangs = langs.length > 0 ? langs : lang0 ? [lang0] : [];
  const seedArtists = new Set(seeds.map((id) => artistKey(meta.get(id))).filter(Boolean));
  const skippedArtists = new Set(skipped.map((id) => artistKey(meta.get(id))).filter(Boolean));
  const likedArtists = new Set(liked.map((id) => artistKey(meta.get(id))).filter(Boolean));
  const seedTitles = new Set(
    seeds.map((id) => baseTitle(meta.get(id)?.title)).filter(Boolean),
  );

  // 2) candidates + consensus score
  const cand = new Map<string, { song: any; score: number; hits: number }>();
  const addList = (list: any[], w: number) => {
    list.forEach((song, rank) => {
      if (!song?.id || exclude.has(song.id)) return;
      const c = cand.get(song.id) ?? { song, score: 0, hits: 0 };
      c.score += w * (1 - rank / (list.length + 5));
      c.hits += 1;
      cand.set(song.id, c);
    });
  };
  recoLists.forEach((list, i) => addList(list, DISCOVER_SEED_WEIGHTS[i] ?? 0.25));

  // 2b) 2-hop expansion: pool chhota ho to top recos ke apne recos lo (alag artists aate hain)
  let expanded = false;
  if (cand.size < 45) {
    const hop = [...cand.values()]
      .sort((x, y) => y.score - x.score)
      .slice(0, 5)
      .map((c) => c.song.id as string);
    const hopLists = await Promise.all(hop.map((id) => cachedReco(id)));
    hopLists.forEach((list) => addList(list, 0.3));
    expanded = hop.length > 0;
  }

  // 2c) trending: taste languages ke liye hamesha (discover), warna pool kam ho to
  let usedTrending = false;
  const trendLangs = langs.length > 0 ? langs.slice(0, 2) : [lang0 || "hindi"];
  if (langs.length > 0 || cand.size < target + 6) {
    const lists = await Promise.all(
      trendLangs.map(async (l) => {
        try {
          const t: any = await Song.getTrending({ language: l });
          return (Array.isArray(t) ? t : t?.songs ?? []) as any[];
        } catch {
          return [] as any[];
        }
      }),
    );
    lists.forEach((list, i) => {
      if (langs.length > 0) {
        addList(list, i === 0 ? 0.55 : 0.3);
      } else {
        list.forEach((song) => {
          if (!song?.id || exclude.has(song.id) || cand.has(song.id)) return;
          cand.set(song.id, { song, score: 0.05, hits: 0 });
        });
      }
    });
    usedTrending = lists.some((l) => l.length > 0);
  }

  // 3) taste adjustments + filters
  const scored: { id: string; song: any; score: number; hits: number }[] = [];
  for (const [id, c] of cand) {
    const song = c.song;
    const dur = Number(song.duration) || 0;
    if (dur && (dur < 60 || dur > 720)) continue;

    const bt = baseTitle(song.title);
    if (bt && seedTitles.has(bt)) continue; // same song ka remix/version

    let score = c.score;
    if (c.hits > 1) score += 0.35 * (c.hits - 1);

    const lang = String(song.language ?? "").toLowerCase();
    if (prefLangs.length > 0 && lang) {
      const li = prefLangs.indexOf(lang);
      score += li === 0 ? 0.4 : li > 0 ? 0.2 : -0.3;
    }

    const ak = artistKey(song);
    if (ak && seedArtists.has(ak)) score += 0.05; // artist ka bonus chhota, taaki queue artist-only na ho
    if (ak && likedArtists.has(ak)) score += 0.15;
    if (ak && skippedArtists.has(ak)) score -= 1.2;

    const pc = Number(song.stats?.playCount) || 0;
    score += Math.min(0.3, Math.log10(pc + 1) / 20);

    const yr = Number(song.year) || 0;
    if (year0 && yr && Math.abs(yr - year0) <= 3) score += 0.1;

    scored.push({ id, song, score, hits: c.hits });
  }

  // 4) duplicate versions hatao (same title + same artist => best score rakho)
  scored.sort((x, y) => y.score - x.score);
  const seenKey = new Set<string>();
  const unique = scored.filter((c) => {
    const key = baseTitle(c.song.title) + "|" + artistKey(c.song);
    if (seenKey.has(key)) return false;
    seenKey.add(key);
    return true;
  });

  // 5) last resort: kuch bhi na mile to search-based similar (relaxed artist cap)
  let relaxed = false;
  if (unique.length === 0 && firstSeed) {
    try {
      const sim = await getSimilar(firstSeed, 30);
      for (const song of sim.songs) {
        if (!song?.id || exclude.has(song.id)) continue;
        unique.push({ id: song.id, song, score: 0.1, hits: 0 });
      }
      relaxed = true;
    } catch {
      // ignore
    }
  }

  if (unique.length === 0) return { ids: [] as string[], debug: [] as any[], stats: {} };

  // 6) diversity re-rank (greedy) — artist cap 2 (fill me bhi lagta hai)
  const artistCap = relaxed ? 4 : 2;
  const pool = unique.slice(0, 50);
  const chosen: typeof pool = [];
  const artistCount = new Map<string, number>();
  const albumCount = new Map<string, number>();
  let lastArtist = "";
  const exploreSlots = target >= 10 ? 2 : 0;
  const mainTarget = target - exploreSlots;
  const mainPool = pool.slice(0, 30);

  const take = (pick: (typeof pool)[number]) => {
    const ak = artistKey(pick.song);
    const al = String(pick.song.album?.id ?? pick.song.album?.title ?? "");
    artistCount.set(ak, (artistCount.get(ak) ?? 0) + 1);
    if (al) albumCount.set(al, (albumCount.get(al) ?? 0) + 1);
    lastArtist = ak;
    chosen.push(pick);
  };

  while (chosen.length < mainTarget && mainPool.length > 0) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < mainPool.length; i++) {
      const c = mainPool[i];
      if (!c) continue;
      const ak = artistKey(c.song);
      const al = String(c.song.album?.id ?? c.song.album?.title ?? "");
      if ((artistCount.get(ak) ?? 0) >= artistCap) continue;
      if (al && (albumCount.get(al) ?? 0) >= 2) continue;
      const v =
        c.score -
        0.6 * (artistCount.get(ak) ?? 0) -
        0.4 * (albumCount.get(al) ?? 0) -
        (ak && ak === lastArtist ? 1.0 : 0) +
        Math.random() * 0.15;
      if (v > bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const pick = mainPool.splice(bestIdx, 1)[0];
    if (!pick) break;
    take(pick);
  }

  // 7) exploration: neeche ranked songs me se random 2 (artist cap ke andar)
  const chosenIds = new Set(chosen.map((c) => c.id));
  const explorePool = shuffleArr(
    pool.slice(12).filter(
      (c) =>
        !chosenIds.has(c.id) &&
        (artistCount.get(artistKey(c.song)) ?? 0) < artistCap,
    ),
  ).slice(0, exploreSlots);
  explorePool.forEach((c, i) => {
    chosen.splice(Math.min(4 + i * 4, chosen.length), 0, c);
    const ak = artistKey(c.song);
    artistCount.set(ak, (artistCount.get(ak) ?? 0) + 1);
  });

  // 8) fill: bacha pool, lekin artist cap todke nahi (pehle cap, phir cap+1)
  for (const cap of [artistCap, artistCap + 1]) {
    for (const c of unique) {
      if (chosen.length >= target) break;
      if (chosen.some((x) => x.id === c.id)) continue;
      const ak = artistKey(c.song);
      if ((artistCount.get(ak) ?? 0) >= cap) continue;
      chosen.push(c);
      artistCount.set(ak, (artistCount.get(ak) ?? 0) + 1);
    }
  }

  const stats = {
    candidates: cand.size,
    afterFilter: unique.length,
    expanded,
    usedTrending,
    prefLangs,
    relaxed,
    uniqueArtists: new Set(chosen.map((c) => artistKey(c.song))).size,
  };

  return {
    ids: chosen.map((c) => c.id),
    debug: opts.debug
      ? chosen.map((c) => ({
          id: c.id,
          title: decodeHtml(c.song.title),
          artist: c.song.artists?.primary?.[0]?.name,
          score: Number(c.score.toFixed(3)),
          hits: c.hits,
        }))
      : [],
    stats,
  };
}

// Reco/radio khali aaye to artist/album search se similar songs banao
async function getSimilar(songId: string, limit: number) {
  try {
    const r = await getAndroidReco(songId, limit);
    if (r.length > 0) {
      return { songs: r.map(cleanSong), via: "recommendations" };
    }
  } catch {
    // ignore, fallback below
  }

  const details: any = await Song.getById({ songIds: songId });
  const seed = details?.songs?.[0];
  if (!seed) throw new Error("Seed song not found for id: " + songId);

  const artist = seed.artists?.primary?.[0]?.name;
  const queries = [artist, seed.album?.title, seed.title].filter(Boolean);

  const seen = new Set<string>([songId]);
  const songs: any[] = [];

  for (const q of queries) {
    try {
      const res: any = await Song.search({ query: q as string, limit: 30 });
      for (const item of res?.results ?? []) {
        if (item?.id && !seen.has(item.id)) {
          seen.add(item.id);
          songs.push(item);
        }
      }
    } catch {
      // next query
    }
    if (songs.length >= limit) break;
  }

  if (songs.length === 0) throw new Error("No similar songs found");
  return { songs: songs.slice(0, limit).map(cleanSong), via: "search-fallback" };
}

async function peek(call: string, params: Record<string, string>, context: "web6dot0" | "android") {
  try {
    const res = await fetchFromSaavn({ call, params, context });
    return { status: res.status, body: JSON.stringify(res.data).slice(0, 300) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "GET") {
      return json({ success: false, error: "Method not allowed" }, 405);
    }

    // Health check
    if (url.pathname === "/") {
      return json({
        status: "ok",
        message: "Saavn SDK API is running",
        endpoints: [
          "/search?q=Tum%20Hi%20Ho  (ids + stream urls)",
          "/queue?seeds=ID1,ID2&exclude=PLAYED1&limit=10  (radio + stream urls)",
          "/discover?seeds=ID1,ID2&langs=marathi,hindi&limit=16  (home feed)",
          "/api/search?q=Tum%20Hi%20Ho",
          "/api/recommendations?id=SONG_ID",
          "/api/radio/start?id=SONG_ID&limit=20",
          "/api/radio/next?id=STATION_ID&limit=20&seed=SONG_ID",
          "/api/debug?id=SONG_ID",
        ],
      });
    }

    // Song search
    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q")?.trim();

      if (!query) {
        return json(
          { success: false, error: "Missing q parameter" },
          400,
        );
      }

      const limit = Math.min(
        50,
        Math.max(1, Number(url.searchParams.get("limit")) || 20),
      );

      const offset = Math.max(
        1,
        Number(url.searchParams.get("page")) || 1,
      );

      try {
        const results = await Song.search({
          query,
          limit,
          offset,
        });

        return json({
          success: true,
          query,
          page: offset,
          results,
        });
      } catch (error) {
        return json(
          { success: false, ...errorDetails(error) },
          502,
        );
      }
    }

    // Song recommendations
    if (url.pathname === "/api/recommendations") {
      const songId = url.searchParams.get("id")?.trim();

      if (!songId) {
        return json(
          {
            success: false,
            error: "Missing song ID. Use ?id=SONG_ID",
          },
          400,
        );
      }

      try {
        const { songs, via } = await getSimilar(
          songId,
          Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20)),
        );

        return json({
          success: true,
          source: via,
          seedSongId: songId,
          results: songs,
        });
      } catch (error) {
        return json(
          { success: false, ...errorDetails(error) },
          502,
        );
      }
    }

    // Create radio station (+ first songs in one go)
    if (url.pathname === "/api/radio/start") {
      const songId = url.searchParams.get("id")?.trim();

      if (!songId) {
        return json(
          { success: false, error: "Missing song ID. Use ?id=SONG_ID" },
          400,
        );
      }

      const limit = Math.min(
        50,
        Math.max(1, Number(url.searchParams.get("limit")) || 20),
      );

      try {
        const station = await createStation(songId);

        try {
          const { result } = await fetchRadioSongs(station.stationId, limit);
          return json({
            success: true,
            source: "JioSaavn Web Radio",
            seedSongId: songId,
            station,
            songs: result.songs,
          });
        } catch {
          // Radio ne songs nahi diye -> recommendations fallback
          const { songs, via } = await getSimilar(songId, limit);
          return json({
            success: true,
            source: via + " (radio fallback)",
            seedSongId: songId,
            station,
            songs,
            fallback: true,
          });
        }
      } catch (error) {
        return json(
          { success: false, ...errorDetails(error) },
          502,
        );
      }
    }

    // Fetch radio songs
    // /api/radio/next?id=STATION_ID&limit=20&seed=SONG_ID(optional)
    if (url.pathname === "/api/radio/next") {
      const stationId = url.searchParams.get("id")?.trim();
      const seedId = url.searchParams.get("seed")?.trim();

      if (!stationId) {
        return json(
          { success: false, error: "Missing station ID. Use ?id=STATION_ID" },
          400,
        );
      }

      const limit = Math.min(
        50,
        Math.max(1, Number(url.searchParams.get("limit")) || 20),
      );

      try {
        const { result, next } = await fetchRadioSongs(stationId, limit);
        return json({
          success: true,
          source: "JioSaavn Web Radio",
          usedNext: next,
          result,
        });
      } catch (error) {
        // Station expire/empty ho gaya -> seed se naya station banao
        if (seedId) {
          try {
            const station = await createStation(seedId);
            const { result } = await fetchRadioSongs(station.stationId, limit);
            return json({
              success: true,
              source: "JioSaavn Web Radio (new station)",
              newStationId: station.stationId,
              result,
            });
          } catch {
            try {
              const { songs, via } = await getSimilar(seedId, limit);
              return json({
                success: true,
                source: via + " (radio fallback)",
                result: { stationId, songs },
                fallback: true,
              });
            } catch (fallbackError) {
              return json(
                { success: false, ...errorDetails(fallbackError) },
                502,
              );
            }
          }
        }

        return json(
          { success: false, ...errorDetails(error) },
          502,
        );
      }
    }

    // ===== Merged API: IDs yaha se, stream URLs Vybe se =====
    // /search?q=Tum Hi Ho&limit=20&page=1&quality=160kbps
    if (url.pathname === "/search") {
      const query = url.searchParams.get("q")?.trim();
      if (!query) {
        return json({ success: false, error: "Missing q parameter" }, 400);
      }

      const limit = Math.min(
        50,
        Math.max(1, Number(url.searchParams.get("limit")) || 20),
      );
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const quality = url.searchParams.get("quality") || "160kbps";

      try {
        const res: any = await Song.search({ query, limit, offset: page });
        const results = await mergeWithStreams(res?.results ?? [], quality);

        return json({
          success: true,
          query,
          page,
          count: results.length,
          results,
        });
      } catch (error) {
        return json({ success: false, ...errorDetails(error) }, 502);
      }
    }

    // ===== Vybe Queue + Discover Engine =====
    // App-compatible: { success, data: [ApiSong...] } (saavn.dev format, downloadUrl ke saath)
    // /queue?seeds=cur,s2,s3&exclude=a,b,c&skipped=x,y&liked=p,q&limit=10[&debug=1]
    // /discover?seeds=s1..s6&langs=marathi,hindi&exclude=..&limit=20  (Home: hero + Recommend For You)
    if (url.pathname === "/queue" || url.pathname === "/discover") {
      const isDiscover = url.pathname === "/discover";
      const seeds = csv(url.searchParams.get("seeds") || url.searchParams.get("id")).slice(
        0,
        isDiscover ? 6 : 4,
      );
      let langs = csv(url.searchParams.get("langs")).map((l) => l.toLowerCase());

      if (seeds.length === 0 && !isDiscover) {
        return json(
          { success: false, data: null, message: "Missing seeds. Use ?seeds=id1,id2" },
          400,
        );
      }
      if (isDiscover && seeds.length === 0 && langs.length === 0) {
        langs = ["hindi"]; // cold start
      }
      if (!isDiscover) langs = []; // queue me seed ki language hi chalegi

      const exclude = new Set<string>([
        ...seeds,
        ...csv(url.searchParams.get("exclude")),
      ]);
      const skipped = csv(url.searchParams.get("skipped"));
      const liked = csv(url.searchParams.get("liked"));
      const limit = Math.min(
        30,
        Math.max(1, Number(url.searchParams.get("limit")) || (isDiscover ? 16 : 10)),
      );
      const debug = url.searchParams.get("debug") === "1";

      try {
        const built = isDiscover
          ? await buildDiscoverIds({
              seeds,
              exclude,
              skipped,
              liked,
              langs,
              target: limit + 5,
              debug,
            })
          : await buildQueueIds({
              seeds,
              exclude,
              skipped,
              liked,
              target: limit + 5, // 5 spare, kyunki kuch songs ka URL missing ho sakta hai
              debug,
            });
        const { ids, debug: dbg, stats } = built;

        if (ids.length === 0) {
          return json(
            { success: false, data: [], message: "No songs found" },
            404,
          );
        }

        const vy = await fetchVybeSongs(ids);
        const data = ids
          .map((id) => vy.get(id))
          .filter((sg) => sg && Array.isArray(sg.downloadUrl) && sg.downloadUrl.length > 0)
          .slice(0, limit);

        return json({
          success: true,
          engine: isDiscover ? "vybe-discover-v1" : "vybe-queue-v1",
          count: data.length,
          data,
          ...(debug ? { stats, debug: dbg } : {}),
        });
      } catch (error) {
        return json(
          { success: false, data: null, message: (error as Error).message, ...errorDetails(error) },
          502,
        );
      }
    }

    // Debug: Saavn kya return kar raha hai
    if (url.pathname === "/api/debug") {
      const id = url.searchParams.get("id")?.trim() || "aRZbUYD7";
      const out: Record<string, unknown> = {
        cf: {
          country: (request as any).cf?.country,
          colo: (request as any).cf?.colo,
        },
      };

      try {
        const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
        out.egress = t.split("\n").filter((l: string) => /^(ip|loc|colo)=/.test(l));
      } catch {
        out.egress = "trace failed";
      }

      out.reco_web = await peek("reco.getreco", { pid: id }, "web6dot0");
      out.reco_android = await peek("reco.getreco", { pid: id, ctx: "android" }, "android");

      let stationId = "";
      try {
        const st: any = await createStation(id);
        stationId = st.stationId;
        out.station = stationId;
      } catch (e) {
        out.station = "create failed: " + (e as Error).message;
      }

      if (stationId) {
        for (const next of ["0", "1"]) {
          out["radio_android_next" + next] = await peek(
            "webradio.getSong",
            { stationid: stationId, k: "10", next, ctx: "android" },
            "android",
          );
          out["radio_web_next" + next] = await peek(
            "webradio.getSong",
            { stationid: stationId, k: "10", next },
            "web6dot0",
          );
        }
      }

      return json(out);
    }

    // Unknown endpoint
    return json(
      {
        success: false,
        error: "Endpoint not found",
        path: url.pathname,
      },
      404,
    );
  },
};
