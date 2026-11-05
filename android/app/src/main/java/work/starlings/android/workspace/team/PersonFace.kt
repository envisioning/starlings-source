package work.starlings.android.workspace.team

import android.graphics.BitmapFactory
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import work.starlings.android.api.TeamMediaRoutes
import work.starlings.android.ui.PeerAvatar
import work.starlings.android.ui.PresenceDot
import work.starlings.contracts.AgentAvatarIdentityWire
import work.starlings.contracts.PeerWire

/** The app's one picture cache, in memory, as `PersonAvatarStore.shared`. */
object Faces {
    val pictures = PersonPictures<ImageBitmap>()

    /** Publish the roster's versions. Cheap and idempotent. */
    suspend fun remember(peers: List<PeerWire>) = pictures.remember(peers.map { it.email to it.avatarUpdatedAt })

    suspend fun load(media: TeamMedia, email: String, version: Long?): ImageBitmap? =
        pictures.picture(email, version) { v ->
            val bytes = media.bytes(TeamMediaRoutes.avatar(email, v), TeamMedia.AVATAR_MAX_BYTES) ?: return@picture null
            withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
        }
}

/** The signed-in byte reader faces load through; provided by the app-level Team session. */
val LocalTeamMedia = staticCompositionLocalOf<TeamMedia?> { null }

/**
 * `PersonAvatarImage`: somebody's face over their initials. Loads again only
 * when the person or their version changes, so a roster poll every thirty
 * seconds decodes nothing. A null [version] asks for whatever the roster last
 * published for [email], which is what lets a message row draw a face.
 */
@Composable
fun PersonFace(
    email: String?,
    name: String,
    version: Long?,
    dot: PresenceDot = PresenceDot.NONE,
    modifier: Modifier = Modifier,
    diameter: Dp = 40.dp,
    agent: AgentAvatarIdentityWire? = null,
) {
    if (agent != null) {
        PeerAvatar(name, dot, modifier, diameter, face = { AgentAvatarImage(agent, diameter = diameter) })
        return
    }
    val media = LocalTeamMedia.current
    val picture by produceState<ImageBitmap?>(null, email, version, media) {
        value = if (email == null || media == null) null else Faces.load(media, email, version)
    }
    PeerAvatar(name, dot, modifier, diameter, picture)
}

/** A roster row's face, at the roster's version; an agent draws its seeded identity. No dot on an agent. */
@Composable
fun PeerFace(peer: PeerWire, dot: PresenceDot, modifier: Modifier = Modifier, diameter: Dp = 40.dp) =
    PersonFace(peer.email, peer.displayName, peer.avatarUpdatedAt, if (peer.agentAvatar != null) PresenceDot.NONE else dot, modifier, diameter, peer.agentAvatar)

/**
 * A face for somebody known only by address (a search row, a message):
 * the roster's agent identity when the address is an agent's, else their
 * picture at the roster's version (`MobileHomeView.mark`).
 */
@Composable
fun AddressFace(email: String?, name: String, modifier: Modifier = Modifier, diameter: Dp = 40.dp, version: Long? = null) {
    val roster = LocalTeamStore.current?.roster
    val agent = email?.let { address -> roster?.peers?.firstOrNull { it.isAgent && it.email.equals(address, ignoreCase = true) }?.agentAvatar }
    PersonFace(email, name, version, PresenceDot.NONE, modifier, diameter, agent)
}
