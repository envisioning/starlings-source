// The values that say which organisation this deployment is. Change them for
// your own deployment. `deployment.ts` explains what each value does.
//
// Dependency-free: plain Node scripts, the browser bundle and the Workers
// import it.

export const IDENTITY_DOMAINS = ['org.example', 'org-alt.example'] as const;
export const SIGN_IN_DOMAIN = 'org.example';
export const WORKSPACE_HOST_SUFFIX = 'starlings.example';
export const PUBLIC_WEB_ORIGIN = 'https://envisioning.starlings.example';
export const SERVED_WEB_ORIGIN = 'https://envisioning.starlings.example';
export const PRODUCT_SITE_ORIGIN = 'https://site.example';
export const PLATFORM_WORKSPACE_ORIGIN = 'https://hq.starlings.example';
export const CORE_API_ORIGIN = 'https://core.org.example';
export const KEEP_WEB_ORIGIN = 'https://keep.org.example';
export const DOCS_PUBLIC_ORIGIN = 'https://docs.workers.org.example';
export const SIGNALS_ORIGIN = 'https://signals.org.example';
export const DOCS_ISSUER = 'docs.org.example';
export const DOCS_EMAIL_FROM = 'docs@org.example';
export const KEEP_ISSUER = 'keep.org.example';
export const KEEP_PRF_SALT_LABEL = 'keep.org.example/prf/v1';
export const ORG_NAME = 'Envisioning';
export const ORG_ICS_PRODUCT_ID = '-//Envisioning//Meet//EN';
export const ORG_WEB_ORIGIN = 'https://org.example';
export const ORG_WWW_ORIGIN = 'https://www.org.example';
export const CONTACT_EMAIL = 'contact@site.example';
export const PRIVACY_CONTACT_EMAIL = 'contact@site.example';
export const PRIVACY_OFFICER_NAME = 'Your data protection officer';
export const SYSTEM_SENDER_EMAIL = 'meet@org.example';
export const LEGACY_SESSION_ISSUER = 'meet.org.example';
export const LEGACY_WORKER_HOST = 'legacy.org.example';
export const LEGACY_ALIAS_HOSTS = [LEGACY_WORKER_HOST, 'meet.org.example'] as const;
export const SHARED_SECRETS_STORE_ID = 'replace-with-secrets-store-id';
