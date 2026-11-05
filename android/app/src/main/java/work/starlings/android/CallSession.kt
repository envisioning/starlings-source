package work.starlings.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.Uri
import android.net.ConnectivityManager
import android.net.Network
import android.os.SystemClock
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.twilio.audioswitch.AudioDevice
import io.livekit.android.LiveKit
import io.livekit.android.audio.AudioSwitchHandler
import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.AudioTrack
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.track.processing.video.VirtualBackgroundVideoProcessor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.WebSocket
import work.starlings.android.background.BackgroundEffect
import work.starlings.android.background.BackgroundEffects
import work.starlings.android.background.CustomBackgroundStore
import work.starlings.android.background.WorkspaceBackgrounds
import work.starlings.android.host.HostMedia
import work.starlings.android.host.HostMediaState
import work.starlings.contracts.HostMessageWire
import work.starlings.contracts.WireJson

sealed interface CallState {
    data object Idle : CallState
    data object Knocking : CallState
    data class Waiting(val waitingCount: Int, val ownerName: String? = null) : CallState
    data object Connecting : CallState
    data object InCall : CallState
    /**
     * [room] is the slug the call was for, [connectedMs] how long it was
     * connected (null when it never connected): the ended screen's
     * "Lasted" and "Room" lines, as iOS `endedSummary`. [left] is this
     * phone's own Leave; [failure] is a call that ended before it was in
     * the meeting (`EndedSummary.isFailure`).
     */
    data class Ended(
        val reason: String,
        val summary: CallLog.Summary? = null,
        val room: String? = null,
        val connectedMs: Long? = null,
        val left: Boolean = false,
        val failure: Boolean = false,
    ) : CallState
}

data class Tile(
    val key: String,
    val name: String,
    /** The name initials come from: the participant's own, also for "You". */
    val initialsOf: String,
    val isLocal: Boolean,
    val speaking: Boolean,
    val video: VideoTrack?,
    val screenShare: Boolean,
    /** Epoch ms the hand went up, or null; the Worker writes it. */
    val handRaisedAt: Long? = null,
    val host: Boolean = false,
    val facts: ParticipantFacts = ParticipantFacts(null, false, false),
    /** LiveKit's score for this participant's connection (the tile's bars). */
    val quality: CallQuality = CallQuality.UNKNOWN,
)

data class CallUi(
    val tiles: List<Tile> = emptyList(),
    val micOn: Boolean = false,
    val cameraOn: Boolean = false,
    val audioDevices: List<AudioDevice> = emptyList(),
    val audioDevice: AudioDevice? = null,
    val reconnecting: Boolean = false,
    /** Another app (a phone call, a voice assistant) holds the audio. */
    val audioTaken: Boolean = false,
    val handRaised: Boolean = false,
)

/**
 * One call, owned by the Application, not by a screen. The UI only observes it.
 * Lobby poll intervals match the web client (`LOBBY_POLL_SECONDS` = 5,
 * `LOBBY_SOCKET_POLL_SECONDS` = 15 while the socket is open).
 */
class CallSession(private val context: Context, api: LobbyApi) : HostMedia {
    /** The active workspace's lobby; [retarget] replaces it on a switch. */
    var api: LobbyApi = api
        private set
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var job: Job? = null
    private var callJobs = mutableListOf<Job>()
    private var room: Room? = null
    private val log = CallLog(context)
    private val probe = AudioProbe()
    private val prefs = context.getSharedPreferences("call", Context.MODE_PRIVATE)

    private var ownerName: String? = null
    /** The room this call is for, and when it connected: the ended screen's facts. */
    private var slug: String? = null
    private var connectedAt = 0L
    private var cameraPausedForBackground = false
    private var backgroundSince = 0L
    private var receivers = mutableListOf<BroadcastReceiver>()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change -> onAudioFocus(change) }

    private val _state = MutableStateFlow<CallState>(CallState.Idle)
    val state: StateFlow<CallState> = _state.asStateFlow()
    private val _ui = MutableStateFlow(CallUi())
    val ui: StateFlow<CallUi> = _ui.asStateFlow()

    val activeRoom: Room? get() = room

    /** The prejoin camera, on a room that is not connected yet; join reuses the room. */
    private var previewRoom: Room? = null
    private val _preview = MutableStateFlow<LocalVideoTrack?>(null)
    val preview: StateFlow<LocalVideoTrack?> = _preview.asStateFlow()
    val previewRenderRoom: Room? get() = previewRoom

    /** Which camera the preview and the call open: front or back, as iOS `cameraPosition`. */
    private val _cameraPosition = MutableStateFlow(CameraPosition.FRONT)
    val cameraPosition: StateFlow<CameraPosition> = _cameraPosition.asStateFlow()

    /**
     * Front or back, on the preview track and the call's camera track while
     * they run, and for every camera opened after (the room's capture defaults).
     */
    fun selectCamera(position: CameraPosition) {
        _cameraPosition.value = position
        listOfNotNull(previewRoom, room).forEach { r -> r.videoTrackCaptureDefaults = r.videoTrackCaptureDefaults.copy(position = position) }
        _preview.value?.switchCamera(position = position)
        (room?.localParticipant?.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack)?.switchCamera(position = position)
        if (room != null) log.event("camera_flip")
    }

    /** Call only with the camera permission granted. */
    fun startPreview() {
        if (_preview.value != null || room != null) return
        val r = previewRoom ?: LiveKit.create(context.applicationContext).also { previewRoom = it }
        r.videoTrackCaptureDefaults = r.videoTrackCaptureDefaults.copy(position = _cameraPosition.value)
        val processor = backgroundEffects.makeProcessor(r)
        previewProcessor = processor
        val track = r.localParticipant.createVideoTrack("", r.videoTrackCaptureDefaults, processor)
        track.startCapture()
        _preview.value = track
        applyBackground(processor)
        refreshWorkspaceBackgrounds()
    }

    /** The camera can open once: the preview stops before the call publishes its own. */
    fun stopPreview() {
        _preview.value?.let { it.stopCapture(); it.dispose() }
        _preview.value = null
        backgroundEffects.release(previewProcessor)
        previewProcessor = null
    }

    // Background effects (background/): the processor lives on the camera
    // track, so the preview and the call each get their own, and a choice
    // applies to whichever runs, live, as iOS `applyBackgroundEffect`.
    private val backgroundEffects = BackgroundEffects(context)
    var workspaceBackgrounds = WorkspaceBackgrounds(context)
        private set
    private val customBackground = CustomBackgroundStore(context)

    /**
     * The app moved to [workspace] (no call is live then): the lobby and
     * the workspace's backgrounds are that workspace's from now on.
     */
    fun retarget(workspace: StarlingsWorkspace) {
        api = LobbyApi(workspace.apiOrigin)
        workspaceBackgrounds = WorkspaceBackgrounds(context, workspace.webOrigin)
        _backgroundEffect.value = workspaceBackgrounds.preferredEffect(customBackground.hasImage)
    }
    private var previewProcessor: VirtualBackgroundVideoProcessor? = null
    private var callProcessor: VirtualBackgroundVideoProcessor? = null
    private val _backgroundEffect = MutableStateFlow(workspaceBackgrounds.preferredEffect(customBackground.hasImage))
    /** The effect on the camera now, resolved: never a picture that is gone. */
    val backgroundEffect: StateFlow<BackgroundEffect> = _backgroundEffect.asStateFlow()
    private val _hasCustomBackground = MutableStateFlow(customBackground.hasImage)
    val hasCustomBackground: StateFlow<Boolean> = _hasCustomBackground.asStateFlow()
    /** False when CameraX cannot drive this camera; the menu then is not offered. */
    val backgroundEffectsSupported: Boolean get() = backgroundEffects.supported

    /** Applies live to the preview and the call's camera, and is remembered on this device. */
    fun setBackgroundEffect(effect: BackgroundEffect) {
        val resolved = BackgroundEffect.resolve(effect, customBackground.hasImage, workspaceBackgrounds.image != null)
        _backgroundEffect.value = resolved
        workspaceBackgrounds.remember(effect)
        // The kind only (`generated`, `blur`, …): no picture and no name in the log.
        if (room != null) log.event("background", "effect" to BackgroundEffect.encode(resolved).substringBefore(':'))
        applyBackground(previewProcessor)
        applyBackground(callProcessor)
    }

    /** Keeps the picked image as this device's one picture and puts it behind you. */
    suspend fun useCustomBackground(uri: Uri): Result<Unit> {
        val saved = withContext(Dispatchers.IO) { runCatching { customBackground.save(uri) } }
        if (saved.isSuccess) {
            _hasCustomBackground.value = true
            setBackgroundEffect(BackgroundEffect.CustomImage)
        }
        return saved
    }

    /** Taking the picture away takes the effect with it. */
    fun removeCustomBackground() {
        customBackground.clear()
        _hasCustomBackground.value = false
        if (_backgroundEffect.value == BackgroundEffect.CustomImage) setBackgroundEffect(BackgroundEffect.None)
    }

    private fun applyBackground(processor: VirtualBackgroundVideoProcessor?) {
        processor ?: return
        val effect = _backgroundEffect.value
        scope.launch {
            val plate = withContext(Dispatchers.Default) {
                runCatching { backgroundEffects.plate(effect, workspaceBackgrounds, customBackground) }.getOrNull()
            }
            // A later choice or a stopped track wins over this one.
            if (_backgroundEffect.value != effect || (processor !== previewProcessor && processor !== callProcessor)) return@launch
            backgroundEffects.apply(processor, effect, plate)
        }
    }

    /** iOS refreshes when a camera opens, then takes the preferred effect. */
    private fun refreshWorkspaceBackgrounds() = scope.launch {
        workspaceBackgrounds.refresh()
        _backgroundEffect.value = workspaceBackgrounds.preferredEffect(customBackground.hasImage)
        applyBackground(previewProcessor)
        applyBackground(callProcessor)
    }

    /**
     * Opens the call's camera. The first time in a call the track is made
     * here with its background processor and published; after that the
     * publication exists and LiveKit's own mute and unmute keep it.
     */
    private suspend fun enableCamera(r: Room) {
        if (r.localParticipant.getTrackPublication(Track.Source.CAMERA) != null) {
            r.localParticipant.setCameraEnabled(true)
            return
        }
        val processor = backgroundEffects.makeProcessor(r)
        val track = r.localParticipant.createVideoTrack("", r.videoTrackCaptureDefaults, processor)
        track.startCapture()
        if (r.localParticipant.publishVideoTrack(track)) {
            backgroundEffects.release(callProcessor)
            callProcessor = processor
            applyBackground(processor)
        } else {
            track.stopCapture()
            track.dispose()
            backgroundEffects.release(processor)
        }
    }
    private val _meeting = MutableStateFlow<Meeting?>(null)
    /** Chat, reactions, hands and captions for the call in progress. */
    val meeting: StateFlow<Meeting?> = _meeting.asStateFlow()
    val logFile get() = log.current

    init {
        // A marker left by a call means Android ended the process during it.
        // The audio was never kept, so there is nothing to recover: say so.
        if (prefs.getBoolean(KEY_ACTIVE, false)) {
            prefs.edit().putBoolean(KEY_ACTIVE, false).apply()
            _state.value = CallState.Ended(s(R.string.ended_process_death))
        }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = onForeground()
            override fun onStop(owner: LifecycleOwner) = onBackground()
        })
    }

    // Hosting (host/RoomHost.kt): the media of the owner's own room is this
    // same session, connected with owner credentials instead of a knock.
    private val _hostMedia = MutableStateFlow<HostMediaState>(HostMediaState.Idle)
    override val hostState: StateFlow<HostMediaState> = _hostMedia.asStateFlow()

    /** The room slug and meeting id of the call on screen, for answering a host offer (host/HostTransfer.kt). */
    var activeMeeting: Pair<String, String>? = null
        private set

    /** `host.v1` from the Worker, for the room host. Server-sent only, as iOS. */
    var onHostMessage: ((HostMessageWire) -> Unit)? = null

    /** True while this device is a companion or lost the host: the microphone stays off. */
    private var micLocked = false
    private var hosting = false
    val isHosting: Boolean get() = hosting

    override suspend fun connect(room: String, details: work.starlings.contracts.ConnectionDetails, microphoneAllowed: Boolean) {
        if (this.room != null) return
        hosting = true
        micLocked = !microphoneAllowed
        _hostMedia.value = HostMediaState.Connecting
        try {
            log.begin()
            log.event("host_connect", "companion" to !microphoneAllowed)
            slug = room
            connectedAt = 0L
            _state.value = CallState.Connecting
            val d = ConnectionDetails(details.serverUrl, details.participantToken, details.meetingId, details.artifactToken, details.livekitRoom)
            connect(room, d, mic = microphoneAllowed, camera = false)
            _hostMedia.value = HostMediaState.Live
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            _hostMedia.value = HostMediaState.Failed(e.message ?: s(R.string.error_join))
            end(e.message ?: s(R.string.error_join))
        }
    }

    /** Losing the host mutes and keeps the mic off; gaining it opens the mic only on a handover. */
    override suspend fun setHoldsHost(holds: Boolean, unmute: Boolean) {
        micLocked = !holds
        val local = room?.localParticipant ?: return
        if (!holds) local.setMicrophoneEnabled(false) else if (unmute) local.setMicrophoneEnabled(true)
        log.event("holds_host", "holds" to holds)
        refresh()
    }

    override suspend fun disconnect() = leave()

    /** [member] is a signed-in member's owner token, sent with the knock as iOS `requestJoin(member:)`: an internal room admits only members. */
    fun join(link: RoomLink.Parsed, name: String, email: String, mic: Boolean, camera: Boolean, ownerName: String? = null, member: String? = null) {
        if (job?.isActive == true) return
        this.ownerName = ownerName
        slug = link.slug
        connectedAt = 0L
        job = scope.launch {
            try {
                log.begin()
                log.event("knock")
                _state.value = CallState.Knocking
                val knock = api.knock(link.slug, JoinRequestBody(name, email, link.bookingToken, guestClient()), member)
                if (!awaitAdmission(link.slug, knock)) return@launch
                log.event("admitted")
                _state.value = CallState.Connecting
                val details = exchange(link.slug, knock) ?: return@launch
                connect(link.slug, details, mic, camera)
            } catch (e: ApiError) {
                end(lobbyError(e))
            } catch (e: Exception) {
                if (isActive) end(e.message ?: s(R.string.error_join))
            }
        }
    }

    /** Cancel needs no request: the lobby row expires on the Worker. */
    fun leave() {
        job?.cancel()
        job = null
        end(s(R.string.ended_left), left = true)
    }

    fun reset() {
        if (_state.value is CallState.Ended) _state.value = CallState.Idle
    }

    fun setMic(on: Boolean) = scope.launch {
        // A companion's microphone stays off until this device holds the host.
        if (on && micLocked) return@launch
        room?.localParticipant?.setMicrophoneEnabled(on)
        log.event("mic", "on" to on)
        refresh()
    }

    fun setCamera(on: Boolean) = scope.launch {
        cameraPausedForBackground = false
        room?.let { r -> if (on) enableCamera(r) else r.localParticipant.setCameraEnabled(false) }
        log.event("camera", "on" to on)
        refresh()
    }

    /** `switchCamera`: the other side of the phone, in the preview or the call. */
    fun flipCamera() = selectCamera(if (_cameraPosition.value == CameraPosition.FRONT) CameraPosition.BACK else CameraPosition.FRONT)

    fun selectAudio(device: AudioDevice) {
        (room?.audioHandler as? AudioSwitchHandler)?.selectDevice(device)
        refresh()
    }

    /** The same 600 dp line Android draws between phone and tablet layouts. */
    private fun guestClient(): GuestClient {
        val tablet = context.resources.configuration.smallestScreenWidthDp >= 600
        return GuestClient(app = "android", device = if (tablet) "tablet" else "mobile")
    }

    private suspend fun awaitAdmission(slug: String, knock: Knock): Boolean {
        val pushed = Channel<Unit>(Channel.CONFLATED)
        var pushedStatus: String? = null
        var socketOpen = true
        var socket: WebSocket? = null
        socket = api.socket(
            slug, knock,
            onStatus = { status, count ->
                if (status != null) pushedStatus = status
                if (count != null && _state.value is CallState.Waiting) _state.value = CallState.Waiting(count, ownerName)
                pushed.trySend(Unit)
            },
            onClosed = { socketOpen = false },
        )
        try {
            var status = knock.status
            var count = knock.waitingCount
            while (true) {
                when (status) {
                    "admitted", "joined" -> return true
                    "waiting" -> if (_state.value !is CallState.Waiting) _state.value = CallState.Waiting(count, ownerName)
                    "rejected" -> { end(s(R.string.ended_declined)); return false }
                    "removed" -> { end(s(R.string.ended_removed)); return false }
                    else -> { end(s(R.string.ended_expired)); return false }
                }
                withTimeoutOrNull(if (socketOpen) 15_000L else 5_000L) { pushed.receive() }
                val next = api.status(slug, knock)
                status = pushedStatus?.takeIf { it != "waiting" } ?: next.status
                count = next.waitingCount
            }
        } finally {
            socket?.cancel()
        }
    }

    /** Web retries the exchange from 2 s up to 30 s; 401, 403 and 410 are final. */
    private suspend fun exchange(slug: String, knock: Knock): ConnectionDetails? {
        var backoff = 2_000L
        while (true) {
            try {
                return api.exchange(slug, knock)
            } catch (e: ApiError) {
                if (e.status == 403 || e.status == 410 || e.status == 401) {
                    end(lobbyError(e))
                    return null
                }
                log.event("exchange_retry", "status" to e.status)
            }
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(30_000)
        }
    }

    private suspend fun connect(slug: String, details: ConnectionDetails, mic: Boolean, camera: Boolean) {
        stopPreview()
        val r = previewRoom ?: LiveKit.create(context.applicationContext)
        previewRoom = null
        r.videoTrackCaptureDefaults = r.videoTrackCaptureDefaults.copy(position = _cameraPosition.value)
        room = r
        activeMeeting = details.meetingId?.let { slug to it }
        val m = Meeting(context, r, scope, api, slug, details, log)
        m.start()
        _meeting.value = m
        callJobs += scope.launch { r.events.events.collect(::onRoomEvent) }
        val connectStarted = SystemClock.elapsedRealtime()
        r.connect(details.serverUrl, details.participantToken)
        log.event("connected", "connect_ms" to SystemClock.elapsedRealtime() - connectStarted)
        connectedAt = SystemClock.elapsedRealtime()
        prefs.edit().putBoolean(KEY_ACTIVE, true).apply()
        CallService.start(context)
        _state.value = CallState.InCall
        // Only the person's own prejoin choice opens the mic or camera.
        if (mic) r.localParticipant.setMicrophoneEnabled(true)
        if (camera) {
            enableCamera(r)
            refreshWorkspaceBackgrounds()
        }
        log.event("media", "mic" to mic, "camera" to camera)
        (r.audioHandler as? AudioSwitchHandler)?.apply {
            registerAudioDeviceChangeListener { _, selected ->
                log.event("audio_route", "device" to selected?.let { routeKind(it) })
                refresh()
            }
            registerOnAudioFocusChangeListener(focusListener)
        }
        watchDevice()
        callJobs += scope.launch {
            while (isActive) {
                delay(10_000)
                sample()
            }
        }
        refresh()
    }

    private fun onRoomEvent(event: RoomEvent) {
        when (event) {
            is RoomEvent.Disconnected -> {
                log.event("disconnected", "reason" to event.reason?.name)
                end(disconnectReason(event.reason), left = event.reason == DisconnectReason.CLIENT_INITIATED)
                return
            }
            is RoomEvent.Reconnecting -> {
                log.event("reconnecting")
                _ui.value = _ui.value.copy(reconnecting = true)
                if (hosting) _hostMedia.value = HostMediaState.Reconnecting
            }
            is RoomEvent.Reconnected -> {
                log.event("reconnected")
                _ui.value = _ui.value.copy(reconnecting = false)
                if (hosting) _hostMedia.value = HostMediaState.Live
            }
            is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected ->
                log.event("participants", "remote" to (room?.remoteParticipants?.size ?: 0))
            is RoomEvent.DataReceived -> {
                // Server-sent only: a packet with a sender is a participant forging the topic.
                if (event.topic == Contracts.HOST_TOPIC) {
                    if (event.participant == null) {
                        runCatching { WireJson.decodeFromString(HostMessageWire.serializer(), event.data.decodeToString()) }
                            .getOrNull()?.takeIf { it.version == 1L }?.let { onHostMessage?.invoke(it) }
                    }
                    return
                }
                _meeting.value?.onData(event.topic, event.data, event.participant)
                return
            }
            is RoomEvent.ConnectionQualityChanged ->
                if (event.participant == room?.localParticipant) log.event("quality", "local" to event.quality.name)
            else -> Unit
        }
        refresh()
    }

    private fun onAudioFocus(change: Int) {
        val taken = change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
        log.event(if (taken) "audio_focus_lost" else "audio_focus", "change" to change)
        _ui.value = _ui.value.copy(audioTaken = taken)
        // Another app holds the audio: a host's lease lapses like any other's.
        if (hosting && _state.value == CallState.InCall) _hostMedia.value = if (taken) HostMediaState.Interrupted else HostMediaState.Live
    }

    /** iOS pauses the camera in the background; Android does the same and resumes it. */
    private fun onBackground() {
        backgroundSince = SystemClock.elapsedRealtime()
        stopPreview()
        val r = room ?: return
        log.event("background")
        if (r.localParticipant.isCameraEnabled) {
            cameraPausedForBackground = true
            scope.launch { r.localParticipant.setCameraEnabled(false); refresh() }
        }
    }

    private fun onForeground() {
        if (backgroundSince != 0L && room != null) log.backgroundFor(SystemClock.elapsedRealtime() - backgroundSince)
        backgroundSince = 0L
        val r = room ?: return
        log.event("foreground")
        if (cameraPausedForBackground) {
            cameraPausedForBackground = false
            scope.launch { r.localParticipant.setCameraEnabled(true); refresh() }
        }
    }

    private fun watchDevice() {
        val screen = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                log.event(if (intent.action == Intent.ACTION_SCREEN_OFF) "screen_off" else "screen_on")
            }
        }
        context.registerReceiver(screen, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        })
        receivers += screen
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = log.event("network_available")
            override fun onLost(network: Network) = log.event("network_lost")
        }
        cm.registerDefaultNetworkCallback(callback)
        networkCallback = callback
    }

    private fun unwatchDevice() {
        receivers.forEach { runCatching { context.unregisterReceiver(it) } }
        receivers.clear()
        networkCallback?.let { cb ->
            runCatching { context.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(cb) }
        }
        networkCallback = null
    }

    private fun sample() {
        val r = room ?: return
        val ui = _ui.value
        log.sample(
            participants = r.remoteParticipants.size + 1,
            audio = probe.read(),
            extra = arrayOf(
                "mic" to ui.micOn,
                "camera" to ui.cameraOn,
                "route" to ui.audioDevice?.let { routeKind(it) },
                "reconnecting" to ui.reconnecting,
                "audio_taken" to ui.audioTaken,
                "background" to (backgroundSince != 0L),
                "quality" to r.localParticipant.connectionQuality.name,
            ),
        )
    }

    private fun refresh() {
        val r = room ?: return
        val local = r.localParticipant
        syncProbe(r)
        val tiles = buildList {
            add(tile(local, isLocal = true))
            r.remoteParticipants.values.forEach { p ->
                add(tile(p, isLocal = false))
                screenShare(p)?.let { share ->
                    add(Tile("${p.identity}:screen", s(R.string.screen_of, p.name ?: s(R.string.guest)), p.name.orEmpty(), false, false, share, true))
                }
            }
        }
        val audio = r.audioHandler as? AudioSwitchHandler
        val m = _meeting.value
        val withHands = if (m == null) tiles else tiles.map { t ->
            val p = if (t.isLocal) local else r.remoteParticipants.values.firstOrNull { it.identity?.value == t.key }
            if (p == null || t.screenShare) t else t.copy(
                handRaisedAt = m.handRaisedAt(p),
                host = m.isHost(p),
                facts = ParticipantClient.facts(p.metadata),
            )
        }
        _ui.value = _ui.value.copy(
            tiles = withHands,
            handRaised = withHands.firstOrNull { it.isLocal }?.handRaisedAt != null,
            micOn = local.isMicrophoneEnabled,
            cameraOn = local.isCameraEnabled,
            audioDevices = audio?.availableAudioDevices.orEmpty(),
            audioDevice = audio?.selectedAudioDevice,
        )
    }

    /** One probe tap per microphone track that exists now, local and remote. */
    private fun syncProbe(r: Room) {
        val live = mutableSetOf<String>()
        fun tap(p: Participant, local: Boolean) {
            p.audioTrackPublications.forEach { (publication, track) ->
                val audio = track as? AudioTrack ?: return@forEach
                live += publication.sid
                probe.attach(publication.sid, audio, local)
            }
        }
        tap(r.localParticipant, true)
        r.remoteParticipants.values.forEach { tap(it, false) }
        probe.detachExcept(live)
    }

    private fun tile(p: Participant, isLocal: Boolean): Tile {
        val camera = p.getTrackPublication(Track.Source.CAMERA)
        val video = camera?.takeIf { !it.muted }?.track as? VideoTrack
        val label = if (isLocal) s(R.string.you) else p.name?.ifBlank { null } ?: s(R.string.guest)
        return Tile(
            p.identity?.value ?: label, label, p.name.orEmpty(), isLocal, p.isSpeaking, video, false,
            quality = CallQuality.from(p.connectionQuality.name),
        )
    }

    private fun screenShare(p: Participant): VideoTrack? =
        p.getTrackPublication(Track.Source.SCREEN_SHARE)?.takeIf { !it.muted }?.track as? VideoTrack

    private fun end(reason: String, left: Boolean = false) {
        val wasActive = _state.value !is CallState.Ended && _state.value !is CallState.Idle
        val wasInCall = _state.value == CallState.InCall
        if (room != null) sample()
        callJobs.forEach { it.cancel() }
        callJobs.clear()
        (room?.audioHandler as? AudioSwitchHandler)?.unregisterOnAudioFocusChangeListener(focusListener)
        probe.detachAll()
        _meeting.value?.stop()
        _meeting.value = null
        unwatchDevice()
        room?.disconnect()
        room?.release()
        room = null
        backgroundEffects.release(callProcessor)
        callProcessor = null
        activeMeeting = null
        cameraPausedForBackground = false
        prefs.edit().putBoolean(KEY_ACTIVE, false).apply()
        CallService.stop(context)
        _ui.value = CallUi()
        if (hosting) _hostMedia.value = HostMediaState.Ended
        hosting = false
        micLocked = false
        val connectedMs = connectedAt.takeIf { it != 0L }?.let { SystemClock.elapsedRealtime() - it }
        connectedAt = 0L
        if (wasActive) _state.value = CallState.Ended(reason, log.end(reason), slug, connectedMs, left = left, failure = !left && !wasInCall)
    }

    /** The kind of route only: a Bluetooth device's name stays off the record. */
    private fun routeKind(device: AudioDevice): String = when (device) {
        is AudioDevice.BluetoothHeadset -> "bluetooth"
        is AudioDevice.WiredHeadset -> "wired"
        is AudioDevice.Earpiece -> "earpiece"
        is AudioDevice.Speakerphone -> "speaker"
        else -> "other"
    }

    private fun lobbyError(e: ApiError): String = when (e.code) {
        "meeting_ended" -> s(R.string.ended_meeting)
        "guest_removed" -> s(R.string.ended_removed)
        "guest_not_admitted" -> s(R.string.error_not_admitted)
        "rate_limited" -> s(R.string.error_host_unavailable)
        "lobby_credentials_invalid" -> s(R.string.ended_expired)
        else -> if (e.status == 404) s(R.string.error_no_room) else e.message ?: s(R.string.error_join)
    }

    private fun disconnectReason(reason: DisconnectReason?): String = when (reason) {
        DisconnectReason.ROOM_DELETED, DisconnectReason.ROOM_CLOSED -> s(R.string.ended_meeting)
        DisconnectReason.PARTICIPANT_REMOVED -> s(R.string.ended_removed)
        DisconnectReason.CLIENT_INITIATED -> s(R.string.ended_left)
        DisconnectReason.DUPLICATE_IDENTITY -> s(R.string.ended_other_device)
        else -> s(R.string.ended_disconnected)
    }

    private fun s(id: Int, vararg args: Any): String = context.getString(id, *args)

    private companion object {
        const val KEY_ACTIVE = "active"
    }
}
