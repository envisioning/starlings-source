package work.starlings.android.host

/**
 * When a knock becomes a notification (`KnockNotices` in
 * iOS/MobileLobbyWatch.swift). Not push: a hosted call keeps the app alive,
 * which is the only reason a local notification is worth posting.
 *
 * - Only while this device holds the host and the app is in the background.
 *   On screen the waiting-room badge and the haptic say it already.
 * - One notification, replaced by the next knock, naming the newest guest.
 * - A knock seen in the foreground is not posted later on the way out.
 * - Withdrawn when the queue empties, the app comes back, or hosting stops.
 * - The notification only opens the waiting room. Admit and decline are not
 *   actions on it: deciding from a banner is deciding without seeing who asks.
 */
class KnockNoticeGate {
    sealed interface Action {
        data class Post(val name: String, val waiting: Int) : Action
        data object Withdraw : Action
        data object Keep : Action
    }

    private var seen = 0
    private var posted = false

    fun step(host: HostState, lobby: LobbyWatch.State, foreground: Boolean): Action {
        val fresh = lobby.knockCount > seen
        seen = lobby.knockCount
        val guest = lobby.announced
        val action = when {
            host.phase != HostPhase.HOSTING || !host.holdsHost || foreground || lobby.waiting.isEmpty() ->
                if (posted) Action.Withdraw else Action.Keep
            fresh && guest != null -> Action.Post(guest.name, lobby.waiting.size)
            else -> Action.Keep
        }
        when (action) {
            is Action.Post -> posted = true
            Action.Withdraw -> posted = false
            Action.Keep -> Unit
        }
        return action
    }

    /** Hosting ended: withdraw whatever is up and start counting again. */
    fun reset(): Action {
        seen = 0
        if (!posted) return Action.Keep
        posted = false
        return Action.Withdraw
    }
}
