package work.starlings.android.workspace.team

import work.starlings.contracts.AgentActivityWire
import work.starlings.contracts.AgentManifestDoc
import work.starlings.contracts.AgentManifestKey
import work.starlings.contracts.AgentManifestTool
import work.starlings.contracts.AgentManifestWire
import work.starlings.contracts.CrmIssueLabel
import work.starlings.contracts.PeerWire

/*
 * An agent's self-reported manifest and the Worker's count of its jobs, as
 * `Sources/PeerPresence.swift` reads them (`AgentManifest`, `AgentActivity`).
 * Every string is the runtime's own words, drawn as text, never markup.
 * Pure, so the JVM tests hold it.
 */
object AgentManifests {
    /** A link out: its title word, and an http(s) address. */
    data class Link(val title: Title, val url: String)

    enum class Title { HOME, README, REPO }

    /** One line under Activity, in the order iOS draws them (`AgentActivity.lines`). */
    sealed interface ActivityLine {
        /** "12 jobs", and ", 3 in the last 30 days" when there were any. */
        data class Jobs(val total: Long, val recent: Long) : ActivityLine
        data class Resets(val count: Long) : ActivityLine
        data class LastReply(val atMs: Long) : ActivityLine
        data class UsuallyReplies(val duration: String) : ActivityLine
    }

    /**
     * The agent whose empty DM shows its card (`agentPeer`): the roster agent
     * this conversation is with, when its runtime serves a manifest. Null for
     * a person, a channel, or a name-only agent.
     */
    fun cardAgent(peerEmail: String?, agents: List<PeerWire>): PeerWire? {
        val email = peerEmail ?: return null
        return agents.firstOrNull { it.email == email && it.manifest != null }
    }

    /** `AgentManifest.links`: Home, Readme, Repo, only the ones that are an http(s) address. */
    fun links(manifest: AgentManifestWire): List<Link> = listOfNotNull(
        webUrl(manifest.homeUrl)?.let { Link(Title.HOME, it) },
        webUrl(manifest.readmeUrl)?.let { Link(Title.README, it) },
        webUrl(manifest.repoUrl)?.let { Link(Title.REPO, it) },
    )

    /**
     * An address a tap may open: http or https with a host, else null. The
     * contract clamps these already; this side fails closed too.
     */
    fun webUrl(raw: String?): String? {
        val text = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val uri = runCatching { java.net.URI(text) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (uri.host.isNullOrEmpty()) return null
        return text
    }

    /** A tool's name, and the human gate after it (`requiresApproval`). */
    fun asksFirst(tool: AgentManifestTool): Boolean = tool.requiresApproval == true

    /** `docs`: the one it must read on every job first, then the rest, each in manifest order. */
    fun docs(manifest: AgentManifestWire): List<AgentManifestDoc> {
        val all = manifest.docs.orEmpty()
        return all.filter { it.required == true } + all.filter { it.required != true }
    }

    fun docTitle(doc: AgentManifestDoc): String = doc.title ?: doc.name

    /** How many keys the runtime expects and did not find. */
    fun missingKeys(manifest: AgentManifestWire): Int = manifest.keys.orEmpty().count { !it.set }

    /** `AgentManifestKey.chip`: set is the accent, missing is red. Never a value. */
    fun keyChip(key: AgentManifestKey): CrmIssueLabel = CrmIssueLabel(name = key.name, color = if (key.set) "d6f249" else "d73a4a")

    /** `buildLine`'s time: when the build was made, never later than [nowMs]. */
    fun builtAt(manifest: AgentManifestWire, nowMs: Long): Long? = manifest.builtAt?.let { minOf(it, nowMs) }

    /** `trimmedNonEmpty`. */
    fun text(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }

    /** `AgentActivity.lines`. */
    fun activityLines(activity: AgentActivityWire, nowMs: Long): List<ActivityLine> = buildList {
        add(ActivityLine.Jobs(activity.jobsTotal, activity.jobs30d.coerceAtLeast(0)))
        if (activity.resets30d > 0) add(ActivityLine.Resets(activity.resets30d))
        activity.lastRepliedAt?.let { add(ActivityLine.LastReply(minOf(it, nowMs))) }
        activity.typicalReplyMs?.let { add(ActivityLine.UsuallyReplies(duration(it / 1000.0))) }
    }

    /** `AgentActivity.duration`: "40 s", "4 min", "2 h", the coarsest unit that still says something. */
    fun duration(seconds: Double): String = when {
        seconds < 90 -> "${Math.round(seconds)} s"
        seconds < 5400 -> "${Math.round(seconds / 60)} min"
        else -> "${Math.round(seconds / 3600)} h"
    }
}
