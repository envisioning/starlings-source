package work.starlings.android

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.SystemClock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * The A0 call record: one JSON line per event, in app storage, for the
 * device report. It holds no names, emails, tokens, room slugs or participant
 * identities: remote people are counted, not named. Debug builds read it with
 * `adb shell run-as work.starlings.android cat files/diagnostics/<file>`, or
 * the Ended screen shares it.
 */
class CallLog(private val context: Context) {
    private val dir = File(context.filesDir, "diagnostics")
    private var file: File? = null
    private var startedAt = 0L
    private val summary = Summary()

    val current: File? get() = file

    /** What the Ended screen shows, and the last line of the file. */
    data class Summary(
        var durationS: Long = 0,
        var reconnects: Int = 0,
        var interruptions: Int = 0,
        var backgroundS: Long = 0,
        var maxPssMb: Int = 0,
        var batteryStart: Int = -1,
        var batteryEnd: Int = -1,
        var maxThermal: Int = 0,
        var maxBatteryTempC: Double = 0.0,
        var maxParticipants: Int = 0,
    )

    fun begin() {
        dir.mkdirs()
        dir.listFiles()?.sortedByDescending { it.name }?.drop(KEEP)?.forEach { it.delete() }
        startedAt = SystemClock.elapsedRealtime()
        file = File(dir, FILE_NAME.format(Instant.now()) + ".jsonl")
        summary.apply {
            durationS = 0; reconnects = 0; interruptions = 0; backgroundS = 0; maxPssMb = 0
            batteryStart = batteryPercent(); batteryEnd = -1; maxThermal = 0; maxBatteryTempC = 0.0; maxParticipants = 0
        }
        event(
            "device",
            "manufacturer" to Build.MANUFACTURER,
            "model" to Build.MODEL,
            "sdk" to Build.VERSION.SDK_INT,
            "app" to BuildConfig.VERSION_NAME,
            "build" to BuildConfig.GIT_COMMIT,
        )
    }

    fun event(kind: String, vararg fields: Pair<String, Any?>) {
        val f = file ?: return
        val line = buildJsonObject {
            put("t_ms", SystemClock.elapsedRealtime() - startedAt)
            put("at", WALL.format(Instant.now()))
            put("kind", kind)
            fields.forEach { (k, v) -> put(k, primitive(v)) }
        }
        runCatching { f.appendText(line.toString() + "\n") }
        when (kind) {
            "reconnecting" -> summary.reconnects++
            "audio_focus_lost" -> summary.interruptions++
        }
    }

    fun backgroundFor(ms: Long) {
        summary.backgroundS += ms / 1000
    }

    /** Every 10 s in a call: the numbers the A0 thresholds are judged on. */
    fun sample(participants: Int, audio: List<AudioProbe.Reading>, extra: Array<Pair<String, Any?>>) {
        val pssMb = (Debug.getPss() / 1024).toInt()
        val thermal = context.getSystemService(PowerManager::class.java).currentThermalStatus
        val headroom = context.getSystemService(PowerManager::class.java).getThermalHeadroom(10)
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val tempC = (battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0
        val charging = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val memory = ActivityManager.MemoryInfo().also {
            context.getSystemService(ActivityManager::class.java).getMemoryInfo(it)
        }
        summary.maxPssMb = maxOf(summary.maxPssMb, pssMb)
        summary.maxThermal = maxOf(summary.maxThermal, thermal)
        summary.maxBatteryTempC = maxOf(summary.maxBatteryTempC, tempC)
        summary.maxParticipants = maxOf(summary.maxParticipants, participants)
        event(
            "sample",
            "participants" to participants,
            "pss_mb" to pssMb,
            "low_memory" to memory.lowMemory,
            "battery_pct" to batteryPercent(),
            "charging" to charging,
            "battery_temp_c" to tempC,
            "thermal_status" to thermal,
            "thermal_headroom_10s" to if (headroom.isNaN()) null else headroom.toDouble(),
            "network" to network(),
            *extra,
            *audio.flatMap { r ->
                listOf(
                    "audio_${r.label}_fps" to r.framesPerSecond,
                    "audio_${r.label}_hz" to r.sampleRate,
                    "audio_${r.label}_ch" to r.channels,
                    "audio_${r.label}_gap_ms" to r.maxGapMs,
                )
            }.toTypedArray(),
        )
    }

    fun end(reason: String): Summary {
        summary.durationS = (SystemClock.elapsedRealtime() - startedAt) / 1000
        summary.batteryEnd = batteryPercent()
        event(
            "summary",
            "reason" to reason,
            "duration_s" to summary.durationS,
            "reconnects" to summary.reconnects,
            "interruptions" to summary.interruptions,
            "background_s" to summary.backgroundS,
            "max_pss_mb" to summary.maxPssMb,
            "battery_start_pct" to summary.batteryStart,
            "battery_end_pct" to summary.batteryEnd,
            "max_thermal_status" to summary.maxThermal,
            "max_battery_temp_c" to summary.maxBatteryTempC,
            "max_participants" to summary.maxParticipants,
        )
        return summary.copy()
    }

    private fun batteryPercent(): Int =
        context.getSystemService(BatteryManager::class.java).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)

    private fun network(): String {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            else -> "other"
        }
    }

    private fun primitive(v: Any?): JsonElement = when (v) {
        null -> JsonPrimitive(null as String?)
        is Number -> JsonPrimitive(v)
        is Boolean -> JsonPrimitive(v)
        else -> JsonPrimitive(v.toString())
    }

    private companion object {
        const val KEEP = 20
        // Both clocks are 24-hour UTC.
        val WALL: DateTimeFormatter = DateTimeFormatter.ISO_INSTANT
        val FILE_NAME: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC)
    }
}
