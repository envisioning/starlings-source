package work.starlings.android

/**
 * Which organisation this build belongs to. The values match
 * `packages/contracts/src/deployment-values.ts`; `RulesFixtureTest` pins them to
 * `fixtures/shared-constants.json`. The manifest and `build.gradle.kts` carry
 * the same built-in origin.
 */
object Deployment {
    val IDENTITY_DOMAINS = listOf("org.example", "org-alt.example")
    const val PUBLIC_WEB_ORIGIN = "https://envisioning.starlings.example"
    const val SERVED_WEB_ORIGIN = "https://envisioning.starlings.example"
    const val WORKSPACE_HOST_SUFFIX = "starlings.example"
    const val PRODUCT_SITE_ORIGIN = "https://site.example"
    const val CORE_API_ORIGIN = "https://core.org.example"
    const val ORG_WWW_ORIGIN = "https://www.org.example"
    const val SIGNALS_ORIGIN = "https://signals.org.example"
    const val CRM_CAPTURE_ADDRESS = "cc@org.example"
    const val KEEP_PRF_SALT_LABEL = "keep.org.example/prf/v1"
    const val DOCS_ORIGIN = "https://docs.workers.org.example"
    const val KEEP_WORKER_HOST = "keep.workers.org.example"
    const val SERVED_WEB_HOST = "envisioning.starlings.example"
    const val LEGACY_WORKER_HOST = "legacy.org.example"
}
