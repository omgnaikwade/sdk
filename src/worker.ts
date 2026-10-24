import { Song, Album, Artist, Playlist, Extras } from './index.js';
import { SDKError } from './helpers/errors.js';

type Params = Record<string, unknown>;
type Handler = (params: any) => Promise<unknown>;

const METHODS: Record<string, Handler> = {
  'Song.search': ({ query, limit, offset }) => Song.search({ query, limit, offset }),
  'Song.getById': ({ songIds }) => Song.getById({ songIds }),
  'Song.getByPermalink': ({ permalink }) => Song.getByPermalink({ permalink }),
  'Song.getRecommendations': ({ songId }) => Song.getRecommendations({ songId }),
  'Song.getTrending': ({ language }) => Song.getTrending({ language }),
  'Album.search': ({ query, limit, offset }) => Album.search({ query, limit, offset }),
  'Album.getById': ({ albumId }) => Album.getById({ albumId }),
  'Album.getTrending': ({ language }) => Album.getTrending({ language }),
  'Artist.search': ({ query, limit, offset }) => Artist.search({ query, limit, offset }),
  'Artist.getById': ({ artistId }) => Artist.getById({ artistId }),
  'Playlist.search': ({ query, limit, offset }) => Playlist.search({ query, limit, offset }),
  'Playlist.getById': ({ playlistId }) => Playlist.getById({ playlistId }),
  'Playlist.getTrending': ({ language }) => Playlist.getTrending({ language }),
  'Extras.searchAll': ({ query }) => Extras.searchAll({ query }),
  'Extras.getTrendingAll': () => Extras.getTrendingAll(),
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });

    const url = new URL(request.url);
    if (url.pathname === '/') {
      return json({
        status: 'ok',
        message: 'Saavn SDK API is running',
        endpoint: '/api/test?method=Song.search&query=arijit',
      });
    }

    if (url.pathname !== '/api/test') {
      return json({ success: false, error: 'Not found', path: url.pathname }, 404);
    }

    const method = url.searchParams.get('method');
    if (!method || !Object.prototype.hasOwnProperty.call(METHODS, method)) {
      return json({
        success: false,
        error: 'Unknown or missing method',
        availableMethods: Object.keys(METHODS),
      }, 400);
    }

    const params: Params = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (key === 'method') continue;
      if (key === 'limit' || key === 'offset') {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return json({ success: false, error: `${key} must be a number` }, 400);
        params[key] = parsed;
      } else {
        params[key] = value;
      }
    }

    try {
      const data = await METHODS[method](params);
      return json({ success: true, method, params, data });
    } catch (error) {
      if (error instanceof SDKError) {
        return json({ success: false, error: { name: error.name, code: error.code, message: error.message } }, 500);
      }
      return json({
        success: false,
        error: { name: 'Error', message: error instanceof Error ? error.message : String(error) },
      }, 500);
    }
  },
};
