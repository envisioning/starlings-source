// Staff web lives in the workspace's Meet. This app
// keeps what Meet does not serve yet: share links, signing, certificates and
// tokens (#25 moves those too). Every other page a staff member could have
// bookmarked or been sent goes to the same thing in Meet's /docs, for good.
//
// A document or folder is looked up only for a signed-in staff member. Anyone
// else goes to Meet's /docs, which signs them in: a redirect that named a
// document id would tell a stranger which paths exist.

import { getDocumentByPath } from './documents';
import { getFolderById } from './folders';

export type StaffPrincipalCheck = () => Promise<boolean>;

const FOLDER = /^\/folder\/([0-9a-f-]{36})$/u;

/** The Meet URL for a staff page of this app, or null when the path is not one. */
export async function staffRedirect(env: Env, url: URL, isStaff: StaffPrincipalCheck): Promise<string | null> {
  const origin = env.MEET_WEB_ORIGIN;
  if (!origin) return null;
  const path = url.pathname;
  const docs = `${origin}/docs`;

  if (path === '/' || path === '/new' || path === '/categories') return docs;

  if (path.startsWith('/doc/')) {
    if (!(await isStaff())) return docs;
    const documentPath = safeDecode(path.slice('/doc'.length));
    const document = documentPath ? await getDocumentByPath(env, documentPath) : null;
    return document && document.status !== 'deleted' ? `${docs}/document/${document.id}` : docs;
  }

  const folderId = FOLDER.exec(path)?.[1];
  if (folderId) {
    if (!(await isStaff())) return docs;
    const folder = await getFolderById(env, folderId);
    return folder ? `${docs}?${new URLSearchParams({ view: `folder:${folder.path}` })}` : docs;
  }

  return null;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
