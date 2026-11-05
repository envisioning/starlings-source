package work.starlings.android.workspace.work

import work.starlings.contracts.CrmIssueLabel
import work.starlings.contracts.CrmIssueWire

/** The label and login rules `iOS/MobileIssueChrome.swift` draws with, apart from the drawing. */
object IssueLabels {
    /** `MobileLabelChip.colour(from:)`: `d73a4a`, with or without its hash, as opaque ARGB; anything else is no colour. */
    fun colour(hex: String?): Long? {
        var raw = hex?.trim()?.lowercase() ?: return null
        if (raw.startsWith("#")) raw = raw.drop(1)
        if (raw.length != 6) return null
        val value = raw.toLongOrNull(16) ?: return null
        return 0xFF000000L or value
    }

    /** `MobileLoginAvatar.initials(of:)`: `envisioning-core[bot]` is EC, `mz` is MZ. */
    fun initials(login: String): String {
        val parts = login.split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }.take(2)
        val letters = parts.map { it.first().toString() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }

    /** `drawableLabels`: the coloured details, or the names in the app's grey when Core sent only names. */
    fun drawable(issue: CrmIssueWire): List<CrmIssueLabel> =
        issue.labelDetails?.takeIf { it.isNotEmpty() } ?: issue.labels.map { CrmIssueLabel(name = it) }
}
