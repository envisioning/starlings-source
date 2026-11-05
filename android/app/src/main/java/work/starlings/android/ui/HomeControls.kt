package work.starlings.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.QuestionMark
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.zIndex
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import work.starlings.android.ParticipantInitials

/**
 * The pieces every Home card is built from, as iOS draws them
 * (iOS/StarlingsMobileDesign.swift, iOS/MobileHomeView.swift).
 */

/** A card's caps title: `.font(.caption.bold())` in secondary ink. */
@Composable
fun HomeCardLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = StarlingsType.caption.copy(fontWeight = FontWeight.Bold), color = Starlings.colors.secondary)
}

/**
 * `meetHomeRow` (docs/DESIGN.md, "Home rows"): the elevated rung on the
 * card's panel, radius `field`, 12 of padding. A phone has no pointer, so
 * there is no lift.
 */
fun Modifier.homeRow(fill: Color): Modifier =
    fillMaxWidth().background(fill, RoundedCornerShape(StarlingsRadius.field)).padding(12.dp)

/** `MobileCompactMark`: a symbol in a square or round well, the leading mark of a Home row. Decorative. */
@Composable
fun CompactMark(icon: ImageVector, modifier: Modifier = Modifier, round: Boolean = false, size: Dp = 24.dp, tint: Color = Starlings.colors.secondary) {
    val c = Starlings.colors
    Box(
        modifier
            .size(size)
            .background(c.canvas.copy(alpha = 0.6f), if (round) CircleShape else RoundedCornerShape(6.dp))
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(size * 0.6f), tint = tint)
    }
}

/**
 * `MobileHomeLoadingCard`: the fixed-height shell a module draws until its
 * first answer. Hidden from TalkBack, as on iOS.
 */
@Composable
fun HomeLoadingCard(rows: Int, rowHeight: Dp, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    StarlingsCard(modifier.clearAndSetSemantics { }) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Bar(92.dp, 10.dp)
                Spacer(Modifier.weight(1f))
                Bar(44.dp, 10.dp)
            }
            repeat(rows) {
                Row(
                    Modifier.heightIn(min = rowHeight).homeRow(c.elevated),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(16.dp).background(c.border, RoundedCornerShape(5.dp)))
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Bar(150.dp, 10.dp)
                        Bar(218.dp, 8.dp)
                    }
                }
            }
        }
    }
}

@Composable
private fun Bar(width: Dp, height: Dp) {
    Box(Modifier.width(width).size(width, height).background(Starlings.colors.border, CircleShape))
}

/** An attendee's reply, as the face's corner badge draws it. */
enum class AttendeeReply { ACCEPTED, DECLINED, TENTATIVE, PENDING }

/** One face in [AttendeeStack]: initials, the reply on the corner, a ring for a member. */
data class AttendeeFace(val name: String, val reply: AttendeeReply, val isMember: Boolean)

/**
 * `MobileAttendeeStack`: overlapping faces, at most five, then "+N"; one
 * face too many shows instead of a "+1". The first face is on top, so each
 * badge shows over the next face. Decorative: the caller labels the stack.
 */
@Composable
fun AttendeeStack(faces: List<AttendeeFace>, modifier: Modifier = Modifier, size: Dp = 22.dp) {
    val c = Starlings.colors
    val maximum = 5
    val overflow = if (faces.size > maximum) faces.size - (maximum - 1) else 0
    val shown = if (overflow > 0) faces.take(maximum - 1) else faces
    val overlap = (size.value * 0.2f).let { kotlin.math.round(it) }.dp
    Row(modifier.clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(-overlap)) {
        shown.forEachIndexed { index, face ->
            AttendeeAvatar(face, size, Modifier.zIndex((shown.size - index).toFloat()))
        }
        if (overflow > 0) {
            Box(
                Modifier.size(size).background(c.elevated, CircleShape).border(1.5.dp, c.panel, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("+$overflow", style = StarlingsType.caption2.copy(fontSize = 9.sp, fontWeight = FontWeight.SemiBold), color = c.secondary)
            }
        }
    }
}

/** `MobileAttendeeAvatar`: declined is a cross and faded, tentative a question mark, no reply a hollow ring. */
@Composable
private fun AttendeeAvatar(face: AttendeeFace, size: Dp, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Box(modifier.size(size).alpha(if (face.reply == AttendeeReply.DECLINED) 0.55f else 1f)) {
        Box(
            Modifier
                .size(size)
                .background(c.elevated, CircleShape)
                .border(1.5.dp, c.panel, CircleShape)
                .then(if (face.isMember) Modifier.padding(1.5.dp).border(1.dp, c.secondary.copy(alpha = 0.6f), CircleShape) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            Text(ParticipantInitials.make(face.name), style = StarlingsType.caption2.copy(fontSize = 8.sp, fontWeight = FontWeight.SemiBold), color = c.secondary)
        }
        if (face.reply != AttendeeReply.ACCEPTED) {
            Box(
                Modifier.align(Alignment.BottomEnd).size(10.dp).background(c.panel, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                when (face.reply) {
                    AttendeeReply.DECLINED -> Icon(Icons.Filled.Close, null, Modifier.size(7.dp), tint = c.primary)
                    AttendeeReply.TENTATIVE -> Icon(Icons.Filled.QuestionMark, null, Modifier.size(7.dp), tint = c.primary)
                    else -> Box(Modifier.padding(2.5.dp).size(5.dp).border(1.dp, c.primary, CircleShape))
                }
            }
        }
    }
}
