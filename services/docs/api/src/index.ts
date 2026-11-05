// Docs — control plane.
//
// Same shape as Meet's Worker: one `route()` function, explicit path matching,
// errors normalized into `{error, code}` at the boundary, static assets served
// by the ASSETS binding for anything that is not `/api/*`.
//
// The access rule, stated once so no route has to re-derive it:
//
//   staff  → everything
//   agent  → everything its scopes and path prefix allow
//   guest  → exactly the document (or folder subtree) its grant names
//
// `assertCanRead` is where that lives. Every document route goes through it.

import { SIGN_IN_DOMAIN } from '../../../../packages/contracts/src/deployment-values';
import { ZodError } from 'zod';
import {
  documentMoveSchema,
  favoriteResolveSchema,
  documentClickSchema,
  internalAccessSchema,
  visitSchema,
  LINK_FOLDER,
  type DocsErrorBody,
  type DocsErrorCode,
  type ResolvedFavoriteDocument,
  type ResolvedFavoriteFolder,
  type Principal,
  type DeploymentInfo,
  CENTRAL_AUTH_COMPLETE_PATH,
} from '@docs/contracts';
import {
  assertPathAllowed,
  completeGoogleWebAuth,
  logoutResponse,
  requireStaff,
  requireWriter,
  resolvePrincipal,
  signGuestSession,
  signStaffSession,
  startGoogleWebAuth,
} from './auth';
import { centralSignOutLocation, completeCentralWebAuth, startCentralWebAuth } from './central-auth';
import { devCookie, redirectWithCookies, safeReturnPath } from './http-cookies';
import { listAccessEvents, recordAccessQuietly } from './audit';
import { notifyDocumentAccessed, requestPlace } from './access-notify';
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
} from './annotations';
import {
  canView,
  createDocument,
  favoriteDocumentsByIds,
  deleteDocument,
  purgeDocument,
  assertStaysInternal,
  getDocumentById,
  getDocumentDetail,
  getLinkReadableDocument,
  listDocuments,
  moveDocument,
  promote,
  resolveDocument,
  search,
  setSubjects,
  summary,
  updateDocument,
  viewerKey,
  type DocumentRow,
} from './documents';
import { AuthError, DocsError, NotFoundError } from './errors';
import { serveFile, uploadPDF } from './files';
import { identityDomains, isIdentityEmail, webSignIn } from './identity';
import { createCategory, deleteCategory, listCategories, orderCategories, updateCategory } from './categories';
import { createFolder, deleteFolder, favoriteFoldersByIds, fullTree, listFolders, moveFolder } from './folders';
import { clearLinkImage, putLinkImage, saveLink, serveLinkImage, updateLink } from './links';
import { listImages, removeImage, serveImage, uploadImage } from './images';
import { claimGrant, createGrant, getGrantByToken, guestCanReach, listGrants, revokeGrant, verifyGrant } from './grants';
import { adopt, assertInternalSignature, ingest } from './ingest';
import { mirrorStatus, runMirror } from './mirror';
import { assertTrustedMutation, assertUnderRateLimit, json, noContent, readBoundedJSON, readBoundedText } from './http';
import {
  cancel,
  certificate,
  createSignatureRequest,
  decline,
  getSignatureRequest,
  getSignerView,
  sign,
} from './signatures';
import { staffRedirect } from './staff-redirect';
import { manifest, push } from './sync';
import { createToken, exchangeMeetToken, listTokens, revokeToken } from './tokens';

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const response = await route(request, env, ctx);
      log('info', 'request.completed', {
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return addCORS(response, request, env);
    } catch (error) {
      const status = errorStatus(error);
      const code = errorCode(error, status);
      log(status >= 500 ? 'error' : 'warn', 'request.failed', {
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status,
        code,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      const body: DocsErrorBody = { error: publicError(error, status), code };
      if (status >= 500) body.request_id = requestId;
      return addCORS(json(body, status), request, env);
    }
  },

  /// The hourly sweep (`triggers.crons` in wrangler.jsonc). Nothing here
  /// throws: a surface that fails is written to `sync_state`, and the run
  /// is logged surface by surface so a stalled mirror is visible in the
  /// Worker log as well as on /api/health.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runMirror(env).then((runs) => {
        for (const run of runs) log(run.error ? 'error' : 'info', 'mirror.surface', { ...run });
      }),
    );
  },
} satisfies ExportedHandler<Env>;

export default worker;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Anything that is not the API is the SPA, except the staff pages that now
  // live in the workspace's Meet (#24): those redirect. The client router owns
  // /d/<token>, /certificate/<id> and /tokens.
  if (!path.startsWith('/api/') && path !== '/api') {
    if (method === 'GET' || method === 'HEAD') {
      const isStaff = async () => {
        try {
          return (await resolvePrincipal(request, env))?.kind === 'staff';
        } catch {
          return false;
        }
      };
      const location = await staffRedirect(env, url, isStaff);
      if (location) return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(request);
  }

  // Answers with 503 when a surface is failing or has stopped running, so an
  // uptime check — or `curl -f` — is enough to notice. `core:work` failed
  // every hour for seven months into a page that reported `ok: true`, because
  // nothing about the response distinguished a healthy sweep from a broken
  // one. A status endpoint that is always 200 is not monitoring.
  if (method === 'GET' && path === '/api/health') {
    const mirror = await mirrorStatus(env);
    const unhealthy = mirror.filter((surface) => !surface.healthy);
    return json(
      {
        ok: unhealthy.length === 0,
        service: 'docs',
        environment: env.ENVIRONMENT,
        ...(unhealthy.length ? { unhealthy: unhealthy.map((surface) => surface.source_key) } : {}),
        mirror,
      },
      unhealthy.length ? 503 : 200,
    );
  }

  // ---- auth ---------------------------------------------------------------

  // A `central` deployment keeps the start path the SPA links to, and signs in
  // through the auth host (central-auth.ts). The Google callback refuses it.
  if (method === 'GET' && path === '/api/auth/google/start') {
    return webSignIn(env) === 'central' ? startCentralWebAuth(request, env) : startGoogleWebAuth(request, env);
  }
  if (method === 'GET' && path === '/api/auth/google/callback') return completeGoogleWebAuth(request, env);
  if (method === 'GET' && path === CENTRAL_AUTH_COMPLETE_PATH) {
    if (webSignIn(env) !== 'central') throw new NotFoundError('No such route.');
    return completeCentralWebAuth(request, env);
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    return logoutResponse(env, webSignIn(env) === 'central' ? centralSignOutLocation(env) : env.WEB_ORIGIN);
  }

  // Local development only. Google OAuth needs a registered redirect URI, which
  //127.0.0.1 does not have, so dev mints a session directly. The environment
  // check is the entire safeguard — production must never reach this.
  if (method === 'GET' && path === '/api/dev/session') {
    if (env.ENVIRONMENT === 'production') throw new NotFoundError('No such route.');
    const email = (url.searchParams.get('email') ?? `rosa@${SIGN_IN_DOMAIN}`).toLowerCase();
    if (!isIdentityEmail(env, email)) {
      throw new AuthError('Dev sessions are for this deployment\'s identity domains only.', 403, 'forbidden');
    }
    const session = await signStaffSession({ sub: `dev-${email}`, email, name: email.split('@')[0] ?? 'Dev' }, env);
    return redirectWithCookies(`${env.WEB_ORIGIN}${safeReturnPath(url.searchParams.get('return_to'))}`, [
      devCookie('docs_session', session),
    ]);
  }

  // Guest entry points. Deliberately before principal resolution — the whole
  // point is that the caller has no session yet.
  if (method === 'POST' && path === '/api/access/claim') {
    await assertUnderRateLimit(env.CLAIM_LIMIT, request, 'claim');
    const result = await claimGrant(env, await readBoundedJSON(request));
    if (result.status === 'verify') return json({ status: 'verify', email: result.email });
    return json({ status: 'ready', token: await signGuestSession(result.session, env), session: result.session });
  }

  if (method === 'POST' && path === '/api/access/verify') {
    await assertUnderRateLimit(env.CLAIM_LIMIT, request, 'verify');
    const session = await verifyGrant(env, await readBoundedJSON(request));
    return json({ status: 'ready', token: await signGuestSession(session, env), session });
  }

  // Public shape of a share link, so the landing page can name the document
  // before an email is entered. Title only — never the body.
  if (method === 'GET' && path.startsWith('/api/access/')) {
    const token = path.slice('/api/access/'.length);
    const grant = await getGrantByToken(env, token);
    const document = grant.document_id
      ? await env.DB.prepare(`SELECT title, kind FROM documents WHERE id = ?`)
          .bind(grant.document_id)
          .first<{ title: string; kind: string }>()
      : null;
    return json({
      role: grant.role,
      requires_verification: grant.require_verification === 1,
      email_hint: grant.email ? maskEmail(grant.email) : null,
      document: document ? { title: document.title, kind: document.kind } : null,
    });
  }

  // ---- mirror ingest (service-to-service, HMAC) ---------------------------

  if (method === 'POST' && path === '/api/ingest') {
    const body = await readBoundedText(request);
    await assertInternalSignature(request, env, body);
    return json(await ingest(env, JSON.parse(body)));
  }

  if (method === 'POST' && path === '/api/adopt') {
    const body = await readBoundedText(request);
    await assertInternalSignature(request, env, body);
    return json(await adopt(env, JSON.parse(body)));
  }

  // The www share reader (the share reader's `/private/docs/<uuid>`). www's
  // email gate is the access control, as it was when Core served these; Docs
  // only answers for rows marked `link` or `public`. GET, so the signed body
  // is the empty string.
  const shareMatch = /^\/api\/internal\/documents\/([0-9a-f-]{36})$/u.exec(path);
  if (method === 'GET' && shareMatch?.[1]) {
    await assertInternalSignature(request, env, '');
    const document = await getLinkReadableDocument(env, shareMatch[1]);
    if (!document) throw new NotFoundError('No such document.');
    return json({
      id: document.id,
      title: document.title,
      body_md: document.body_md ?? '',
      created_at: document.created_at,
      updated_at: document.updated_at,
    });
  }

  // www records a visit or a link click on its share page as a guest event
  // here. Same signature and same gate as the
  // reader above: only a row www may show answers, else 404, so www can ask
  // each store in turn. The caller is www's server, so the request's own IP,
  // agent and place are not the visitor's; the body carries the place.
  const accessMatch = /^\/api\/internal\/documents\/([0-9a-f-]{36})\/access$/u.exec(path);
  if (method === 'POST' && accessMatch?.[1]) {
    const raw = await readBoundedText(request);
    await assertInternalSignature(request, env, raw);
    const body = internalAccessSchema.parse(raw ? JSON.parse(raw) : {});
    const document = await getLinkReadableDocument(env, accessMatch[1]);
    if (!document) throw new NotFoundError('No such document.');
    const actor = body.email.toLowerCase();
    const city = body.city?.trim().slice(0, 120) || null;
    const country = body.country ?? null;
    const href = body.kind === 'click' ? (body.href ?? null) : null;
    const recorded = await recordAccessQuietly(env, {
      documentId: document.id,
      actor,
      actorKind: 'guest',
      kind: body.kind,
      timezone: body.timezone ?? null,
      language: body.language ?? null,
      referrer: body.referrer ?? null,
      detail: { via: 'www', city, country, ...(href ? { href } : {}) },
    });
    notifyDocumentAccessed(env, ctx, {
      recorded,
      document,
      kind: body.kind,
      actor,
      via: 'www',
      grantId: null,
      city,
      country,
      href,
    });
    return noContent();
  }

  // ---- Meet device tokens (service-to-service, HMAC) ----------------------

  if (method === 'POST' && path === '/api/tokens/meet-exchange') {
    const body = await readBoundedText(request);
    await assertInternalSignature(request, env, body, 'DOCS_INTERNAL_SECRET');
    return json(await exchangeMeetToken(env, JSON.parse(body)), 201);
  }

  // The deployment's name and admitted domains, for the SPA's sign-in screen
  // and chrome (: a workspace deployment is not
  // Envisioning's). Public, before sign-in.
  if (method === 'GET' && path === '/api/deployment') {
    const name = env.WORKSPACE_NAME?.trim().slice(0, 60);
    return json({
      name: name || 'Envisioning',
      envisioning: !name,
      identity_domains: [...identityDomains(env)],
    } satisfies DeploymentInfo);
  }

  // ---- everything below needs a principal ---------------------------------

  const principal = await resolvePrincipal(request, env);
  if (!principal) throw new AuthError('Sign in to continue.', 401, 'unauthorized');
  if (method !== 'GET' && method !== 'HEAD') assertTrustedMutation(request, env);

  if (method === 'GET' && path === '/api/me') {
    return json(describePrincipal(principal));
  }

  // ---- stable favorite targets -------------------------------------------

  if (method === 'POST' && path === '/api/favorites/resolve') {
    requireStaffOrAgentRead(principal);
    const input = favoriteResolveSchema.parse(await readBoundedJSON(request));
    const [documents, folders] = await Promise.all([
      favoriteDocumentsByIds(env, input.documents),
      favoriteFoldersByIds(env, input.folders, viewerKey(actorEmail(principal))),
    ]);

    const visibleDocuments: ResolvedFavoriteDocument[] = [];
    for (const document of documents) {
      try {
        await assertCanRead(env, principal, document);
      } catch (error) {
        // Path-confined agent tokens omit refs outside their current scope.
        // The route's principal gate already requires docs:read.
        if (principal.kind === 'agent' && error instanceof AuthError && error.status === 403) continue;
        if (error instanceof NotFoundError) continue;
        throw error;
      }
      visibleDocuments.push({
        kind: 'docs.document',
        target_ref: document.id,
        title: document.title,
        path: document.path,
        document_kind: document.kind,
        destination: `/doc${document.path}`,
      });
    }

    const visibleFolders: ResolvedFavoriteFolder[] = [];
    for (const folder of folders) {
      try {
        assertPathAllowed(principal, folder.path);
      } catch (error) {
        if (principal.kind === 'agent' && error instanceof AuthError && error.status === 403) continue;
        throw error;
      }
      visibleFolders.push({
        kind: 'docs.folder',
        target_ref: folder.id,
        title: folder.title,
        path: folder.path,
        parent_id: folder.parent_id,
        document_count: folder.document_count ?? 0,
        destination: `/folder/${folder.id}`,
      });
    }

    const documentsById = new Map(visibleDocuments.map((document) => [document.target_ref, document]));
    const foldersById = new Map(visibleFolders.map((folder) => [folder.target_ref, folder]));
    return json({
      documents: input.documents.flatMap((id) => {
        const document = documentsById.get(id);
        return document ? [document] : [];
      }),
      folders: input.folders.flatMap((id) => {
        const folder = foldersById.get(id);
        return folder ? [folder] : [];
      }),
    });
  }

  // ---- tree and folders ---------------------------------------------------

  if (method === 'GET' && path === '/api/tree') {
    requireStaffOrAgentRead(principal);
    return json({ folders: await fullTree(env, viewerKey(actorEmail(principal))) });
  }

  if (method === 'GET' && path === '/api/folders') {
    requireStaffOrAgentRead(principal);
    return json({ folders: await listFolders(env, url.searchParams.get('parent'), viewerKey(actorEmail(principal))) });
  }

  if (method === 'POST' && path === '/api/folders') {
    const writer = requireWriter(principal, 'folders:write');
    return json(await createFolder(env, await readBoundedJSON(request), writer.actor), 201);
  }

  const folderMatch = /^\/api\/folders\/([0-9a-f-]{36})$/u.exec(path);
  if (folderMatch?.[1]) {
    requireWriter(principal, 'folders:write');
    if (method === 'PATCH') {
      const body = (await readBoundedJSON(request)) as Record<string, string>;
      return json(await moveFolder(env, folderMatch[1], body));
    }
    if (method === 'DELETE') {
      await deleteFolder(env, folderMatch[1]);
      return noContent();
    }
  }

  // ---- categories ---------------------------------------------------------
  // A workspace's own list (migration 0008). Reading is for anyone who reads
  // documents; changing it is organizing, so it takes `folders:write`, the
  // scope Meet's exchanged token already carries.

  if (path === '/api/categories') {
    if (method === 'GET') {
      requireStaffOrAgentRead(principal);
      return json({ categories: await listCategories(env, actorEmail(principal)) });
    }
    if (method === 'POST') {
      const writer = requireWriter(principal, 'folders:write');
      return json(await createCategory(env, await readBoundedJSON(request), writer.actor, actorEmail(principal)), 201);
    }
  }

  if (method === 'PUT' && path === '/api/categories/order') {
    requireWriter(principal, 'folders:write');
    return json({ categories: await orderCategories(env, await readBoundedJSON(request), actorEmail(principal)) });
  }

  const categoryMatch = /^\/api\/categories\/([a-z0-9][a-z0-9-]{0,59})$/u.exec(path);
  if (categoryMatch?.[1] && (method === 'PATCH' || method === 'DELETE')) {
    requireWriter(principal, 'folders:write');
    if (method === 'PATCH') {
      return json(await updateCategory(env, categoryMatch[1], await readBoundedJSON(request), actorEmail(principal)));
    }
    await deleteCategory(env, categoryMatch[1]);
    return noContent();
  }

  // ---- documents ----------------------------------------------------------

  if (method === 'GET' && path === '/api/docs/summary') {
    requireStaffOrAgentRead(principal);
    return json(await summary(env, actorEmail(principal)));
  }

  if (method === 'GET' && path === '/api/docs') {
    requireStaffOrAgentRead(principal);
    const query = Object.fromEntries(url.searchParams);
    return json(await listDocuments(env, query, actorEmail(principal)));
  }

  if (method === 'POST' && path === '/api/docs') {
    const writer = requireWriter(principal, 'docs:write');
    const body = (await readBoundedJSON(request)) as Record<string, unknown>;
    if (typeof body.path === 'string') assertPathAllowed(principal, body.path);
    if (body.url !== undefined) {
      // A save lands in LINK_FOLDER unless told otherwise; a confined agent
      // must be allowed there too.
      assertPathAllowed(principal, typeof body.folder_path === 'string' ? body.folder_path : LINK_FOLDER);
      const { document, created } = await saveLink(env, body, writer);
      return json(document, created ? 201 : 200);
    }
    return json(await createDocument(env, body, writer), 201);
  }

  if (method === 'GET' && path === '/api/search') {
    requireStaffOrAgentRead(principal);
    return json({ hits: await search(env, Object.fromEntries(url.searchParams), actorEmail(principal)) });
  }

  if (method === 'GET' && path === '/api/sync/manifest') {
    requireStaffOrAgentRead(principal);
    return json(
      await manifest(env, {
        prefix: url.searchParams.get('prefix') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
        limit: Number(url.searchParams.get('limit')) || undefined,
      }, viewerKey(actorEmail(principal))),
    );
  }

  if (method === 'POST' && path === '/api/sync/push') {
    const writer = requireWriter(principal, 'sync:write');
    return json(await push(env, await readBoundedJSON(request), writer));
  }

  // ---- tokens -------------------------------------------------------------

  if (path === '/api/tokens') {
    const staff = requireStaff(principal);
    if (method === 'GET') return json({ tokens: await listTokens(env, staff.email) });
    if (method === 'POST') return json(await createToken(env, await readBoundedJSON(request), staff.email), 201);
  }

  const tokenMatch = /^\/api\/tokens\/([0-9a-f-]{36})$/u.exec(path);
  if (method === 'DELETE' && tokenMatch?.[1]) {
    const staff = requireStaff(principal);
    await revokeToken(env, tokenMatch[1], staff.email);
    return noContent();
  }

  // ---- signature requests (by id, not nested under a document) ------------

  const sigMatch = /^\/api\/signature-requests\/([0-9a-f-]{36})(\/[a-z]+)?$/u.exec(path);
  if (sigMatch?.[1]) {
    const requestId = sigMatch[1];
    const action = sigMatch[2];

    if (method === 'GET' && !action) {
      const detail = await getSignatureRequest(env, requestId, { includeURLs: principal.kind === 'staff' });
      await assertCanRead(env, principal, await resolveDocument(env, detail.document_id));
      return json(detail);
    }
    if (method === 'GET' && action === '/certificate') {
      const detail = await getSignatureRequest(env, requestId);
      await assertCanRead(env, principal, await resolveDocument(env, detail.document_id));
      return new Response(await certificate(env, requestId), {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (method === 'POST' && action === '/sign') {
      await assertUnderRateLimit(env.SIGN_LIMIT, request, 'sign');
      return json(await sign(env, request, requestId, await readBoundedJSON(request), principal));
    }
    if (method === 'POST' && action === '/decline') {
      await decline(env, request, requestId, await readBoundedJSON(request), principal);
      return noContent();
    }
    if (method === 'POST' && action === '/cancel') {
      requireWriter(principal, 'sign:manage');
      await cancel(env, requestId);
      return noContent();
    }
  }

  // ---- annotations addressed directly -------------------------------------

  const annotationMatch = /^\/api\/annotations\/([0-9a-f-]{36})$/u.exec(path);
  if (annotationMatch?.[1]) {
    // Addressed by its own id, a comment still belongs to a document: the
    // same read rule applies, so a private save's comments stay its owner's.
    await assertCanReadAnnotation(env, principal, annotationMatch[1]);
    if (method === 'PATCH') return json(await updateAnnotation(env, annotationMatch[1], await readBoundedJSON(request), principal));
    if (method === 'DELETE') {
      await deleteAnnotation(env, annotationMatch[1], principal);
      return noContent();
    }
  }

  const grantMatch = /^\/api\/grants\/([0-9a-f-]{36})$/u.exec(path);
  if (method === 'DELETE' && grantMatch?.[1]) {
    requireWriter(principal, 'grants:write');
    await revokeGrant(env, grantMatch[1]);
    return noContent();
  }

  // ---- one document -------------------------------------------------------

  // An attached image: the id is a uuid, which the sub-route grammar below
  // (lower-case words) does not take.
  const imageMatch = /^\/api\/docs\/([^/]+)\/images\/([0-9a-f-]{36})$/u.exec(path);
  if (imageMatch?.[1] && imageMatch[2]) {
    const document = await resolveDocument(env, decodeURIComponent(imageMatch[1]));
    await assertCanRead(env, principal, document);
    if (method === 'GET') return serveImage(env, document.id, imageMatch[2]);
    if (method === 'DELETE') {
      requireWriter(principal, 'docs:write');
      assertPathAllowed(principal, document.path);
      await removeImage(env, document, imageMatch[2]);
      return noContent();
    }
  }

  const documentMatch = /^\/api\/docs\/([^/]+)((?:\/[a-z-]+)*)$/u.exec(path);
  if (documentMatch?.[1]) {
    const reference = decodeURIComponent(documentMatch[1]);
    const tail = documentMatch[2] ?? '';
    return documentRoute(request, env, ctx, principal, reference, tail, method, url);
  }

  throw new NotFoundError('No such route.');
}

// ---------------------------------------------------------------------------
// Document sub-routes
// ---------------------------------------------------------------------------

async function documentRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
  reference: string,
  tail: string,
  method: string,
  url: URL,
): Promise<Response> {
  const document = await resolveDocument(env, reference);
  await assertCanRead(env, principal, document);

  switch (tail) {
    case '': {
      if (method === 'GET') {
        await recordAccessQuietly(env, {
          documentId: document.id,
          actor: actorEmail(principal),
          actorKind: principal.kind === 'staff' ? 'staff' : principal.kind === 'agent' ? 'agent' : 'guest',
          kind: 'view',
          request,
          ...(principal.kind === 'guest' ? { grantId: principal.guest.grantId } : {}),
        });
        return json(await getDocumentDetail(env, document));
      }
      if (method === 'PUT' || method === 'PATCH') {
        const writer = requireWriter(principal, 'docs:write');
        assertPathAllowed(principal, document.path);
        return json(await updateDocument(env, document, await readBoundedJSON(request), writer));
      }
      if (method === 'DELETE') {
        const writer = requireWriter(principal, 'docs:write');
        assertPathAllowed(principal, document.path);
        // `?purge=1` removes the text for good; plain DELETE hides the row.
        if (url.searchParams.get('purge') === '1') await purgeDocument(env, document);
        else await deleteDocument(env, document, writer);
        return noContent();
      }
      break;
    }

    case '/raw': {
      if (method !== 'GET') break;
      if (document.kind === 'pdf') {
        await recordAccessQuietly(env, {
          documentId: document.id,
          actor: actorEmail(principal),
          actorKind: principal.kind === 'staff' ? 'staff' : principal.kind === 'agent' ? 'agent' : 'guest',
          kind: 'download',
          request,
          ...(principal.kind === 'guest' ? { grantId: principal.guest.grantId } : {}),
        });
        return serveFile(env, document, url.searchParams.get('download') ? 'attachment' : 'inline');
      }
      return new Response(document.body_md ?? '', {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'cache-control': 'no-store',
          etag: `"${document.content_hash}"`,
          'x-content-sha256': document.content_hash,
        },
      });
    }

    case '/upload': {
      if (method !== 'POST') break;
      const writer = requireWriter(principal, 'docs:write');
      assertPathAllowed(principal, document.path);
      const row = await uploadPDF(env, request, { path: document.path, title: document.title }, writer, ctx);
      return json(await getDocumentDetail(env, row));
    }

    case '/link': {
      if (method !== 'PUT') break;
      requireWriter(principal, 'docs:write');
      assertPathAllowed(principal, document.path);
      return json(await updateLink(env, document, await readBoundedJSON(request)));
    }

    case '/images': {
      if (method === 'GET') return json({ images: await listImages(env, document.id) });
      if (method !== 'POST') break;
      const writer = requireWriter(principal, 'docs:write');
      assertPathAllowed(principal, document.path);
      return json(await uploadImage(env, request, document, writer, url.searchParams.get('caption')), 201);
    }

    case '/link-image': {
      if (method === 'GET') return serveLinkImage(env, document);
      if (method !== 'PUT' && method !== 'DELETE') break;
      requireWriter(principal, 'docs:write');
      assertPathAllowed(principal, document.path);
      if (method === 'DELETE') {
        await clearLinkImage(env, document);
        return noContent();
      }
      return json(await putLinkImage(env, request, document));
    }

    case '/subjects': {
      if (method === 'GET') return json({ subjects: (await getDocumentDetail(env, document)).subjects });
      if (method !== 'PUT') break;
      const writer = requireWriter(principal, 'docs:write');
      assertPathAllowed(principal, document.path);
      const body = (await readBoundedJSON(request)) as { subjects?: unknown };
      return json(await setSubjects(env, document, body.subjects ?? body, writer));
    }

    case '/move': {
      if (method !== 'POST') break;
      const writer = requireWriter(principal, 'docs:write');
      assertPathAllowed(principal, document.path);
      const body = documentMoveSchema.parse(await readBoundedJSON(request));
      if (body.folder_path) assertPathAllowed(principal, body.folder_path);
      return json(await moveDocument(env, document, body, writer));
    }

    case '/versions': {
      if (method !== 'GET') break;
      requireStaffOrAgentRead(principal);
      const { results } = await env.DB.prepare(
        `SELECT version, title, content_hash, byte_size, author, author_kind, message, created_at
           FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 200`,
      )
        .bind(document.id)
        .all();
      return json({ versions: results });
    }

    case '/annotations': {
      if (method === 'GET') return json({ annotations: await listAnnotations(env, document) });
      if (method === 'POST') {
        const annotation = await createAnnotation(env, document, await readBoundedJSON(request), principal);
        await recordAccessQuietly(env, {
          documentId: document.id,
          actor: actorEmail(principal),
          actorKind: principal.kind === 'staff' ? 'staff' : principal.kind === 'agent' ? 'agent' : 'guest',
          kind: 'annotate',
          request,
          ...(principal.kind === 'guest' ? { grantId: principal.guest.grantId } : {}),
        });
        return json(annotation, 201);
      }
      break;
    }

    case '/grants': {
      // Staff, or an agent holding `grants:write` — a Meet device token is
      // the latter, and sharing from Meet is the point. A grant is attributed
      // to the person either way.
      const writer = requireWriter(principal, 'grants:write');
      if (method === 'GET') return json({ grants: await listGrants(env, document.id) });
      if (method === 'POST') {
        const body = (await readBoundedJSON(request)) as Record<string, unknown>;
        const target = body.folder && document.folder_id ? { folderId: document.folder_id } : { documentId: document.id };
        if (!target.folderId) assertStaysInternal(document.category, 'link');
        const grant = await createGrant(env, target, body, writer.actor);
        // Sharing a private save is its owner making it not private.
        await promote(env, document, writer, 'shared');
        return json(grant, 201);
      }
      break;
    }

    case '/access-events': {
      if (method !== 'GET') break;
      // Who opened what is part of sharing: whoever may share a document may
      // read its log. Meet's token holds `grants:write`; Meet's /docs shows
      // the log beside the share links.
      requireWriter(principal, 'grants:write');
      return json({ events: await listAccessEvents(env, document.id) });
    }

    // The guest page's "opened" beacon. The workspace hears of a guest's view
    // from here, not from the GET of the document: the page sends both, and
    // this one is the reader's, with their time zone.
    case '/visit': {
      if (method !== 'POST') break;
      const body = visitSchema.parse(await readBoundedJSON(request));
      const place = principal.kind === 'guest' ? requestPlace(request) : null;
      const recorded = await recordAccessQuietly(env, {
        documentId: document.id,
        actor: actorEmail(principal),
        actorKind: principal.kind === 'staff' ? 'staff' : principal.kind === 'agent' ? 'agent' : 'guest',
        kind: 'view',
        request,
        timezone: body.timezone ?? null,
        language: body.language ?? null,
        referrer: body.referrer ?? null,
        ...(place ? { detail: { city: place.city, country: place.country } } : {}),
        ...(principal.kind === 'guest' ? { grantId: principal.guest.grantId } : {}),
      });
      if (principal.kind === 'guest' && place) {
        notifyDocumentAccessed(env, ctx, {
          recorded,
          document,
          kind: 'view',
          actor: principal.guest.email,
          via: 'grant',
          grantId: principal.guest.grantId,
          ...place,
          href: null,
        });
      }
      return noContent();
    }

    // A link opened from inside the document body.
    // The page sends it with keepalive and never waits for it. Clicks go to
    // the document's Activity; the workspace decides what else they do.
    case '/click': {
      if (method !== 'POST') break;
      await assertUnderRateLimit(env.CLAIM_LIMIT, request, 'click');
      const body = documentClickSchema.parse(await readBoundedJSON(request));
      const place = principal.kind === 'guest' ? requestPlace(request) : null;
      const recorded = await recordAccessQuietly(env, {
        documentId: document.id,
        actor: actorEmail(principal),
        actorKind: principal.kind === 'staff' ? 'staff' : principal.kind === 'agent' ? 'agent' : 'guest',
        kind: 'click',
        request,
        detail: { href: body.href, ...(place ? { city: place.city, country: place.country } : {}) },
        ...(principal.kind === 'guest' ? { grantId: principal.guest.grantId } : {}),
      });
      if (principal.kind === 'guest' && place) {
        notifyDocumentAccessed(env, ctx, {
          recorded,
          document,
          kind: 'click',
          actor: principal.guest.email,
          via: 'grant',
          grantId: principal.guest.grantId,
          ...place,
          href: body.href,
        });
      }
      return noContent();
    }

    case '/signature-requests': {
      if (method === 'POST') {
        const writer = requireWriter(principal, 'sign:manage');
        return json(await createSignatureRequest(env, document, await readBoundedJSON(request), writer.actor), 201);
      }
      if (method === 'GET') {
        // A guest sees only their own pending request; staff see all of them.
        if (principal.kind === 'guest') {
          const view = await getSignerView(env, document.id, principal.guest.email);
          return json({ requests: view ? [view] : [] });
        }
        requireWriter(principal, 'sign:manage');
        const { results } = await env.DB.prepare(
          `SELECT id FROM signature_requests WHERE document_id = ? ORDER BY created_at DESC LIMIT 50`,
        )
          .bind(document.id)
          .all<{ id: string }>();
        const requests = await Promise.all(
          results.map((row) => getSignatureRequest(env, row.id, { includeURLs: true })),
        );
        return json({ requests });
      }
      break;
    }
  }

  throw new NotFoundError('No such route.');
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * The single read gate.
 *
 * Staff read everything — that is the company's decision, not an oversight.
 * Agents read everything their prefix allows. A guest reads exactly what their
 * grant names, and nothing adjacent: holding a link to one document in a
 * folder does not reveal its neighbours.
 */
async function assertCanRead(
  env: Env,
  principal: Principal,
  document: Pick<DocumentRow, 'id' | 'category' | 'path' | 'visibility' | 'private_to'>,
): Promise<void> {
  // A private save is its owner's. Everyone else, staff included,
  // gets the missing-document answer, so its existence cannot be probed.
  if (!canView(document, principal.kind === 'guest' ? null : actorEmail(principal))) {
    throw new NotFoundError('No such document.');
  }
  if (principal.kind === 'staff') return;

  if (principal.kind === 'agent') {
    if (!principal.agent.scopes.includes('docs:read')) {
      throw new AuthError('This token is missing the `docs:read` scope.', 403, 'forbidden');
    }
    assertPathAllowed(principal, document.path);
    return;
  }

  // No grant, folder grant or visibility reaches a transcript from outside.
  if (document.category === 'transcript') throw new NotFoundError('No such document.');
  if (document.visibility === 'public') return;
  if (await guestCanReach(env, principal.guest, document.id, document.path)) return;
  // Same error a missing document produces: a guest must not be able to probe
  // for the existence of documents they were not given.
  throw new NotFoundError('No such document.');
}

async function assertCanReadAnnotation(env: Env, principal: Principal, annotationId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT document_id FROM annotations WHERE id = ?`)
    .bind(annotationId)
    .first<{ document_id: string }>();
  if (!row) return; // The annotation routes answer their own 404.
  const document = await getDocumentById(env, row.document_id);
  if (!document) return;
  await assertCanRead(env, principal, document);
}

function requireStaffOrAgentRead(principal: Principal): void {
  if (principal.kind === 'staff') return;
  if (principal.kind === 'agent' && principal.agent.scopes.includes('docs:read')) return;
  throw new AuthError('This action is for Envisioning accounts.', 403, 'forbidden');
}

function describePrincipal(principal: Principal): Record<string, unknown> {
  switch (principal.kind) {
    case 'staff':
      return { kind: 'staff', email: principal.staff.email, name: principal.staff.name, picture: principal.staff.picture };
    case 'guest':
      return {
        kind: 'guest',
        email: principal.guest.email,
        role: principal.guest.role,
        verified: principal.guest.verified,
        document_id: principal.guest.documentId,
        folder_id: principal.guest.folderId,
      };
    case 'agent':
      return {
        kind: 'agent',
        owner: principal.agent.owner,
        agent_name: principal.agent.agentName,
        scopes: principal.agent.scopes,
        path_prefix: principal.agent.pathPrefix,
      };
  }
}

function actorEmail(principal: Principal): string {
  switch (principal.kind) {
    case 'staff':
      return principal.staff.email;
    case 'guest':
      return principal.guest.email;
    case 'agent':
      return principal.agent.owner;
  }
}

function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  const head = name.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(name.length - 2, 1))}@${domain}`;
}

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

function addCORS(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (!origin || origin !== env.WEB_ORIGIN) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-credentials', 'true');
  headers.set('vary', 'origin');
  return new Response(response.body, { status: response.status, headers });
}

function errorStatus(error: unknown): number {
  if (error instanceof DocsError) return error.status;
  if (error instanceof ZodError) return 400;
  return 500;
}

function errorCode(error: unknown, status: number): DocsErrorCode {
  if (error instanceof DocsError) return error.code;
  if (error instanceof ZodError) return 'invalid_request';
  return status >= 500 ? 'internal' : 'invalid_request';
}

function publicError(error: unknown, status: number): string {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request.';
  }
  // 5xx prose is deliberately opaque; the request id is what to quote.
  if (status >= 500) return 'Something went wrong on our side.';
  return error instanceof Error ? error.message : 'Request failed.';
}

function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, message, ...fields }));
}

export { OpsService } from './ops';
