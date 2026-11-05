import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ABSENT,
  appRoutesOf,
  appTargetsOf,
  expandRegex,
  findFloorBreaks,
  floorsOf,
  recordRelease,
  extractSwiftCalls,
  extractTableRoutes,
  extractWebCalls,
  extractWorkerRoutes,
  findMismatches,
  pathReaches,
  splitTernary,
} from './check-client-routes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const inventory = JSON.parse(read('fixtures/routes.json')).routes;
const none = { unparseable: new Map(), knownBreaks: new Map() };

test('a regex becomes the patterns it accepts', () => {
  assert.deepEqual(
    expandRegex('^\\/api\\/threads\\/([A-Za-z0-9_-]{4,72})(?:\\/(messages|read))?$').sort(),
    ['/api/threads/{}', '/api/threads/{}/messages', '/api/threads/{}/read'],
  );
  const slack = '^\\/api\\/connectors\\/slack\\/([A-Z0-9]{1,32})(\\/sync|\\/items)?$';
  assert.deepEqual(expandRegex(slack, { 2: '/sync' }), ['/api/connectors/slack/{}/sync']);
  assert.deepEqual(expandRegex(slack, { 2: ABSENT }), ['/api/connectors/slack/{}']);
});

test('a client path reaches a Worker pattern segment by segment', () => {
  assert.equal(pathReaches('/api/rooms/{}/lobby', '/api/rooms/{}/lobby'), true);
  assert.equal(pathReaches('/api/rooms/{}/lobby', '/api/rooms/{}/settings'), false);
  assert.equal(pathReaches('/api/crm/subjects/lead/{}', '/api/crm/subjects/{}/{}'), true, 'the client picks the kind at run time');
  assert.equal(pathReaches('/api/crm/tasks', '/api/crm/tasks/{}'), false);
});

const router = `
  if (request.method === 'GET' && path === '/api/health') return json({});
  if (path === '/api/things') {
    if (request.method === 'GET') return json([]);
    if (request.method === 'POST') return json({});
  }
  const itemMatch = path.match(/^\\/api\\/things\\/([0-9a-f-]{36})(\\/archive)?$/u);
  if (itemMatch) {
    const [, id, action] = itemMatch;
    if (request.method === 'PUT' && !action) return json({});
    if (request.method === 'POST' && action === '/archive') return json({});
  }
  if (path === '/api/crm/tasks' || path.startsWith('/api/crm/tasks/')) {
    if (request.method === 'GET' && path === '/api/crm/tasks') return json({});
    const taskMatch = path.match(/^\\/api\\/crm\\/tasks\\/([0-9a-f-]{36})$/u);
    if (request.method === 'PATCH' && taskMatch) return json({});
  }
  const roomMatch = path.match(/^\\/api\\/rooms\\/([a-z0-9-]{2,40})(?:\\/(.*))?$/u);
  const tail = roomMatch[2] ?? '';
  if (request.method === 'POST' && tail === 'start') return json({});
  const heartbeatMatch = tail.match(/^meetings\\/([0-9a-f-]{36})\\/heartbeat$/u);
  if (request.method === 'POST' && heartbeatMatch) return json({});
  // if (request.method === 'GET' && path === '/api/in-a-comment') {}
  const text = "if (path === '/api/in-a-string') {}";
`;

test('the Worker reader finds literal, regex, grouped, nested and tail routes', () => {
  const { routes } = extractWorkerRoutes(router, { manual: false });
  assert.deepEqual(routes, [
    'GET /api/crm/tasks',
    'GET /api/health',
    'GET /api/things',
    'PATCH /api/crm/tasks/{}',
    'POST /api/rooms/{}/meetings/{}/heartbeat',
    'POST /api/rooms/{}/start',
    'POST /api/things',
    'POST /api/things/{}/archive',
    'PUT /api/things/{}',
  ]);
});

test('the table reader takes the rows as written: one method or a list, a :name as one segment, a word list as one route each, no HEAD', () => {
  const rows = `
    defineRoute({
      method: ['GET', 'HEAD'],
      path: '/workspace/backgrounds/:id/image.png',
      params: { id: PARAMS.uuid },
    }),
    defineRoute({
      method: 'POST',
      path: '/api/interest',
    }),
    defineRoute({
      method: 'PATCH',
      path: '/api/crm/subjects/:kind/:id',
      params: { kind: { re: 'lead|project', sample: 'lead' }, id: PARAMS.uuid },
    }),
    // method: 'GET', in a comment, with no path beside it
  `;
  assert.deepEqual(extractTableRoutes(rows), [
    'GET /workspace/backgrounds/{}/image.png',
    'PATCH /api/crm/subjects/lead/{}',
    'PATCH /api/crm/subjects/project/{}',
    'POST /api/interest',
  ]);
});

test('the Swift reader takes the method from the call, and reads a ternary and a chain', () => {
  const swift = `
    let a = try authorizedRequest(path: ["rooms", room.rawValue, "lobby"], method: "GET")
    let b = try authorizedRequest(
        path: ["crm", "inbox", key, "dismiss"],
        method: dismissed ? "POST" : "DELETE"
    )
    var request = URLRequest(url: apiBaseURL.appending(path: "auth").appending(path: "refresh"))
    request.httpMethod = "POST"
    @State private var path: [Destination] = []
  `;
  const calls = extractSwiftCalls(swift, 'iOS/Example.swift').map((call) => `${call.method} ${call.path}`);
  assert.deepEqual(calls, ['GET /api/rooms/{}/lobby', 'POST /api/crm/inbox/{}/dismiss', 'DELETE /api/crm/inbox/{}/dismiss', 'POST /api/auth/refresh']);
});

test('the web reader takes the helper default: POST with a body, GET without', () => {
  const web = `
    await apiFetch('/crm/mine', { fallbackError: 'x' });
    await apiFetch('/crm/tasks', { body: { a: 1 }, fallbackError: 'x' });
    await apiFetch<{ task: T }>(\`/crm/tasks/\${id}\`, { method: 'PATCH', body: {}, fallbackError: 'x' });
    await apiFetch(event ? '/calendar/event' : '/calendar/events', { method: event ? 'PATCH' : 'POST', body });
    await fetch(\`\${apiBase}/rooms/\${slug}/meetings/\${id}/quality\`, { method: 'POST', body });
    await apiFetch(\`/crm/sales-inbox\${query ? \`?\${query}\` : ''}\`, { fallbackError: 'x' });
  `;
  assert.deepEqual(
    extractWebCalls(web, 'web/src/example.ts').map((call) => `${call.method} ${call.path}`),
    ['GET /api/crm/mine', 'POST /api/crm/tasks', 'PATCH /api/crm/tasks/{}', 'PATCH /api/calendar/event', 'POST /api/calendar/events',
      'GET /api/crm/sales-inbox', 'POST /api/rooms/{}/meetings/{}/quality'],
  );
  assert.deepEqual(splitTernary('a ? "x" : "y"'), ['"x"', '"y"']);
});

test('a call the Worker has passes; a wrong method or a wrong path fails', () => {
  const calls = (swift) => extractSwiftCalls(swift, 'iOS/Example.swift');
  const ok = calls('try authorizedRequest(path: ["home", "preferences"], method: "PUT")');
  assert.deepEqual(findMismatches(inventory, ok, none).problems, []);

  const wrongMethod = calls('try authorizedRequest(path: ["home", "preferences"], method: "POST")');
  const [method] = findMismatches(inventory, wrongMethod, none).problems;
  assert.match(method.why, /POST \/api\/home\/preferences: the Worker takes GET, PUT/u);

  const wrongPath = calls('try authorizedRequest(path: ["home", "preference"], method: "GET")');
  assert.match(findMismatches(inventory, wrongPath, none).problems[0].why, /no Worker route answers \/api\/home\/preference/u);
});

test('changing a real client call to the wrong method fails the gate', () => {
  // Both Swift clients send this route from its one declaration (meet#356).
  const file = 'Sources/StarlingsSettingsRoutes.swift';
  const source = read(file);
  assert.match(source, /method: "PUT", path: \["home", "preferences"\]/u, 'the call this test breaks moved; pick another');
  const broken = source.replace('method: "PUT", path: ["home", "preferences"]', 'method: "POST", path: ["home", "preferences"]');
  const { problems } = findMismatches(inventory, extractSwiftCalls(broken, file), none);
  assert.deepEqual(problems.map((problem) => problem.why), ['POST /api/home/preferences: the Worker takes GET, PUT there']);
});

test('an allowlist line that no call uses is a failure, so it cannot outlive its reason', () => {
  const { stale } = findMismatches(inventory, [], { unparseable: new Map([['x.ts::path', { route: null, why: 'test' }]]), knownBreaks: new Map([['a GET /api/x', 'test']]) });
  assert.equal(stale.length, 2);
});

test('a path the reader cannot parse is an error unless it is listed', () => {
  const call = { file: 'web/src/x.ts', line: 1, client: 'web', method: 'GET', path: null, unparseable: 'web/src/x.ts::somePath' };
  assert.match(findMismatches(inventory, [call], none).problems[0].why, /cannot read the path/u);
  const listed = new Map([['web/src/x.ts::somePath', { route: 'GET /api/health', why: 'test' }]]);
  assert.deepEqual(findMismatches(inventory, [call], { unparseable: listed, knownBreaks: new Map() }).problems, []);
});

test('the checked-in inventory is long enough to mean something', () => {
  assert.ok(inventory.length > 200);
  assert.ok(inventory.includes('PUT /api/rooms/{}/meetings/{}/category'));
});

// meet#1163: a released app keeps calling its routes until the person updates.
const project = `targets:
  Starlings:
    type: application
    platform: macOS
    sources:
      - path: Sources
  Starlings-iOS:
    type: application
    platform: iOS
    sources:
      - path: iOS
      - path: Sources/Shared.swift
  StarlingsTests:
    platform: macOS
    sources:
      - path: Tests
`;

test('project.yml says which app a Swift file builds into', () => {
  const clientsOf = appTargetsOf(project);
  assert.deepEqual(clientsOf('Sources/MacOnly.swift'), ['macos']);
  assert.deepEqual(clientsOf('Sources/Shared.swift'), ['macos', 'ios']);
  assert.deepEqual(clientsOf('iOS/StarlingsAPI.swift'), ['ios']);
  assert.deepEqual(clientsOf('Tests/SomeTests.swift'), [], 'a test target is no app');
  assert.deepEqual(clientsOf('iOSShare/Share.swift'), []);
});

test('a release records the routes each app calls; a route it drops keeps its last release', () => {
  const clientsOf = appTargetsOf(project);
  const calls = (paths) => paths.map(([file, method, p]) => ({ file, method, path: p, unparseable: null }));
  const first = appRoutesOf(calls([['Sources/Shared.swift', 'POST', '/api/docs/token'], ['iOS/A.swift', 'GET', '/api/me']]), clientsOf);
  assert.deepEqual(first, { macos: ['POST /api/docs/token'], ios: ['GET /api/me', 'POST /api/docs/token'] });
  let record = recordRelease({ routes: [] }, '6.8.2', first);
  record = recordRelease(record, '6.9.2', { macos: [], ios: ['GET /api/me'] });
  assert.deepEqual(record.releases, ['6.8.2', '6.9.2']);
  assert.deepEqual(record.routes, [
    { client: 'ios', route: 'GET /api/me', first: '6.8.2', last: '6.9.2' },
    { client: 'ios', route: 'POST /api/docs/token', first: '6.8.2', last: '6.8.2' },
    { client: 'macos', route: 'POST /api/docs/token', first: '6.8.2', last: '6.8.2' },
  ]);
});

test('removing a route an accepted app calls fails and names the floor; raising the floor passes', () => {
  const record = {
    releases: ['6.8.2', '6.9.2'],
    routes: [
      { client: 'ios', route: 'POST /api/docs/token', first: '6.8.2', last: '6.8.2' },
      { client: 'ios', route: 'GET /api/rooms/{}', first: '6.8.2', last: '6.9.2' },
    ],
  };
  const config = (floor) => ({ vars: { MIN_RECOMMENDED_VERSION_IOS: floor }, env: { hq: { vars: { MIN_RECOMMENDED_VERSION_IOS: floor } } } });
  const without = ['GET /api/rooms/{}'];
  const broken = findFloorBreaks(record, without, floorsOf(config('6.8.2')));
  assert.equal(broken.length, 1);
  assert.match(broken[0], /^POST \/api\/docs\/token: the iOS app 6\.8\.2 calls it/u);
  assert.match(broken[0], /env\.hq accepts 6\.8\.2/u);
  assert.match(broken[0], /Raise MIN_RECOMMENDED_VERSION_IOS to 6\.9\.2 in every env/u);
  assert.deepEqual(findFloorBreaks(record, without, floorsOf(config('6.9.2'))), []);
  assert.deepEqual(findFloorBreaks(record, ['POST /api/docs/token', ...without], floorsOf(config('6.8.2'))), [], 'a retired route that still answers (410) passes');
  assert.equal(findFloorBreaks(record, without, floorsOf(config(''))).length, 1, 'an unset floor accepts every app');
  assert.equal(findFloorBreaks(record, ['GET /api/docs/token', ...without], floorsOf(config('6.8.2'))).length, 1, 'the method counts');
});
