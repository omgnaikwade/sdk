import { Song, Album, Artist, Playlist, Extras } from "./index";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        status: "ok",
        message: "Saavn SDK Worker is running"
      });
    }

    return Response.json({
      error: "Endpoint not implemented yet",
      path: url.pathname
    }, { status: 404 });
  }
};
