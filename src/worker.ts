import { Song } from "./index";
import { runOperation } from "./saavn/run-operation";
import { SaavnWebRadio } from "./saavn/operations/index.js";

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
        const results = await Song.getRecommendations({
          songId,
        });

        return json({
          success: true,
          source: "JioSaavn Recommendations",
          seedSongId: songId,
          results,
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
          const songs = await Song.getRecommendations({ songId });
          return json({
            success: true,
            source: "JioSaavn Recommendations (radio fallback)",
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
              const songs = await Song.getRecommendations({ songId: seedId });
              return json({
                success: true,
                source: "JioSaavn Recommendations (radio fallback)",
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
