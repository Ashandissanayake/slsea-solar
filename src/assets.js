import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOCS_HTML } from './docs.js';

const root = new URL('../', import.meta.url);
const read = relative => readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');

/** Static documents served by the API: the OpenAPI contract and the locally hosted Swagger UI. */
export function loadAssets() {
  return {
    OPENAPI: JSON.parse(read('openapi.json')),
    DOCS: DOCS_HTML,
    SWAGGER_JS: read('vendor/swagger-ui-bundle.js'),
    SWAGGER_CSS: read('vendor/swagger-ui.css'),
  };
}
