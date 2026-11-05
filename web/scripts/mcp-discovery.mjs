import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mcpPath = path.join(root, 'services/control-plane/src/mcp.ts');
const routesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-openapi-routes.json');

export async function readMcpRouteCalls() {
  const text = await readFile(mcpPath, 'utf8');
  const calls = [];
  const callPattern = /\bapi(?:<[^)]*>)?\s*\(\s*call\s*,\s*(?<path>`[^`]*`|'[^']*'|[A-Za-z_$][\w$]*)\s*(?:,\s*\{\s*method\s*:\s*'(?<method>GET|POST|PATCH|PUT|DELETE)'[^}]*\})?/gsu;
  for (const match of text.matchAll(callPattern)) {
    if (/\bfunction\s+$/u.test(text.slice(Math.max(0, match.index - 20), match.index))) continue;
    let raw = match.groups.path;
    if (raw.startsWith('`')) {
      raw = raw.slice(1, -1);
      if (raw.startsWith('${path}')) {
        const declaration = /\bconst\s+path\s*=\s*(`[^`]*`|'[^']*')/u.exec(text)?.[1];
        if (declaration) raw = `${declaration.slice(1, -1)}${raw.slice('${path}'.length)}`;
      }
      raw = raw.replace(/\$\{[^}]*\}/gu, '{param}');
    }
    else if (raw.startsWith("'")) raw = raw.slice(1, -1);
    else {
      const declaration = new RegExp("\\bconst\\s+" + raw + "\\s*=\\s*(`[^`]*`|'[^']*')", 'u').exec(text);
      if (!declaration) continue;
      raw = declaration[1];
      if (raw.startsWith('`')) raw = raw.slice(1, -1).replace(/\$\{[^}]*\}/gu, '{param}');
      else raw = raw.slice(1, -1);
    }
    if (raw.includes('${query')) raw = raw.slice(0, raw.indexOf('${query'));
    const route = raw.split('?', 1)[0].replace(/\/$/u, '');
    if (route.startsWith('/api/')) calls.push({ method: (match.groups.method ?? 'GET').toLowerCase(), path: route });
  }
  const apiCalls = [...text.matchAll(/\bapi(?:<[^)]*>)?\s*\(\s*call\s*,/gsu)]
    .filter((match) => !/\bfunction\s+$/u.test(text.slice(Math.max(0, match.index - 20), match.index))).length;
  if (calls.length !== apiCalls) throw new Error(`Found ${apiCalls} MCP API calls but only understood ${calls.length}; update the OpenAPI route scanner.`);
  return [...new Map(calls.map((call) => [`${call.method} ${call.path}`, call])).values()].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

function decodeString(raw) {
  return raw.replace(/\\(['"\\])/gu, '$1').replace(/\\n/gu, '\n').replace(/\\t/gu, '\t');
}

export async function readMcpToolSummaries() {
  const text = await readFile(mcpPath, 'utf8');
  const toolsBlock = /const\s+TOOLS\s*:\s*ToolDefinition\[\]\s*=\s*\[([\s\S]*?)\n\];/u.exec(text)?.[1];
  if (!toolsBlock) throw new Error('Could not read the MCP TOOLS definition.');
  const tools = [];
  const toolPattern = /\{\s*name:\s*'((?:\\.|[^'\\])*)',\s*description:\s*([\s\S]*?),\s*inputSchema\s*:/gu;
  for (const match of toolsBlock.matchAll(toolPattern)) {
    const name = decodeString(match[1]);
    const description = [...match[2].matchAll(/'((?:\\.|[^'\\])*)'/gu)].map((part) => decodeString(part[1])).join('');
    const sentence = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(description)][0]?.segment.trim();
    if (!sentence) throw new Error(`Could not read the description for MCP tool ${name}.`);
    tools.push({ name, summary: sentence });
  }
  if (tools.length === 0) throw new Error('No MCP tools were found in the TOOLS definition.');
  return tools;
}

const routeShape = (route) => route.replace(/\{[^}]+\}/gu, '{}');

function convertRefs(value) {
  if (Array.isArray(value)) return value.map(convertRefs);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'x-io' && key !== 'x-closed')
    .map(([key, child]) => [key, typeof child === 'string' && key === '$ref'
      ? child.replace(/^#\/\$defs\//u, '#/components/schemas/')
      : convertRefs(child)]));
}

async function buildOpenApi() {
  const routeRows = JSON.parse(await readFile(routesPath, 'utf8'));
  const wire = JSON.parse(await readFile(path.join(root, 'packages/contracts/schema/wire.json'), 'utf8'));
  const extra = JSON.parse(await readFile(path.join(root, 'packages/contracts/schema/mcp-openapi.json'), 'utf8'));
  const schemas = { ...wire.$defs, ...extra.$defs };
  const actual = await readMcpRouteCalls();
  const listed = new Set(routeRows.map((route) => `${route.method} ${routeShape(route.path)}`));
  const called = new Set(actual.map((route) => `${route.method} ${routeShape(route.path)}`));
  const missing = [...called].filter((route) => !listed.has(route)).sort();
  const stale = [...listed].filter((route) => !called.has(route)).sort();
  if (missing.length || stale.length) {
    throw new Error([
      missing.length ? `MCP calls routes missing from the OpenAPI registry:\n${missing.map((row) => `  ${row}`).join('\n')}` : '',
      stale.length ? `OpenAPI routes no longer called by MCP:\n${stale.map((row) => `  ${row}`).join('\n')}` : '',
    ].filter(Boolean).join('\n'));
  }

  const schemaNames = new Set();
  const addSchema = (name) => {
    if (!name || schemaNames.has(name)) return;
    if (!schemas[name]) throw new Error(`OpenAPI route refers to missing Zod contract schema ${name}.`);
    schemaNames.add(name);
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      if (typeof value.$ref === 'string') {
        const dependency = /^#\/\$defs\/(.+)$/u.exec(value.$ref)?.[1];
        if (dependency) addSchema(dependency);
      }
      Object.values(value).forEach(visit);
    };
    visit(schemas[name]);
  };
  for (const route of routeRows) {
    addSchema(route.query);
    addSchema(route.body);
    addSchema(route.response);
    for (const response of route.responses ?? []) addSchema(response);
  }
  const components = Object.fromEntries([...schemaNames].sort().map((name) => [name, convertRefs(schemas[name])]));
  const paths = {};
  for (const route of routeRows) {
    const parameters = (route.pathParams ?? []).map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (route.query) {
      const query = schemas[route.query];
      const required = new Set(query.required ?? []);
      for (const [name, schema] of Object.entries(query.properties ?? {})) {
        parameters.push({
          name,
          in: 'query',
          required: required.has(name),
          schema: convertRefs(schema),
        });
      }
    }
    const responseSchemas = route.responses ?? (route.response ? [route.response] : []);
    const responseSchema = responseSchemas.length === 1
      ? { $ref: `#/components/schemas/${responseSchemas[0]}` }
      : responseSchemas.length > 1
        ? { oneOf: responseSchemas.map((name) => ({ $ref: `#/components/schemas/${name}` })) }
        : null;
    paths[route.path] ??= {};
    paths[route.path][route.method] = {
      summary: route.summary,
      description: 'This is an internal route called by the Starlings MCP server. Use the OAuth-protected /mcp endpoint; MCP connector tokens are not API bearer tokens.',
      ...(parameters.length ? { parameters } : {}),
      ...(route.body ? {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.body}` } } },
        },
      } : {}),
      responses: {
        '200': {
          description: 'Successful response',
          ...(responseSchema ? { content: { 'application/json': { schema: responseSchema } } } : {}),
        },
        'default': { description: 'The control plane refused or could not complete the request.' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Starlings MCP internal API',
      version: '1.0.0',
      description: 'Internal routes wrapped by Starlings MCP tools and resources. Discover the public agent surface at /llms.txt. These routes are not a substitute for the consented /mcp OAuth connection.',
    },
    paths,
    components: { schemas: components },
  };
}

const openApiPath = path.join(root, 'web/public/openapi.json');
if (process.argv.includes('--write-openapi')) {
  const document = await buildOpenApi();
  await writeFile(openApiPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`wrote MCP OpenAPI with ${Object.keys(document.paths).length} paths`);
}
if (process.argv.includes('--check-openapi')) {
  const document = `${JSON.stringify(await buildOpenApi(), null, 2)}\n`;
  const current = await readFile(openApiPath, 'utf8').catch(() => '');
  if (current !== document) {
    console.error('web/public/openapi.json is stale or MCP route coverage changed; run pnpm openapi:gen');
    process.exitCode = 1;
  } else {
    console.log('MCP route coverage and web/public/openapi.json are current');
  }
}

if (process.argv.includes('--list-routes')) {
  console.log(JSON.stringify(await readMcpRouteCalls(), null, 2));
}
if (process.argv.includes('--list-tools')) {
  console.log(JSON.stringify(await readMcpToolSummaries(), null, 2));
}
