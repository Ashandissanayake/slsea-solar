// Node.js HTTP adapter: converts node:http requests into Fetch API Requests for the app and writes the Response back.
import http from 'node:http';

const MAX_BODY_BYTES = 64 * 1024; // the app itself enforces the 16 KiB API limit; this only protects memory

const jsonError = (res, status, code, message) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: { code, message, detail: {} } }));
};

/**
 * @param app            { fetch(Request): Promise<Response> }
 * @param publicBaseUrl  optional fixed public origin, for example https://slsea.example.com
 */
export function createHttpServer(app, { publicBaseUrl = '' } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          jsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 16 KiB.');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const payload = Buffer.concat(chunks);
      const origin = publicBaseUrl || `http://${req.headers.host || 'localhost'}`;
      const response = await app.fetch(new Request(origin + req.url, {
        method: req.method,
        headers: req.headers,
        ...(payload.length ? { body: payload } : {}),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error('HTTP adapter error', String(error?.message ?? error));
      if (!res.headersSent) jsonError(res, 500, 'INTERNAL_ERROR', 'The service could not complete the request.');
      else res.end();
    }
  });
}
