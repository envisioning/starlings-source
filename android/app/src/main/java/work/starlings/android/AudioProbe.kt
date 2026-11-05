package work.starlings.android

import android.os.SystemClock
import io.livekit.android.room.track.AudioTrack
import livekit.org.webrtc.AudioTrackSink
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * A0: proves separate PCM per participant while video runs (plan §A0). One
 * sink per audio track, local and remote, so attribution never depends on a
 * mixed speaker output. It counts frames and keeps no audio: nothing here
 * copies or stores the buffer. `onData` runs on the WebRTC audio thread, so
 * it only touches atomics.
 */
class AudioProbe {
    data class Reading(
        val label: String,
        val framesPerSecond: Long,
        val sampleRate: Int,
        val channels: Int,
        val maxGapMs: Long,
    )

    private class Tap(val label: String) : AudioTrackSink {
        val frames = AtomicLong()
        val lastAt = AtomicLong(0)
        val maxGap = AtomicLong(0)
        @Volatile var sampleRate = 0
        @Volatile var channels = 0

        override fun onData(data: ByteBuffer?, bits: Int, rate: Int, channelCount: Int, frameCount: Int, captureMs: Long) {
            frames.addAndGet(frameCount.toLong())
            sampleRate = rate
            channels = channelCount
            val now = SystemClock.elapsedRealtime()
            val last = lastAt.getAndSet(now)
            if (last != 0L) maxGap.accumulateAndGet(now - last) { a, b -> maxOf(a, b) }
        }
    }

    private val taps = ConcurrentHashMap<String, Pair<AudioTrack, Tap>>()
    private var nextRemote = 1
    private var lastReadAt = SystemClock.elapsedRealtime()

    /** [key] is the track sid; labels are `local` and `r1`, `r2`, … never a name. */
    fun attach(key: String, track: AudioTrack, local: Boolean) {
        if (taps.containsKey(key)) return
        val tap = Tap(if (local) "local" else "r${nextRemote++}")
        track.addSink(tap)
        taps[key] = track to tap
    }

    fun detach(key: String) {
        taps.remove(key)?.let { (track, tap) -> track.removeSink(tap) }
    }

    fun detachExcept(keep: Set<String>) {
        taps.keys.filter { it !in keep }.forEach(::detach)
    }

    fun detachAll() {
        taps.keys.toList().forEach(::detach)
    }

    /** Frames per second since the last read, then resets the window. */
    fun read(): List<Reading> {
        val now = SystemClock.elapsedRealtime()
        val seconds = ((now - lastReadAt).coerceAtLeast(1)) / 1000.0
        lastReadAt = now
        return taps.values.map { (_, tap) ->
            Reading(
                tap.label,
                (tap.frames.getAndSet(0) / seconds).toLong(),
                tap.sampleRate,
                tap.channels,
                tap.maxGap.getAndSet(0),
            )
        }.sortedBy { it.label }
    }
}
