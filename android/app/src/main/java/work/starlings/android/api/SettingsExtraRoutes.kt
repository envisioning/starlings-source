package work.starlings.android.api

import work.starlings.contracts.RoomSettings
import work.starlings.contracts.RoomSettingsUpdate

/**
 * The routes Settings sends that `SettingsRoutes` and `HostRoutes` do not:
 * the room policy write, as `StarlingsRoomRoutes.updateRoomSettings`.
 */
object SettingsExtraRoutes {
    fun updateRoomSettings(room: String, refuseRecorders: Boolean): Route<RoomSettings> = Route(
        "PATCH", listOf("rooms", room, "settings"),
        body = json(RoomSettingsUpdate.serializer(), RoomSettingsUpdate(refuseRecorders)),
        answer = Answer.Wire(RoomSettings.serializer()), operation = "Couldn’t update room settings",
    )
}
