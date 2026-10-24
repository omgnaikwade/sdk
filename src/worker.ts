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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
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

    if (url.pathname === "/") {
      return json({
        status: "ok",
        message: "Saavn SDK API is running",
        endpoints: [
          "/api/search?q=Tum%20Hi%20Ho",
          "/api/radio/start?id=SONG_ID",
          "/api/radio/next?id=STATION_ID&next=true",
        ],
      });
    }

    // Existing song search endpoint
    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q")?.trim();

      if (!query) {
        return json({ success: false, error: "Missing q parameter" }, 400);
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

        return json({ success: true, query, page: offset, results });
      } catch (error) {
        return json({ success: false, error: errorMessage(error) }, 502);
      }
    }

    // Create a JioSaavn radio station from a song ID
    if (url.pathname === "/api/radio/start") {
      const songId = url.searchParams.get("id")?.trim();

      if (!songId) {
        return json(
          { success: false, error: "Missing song ID. Use ?id=SONG_ID" },
          400,
        );
      }

      try {
        const station = await runOperation(
          SaavnWebRadio.createEntityStation,
          {
            ctx: "android",
            entity_type: "queue",
            entity_id: JSON.stringify([songId]),
          },
        );

        return json({
          success: true,
          source: "JioSaavn Web Radio",
          seedSongId: songId,
          station,
        });
      } catch (error) {
  const err = error as {
    message?: string;
    code?: string;
    details?: unknown;
    cause?: unknown;
  };

  return json(
    {
      success: false,
      error: err.message ?? "Unknown error",
      code: err.code ?? null,
      details: err.details ?? null,
      cause: err.cause instanceof Error ? err.cause.message : null,
    },
    502,
  );
      }
    

    // Fetch songs from an existing JioSaavn radio station
    if (url.pathname === "/api/radio/next") {
      const stationId = url.searchParams.get("id")?.trim();

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

      const nextParam = url.searchParams.get("next");
      const next = nextParam === "true" || nextParam === "1";

      try {
        const result = await runOperation(SaavnWebRadio.songs, {
          ctx: "android",
          stationid: stationId,
          k: String(limit),
          next: next ? "1" : "0",
        });

        return json({
          success: true,
          source: "JioSaavn Web Radio",
          result,
        });
      } catch (error) {
        return json(
          {
            success: false,
            error: errorMessage(error),
          },
          502,
        );
      }
    }

    return json(
      { success: false, error: "Endpoint not found", path: url.pathname },
      404,
    );
  },
};
