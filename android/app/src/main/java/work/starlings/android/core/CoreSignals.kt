package work.starlings.android.core

import kotlinx.serialization.json.JsonObject

/** A contact's Signals outreach state. No client drafts the mail (decided by MZ, 2026-11-05). */
object CoreSignals {
    /** `signals_outreach_status`, in order (`SIGNALS_OUTREACH_STATUS_VALUES`). */
    val statusOrder = listOf("to_notify", "notified", "replied", "interested", "not_interested")

    fun statusLabel(value: String): String = when (value) {
        "to_notify" -> "To notify"
        "notified" -> "Notified"
        "replied" -> "Replied"
        "interested" -> "Interested"
        "not_interested" -> "Not interested"
        else -> value
    }

    /** The next stage on the positive path; null at Interested. Not interested is always a choice, never an advance. */
    fun nextStatus(after: String): String? {
        val index = statusOrder.indexOf(after)
        if (index < 0 || index + 1 >= statusOrder.size) return null
        return statusOrder[index + 1].takeIf { it != "not_interested" }
    }

    fun status(record: JsonObject): String = record["signals_outreach_status"].coreString().orEmpty()
}
