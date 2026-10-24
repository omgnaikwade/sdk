import { Song } from "./index";
import { runOperation } from "./saavn/run-operation";
import { SaavnWebRadio } from "./saavn/operations/index.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      cause: error.cause ?? null,
    };
  }

  return { message: String(error) };
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      // Health check
      if (url.pathname === "/" && request.method === "GET") {
        return json({
          success: true,
          message: "JioSaavn SDK Worker is running",
        });
      }

      // Search songs
      if (url.pathname === "/api/search" && request.method === "GET") {
        const query = url.searchParams.get("q")?.trim();

        if (!query) {
          return json(
            { success: false, error: "Missing search query. Use ?q=SONG_NAME" },
            400
          );
        }

        const result = await Song.search({
          query,
          limit: Number(url.searchParams.get("limit") || 20),
          offset: Number(url.searchParams.get("page") || 1),
        });

        return json({
          success: true,
          query,
          page: Number(url.searchParams.get("page") || 1),
          results: result,
        });
      }

      // Create radio station using one or two seed song IDs
      if (url.pathname === "/api/radio/start" && request.method === "GET") {
        const idsParam = url.searchParams.get("ids");
        const singleId = url.searchParams.get("id");

        const songIds = (
          idsParam
            ? idsParam.split(",")
            : singleId
              ? [singleId]
              : []
        )
          .map((id) => id.trim())
          .filter(Boolean);

        if (songIds.length === 0) {
          return json(
            {
              success: false,
              error: "Provide a song ID using ?id=SONG_ID or ?ids=ID1,ID2",
            },
            400
          );
        }

        if (songIds.length > 2) {
          return json(
            {
              success: false,
              error: "For this test, provide a maximum of two song IDs.",
            },
            400
          );
        }

        const station = await runOperation(
          SaavnWebRadio.createEntityStation,
          {
            ctx: "android",
            entity_type: "queue",
            entity_id: JSON.stringify(songIds),
          }
        );

        return json({
          success: true,
          source: "JioSaavn Web Radio",
          seedSongIds: songIds,
          station,
        });
      }

      // Get radio songs
      if (url.pathname === "/api/radio/next" && request.method === "GET") {
        const stationId = url.searchParams.get("id")?.trim();

        if (!stationId) {
          return json(
            {
              success: false,
              error: "Missing station ID. Use ?id=STATION_ID",
            },
            400
          );
        }

        const limit = Math.min(
          50,
          Math.max(1, Number(url.searchParams.get("limit") || 20))
        );

        const next = url.searchParams.get("next") !== "false";

        const result = await runOperation(SaavnWebRadio.songs, {
          ctx: "android",
          stationid: stationId,
          k: String(limit),
          next: next ? "1" : "0",
        });

        return json({
          success: true,
          source: "JioSaavn Web Radio",
          stationId,
          result,
        });
      }

      // Song recommendations
      if (
        url.pathname === "/api/recommendations" &&
        request.method === "GET"
      ) {
        const songId = url.searchParams.get("id")?.trim();

        if (!songId) {
          return json(
            {
              success: false,
              error: "Missing song ID. Use ?id=SONG_ID",
            },
            400
          );
        }

        const result = await Song.getRecommendations({ songId });

        return json({
          success: true,
          songId,
          results: result,
        });
      }

      return json(
        {
          success: false,
          error: "Route not found",
          availableRoutes: [
            "/",
            "/api/search?q=Tum%20Hi%20Ho",
            "/api/radio/start?id=SONG_ID",
            "/api/radio/start?ids=ID1,ID2",
            "/api/radio/next?id=STATION_ID&limit=20&next=true",
            "/api/recommendations?id=SONG_ID",
          ],
        },
        404
      );
    } catch (error) {
      return json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "An unexpected error occurred",
          details: errorDetails(error),
        },
        500
      );
    }
  },
};
