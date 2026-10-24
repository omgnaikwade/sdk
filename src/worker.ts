import { Song } from "./index";
import { runOperation } from "./saavn/run-operation";
import { SaavnWebRadio } from "./saavn/operations/index.js";
import { fetchFromSaavn } from "./helpers/fetch.js";

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


// Reco/radio khali aaye to artist/album search se similar songs banao
async function getSimilar(songId: string, limit: number) {
  try {
    const r: any = await Song.getRecommendations({ songId });
    if (Array.isArray(r) && r.length > 0) {
      return { songs: r.slice(0, limit), via: "recommendations" };
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
  return { songs: songs.slice(0, limit), via: "search-fallback" };
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
        out.egress = t.split("\n").filter((l) => /^(ip|loc|colo)=/.test(l));
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
