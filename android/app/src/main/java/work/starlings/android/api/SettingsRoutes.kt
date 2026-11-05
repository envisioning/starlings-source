package work.starlings.android.api

import work.starlings.contracts.DeviceRevokeRequest
import work.starlings.contracts.HomeModuleSettingWire
import work.starlings.contracts.HomePreferencesResponse
import work.starlings.contracts.HomePreferencesUpdate
import work.starlings.contracts.InterfaceLanguage
import work.starlings.contracts.LanguagePreferenceResponse
import work.starlings.contracts.LanguagePreferenceUpdate
import work.starlings.contracts.OwnerDevicesResponse
import work.starlings.contracts.OwnerRoomResponse
import work.starlings.contracts.SetupResponse

/**
 * Home's layout, the setup steps, the language and the signed-in devices,
 * as `Sources/StarlingsSettingsRoutes.swift`, and the owner's room card, as
 * `StarlingsRoomRoutes.ownerRoom`. The sign-in and renewal routes stay in
 * `OwnerApi` (OwnerSignIn.kt): they carry no bearer.
 */
object SettingsRoutes {
    /** What Home is made of, for this owner (`fixtures/home-layout.json`). */
    val homeLayout = Route(
        "GET", listOf("home", "preferences"), answer = Answer.Wire(HomePreferencesResponse.serializer()),
        operation = "Couldn’t read your Home layout",
    )

    fun setHomeLayout(modules: List<HomeModuleSettingWire>): Route<HomePreferencesResponse> = Route(
        "PUT", listOf("home", "preferences"), body = json(HomePreferencesUpdate.serializer(), HomePreferencesUpdate(modules)),
        answer = Answer.Wire(HomePreferencesResponse.serializer()), operation = "Couldn’t save your Home layout",
    )

    /** Home's room card; it paints on a cold start from the last answer. */
    val ownerRoom = Route(
        "GET", listOf("owner", "room"), answer = Answer.Wire(OwnerRoomResponse.serializer()),
        operation = "Couldn’t load your room", snapshotKey = SnapshotKey.OWNER_ROOM,
    )

    /** This owner's setup steps, each done when the thing exists (docs/ONBOARDING.md). */
    val setup = Route(
        "GET", listOf("setup"), answer = Answer.Wire(SetupResponse.serializer()),
        operation = "Couldn’t load your setup steps",
    )

    /** The language the interface is drawn in, for this owner. */
    val language = Route(
        "GET", listOf("profile", "language"), answer = Answer.Wire(LanguagePreferenceResponse.serializer()),
        operation = "Couldn’t read your language",
    )

    /** Null follows the device. */
    fun setLanguage(language: InterfaceLanguage?): Route<LanguagePreferenceResponse> = Route(
        "PUT", listOf("profile", "language"), body = json(LanguagePreferenceUpdate.serializer(), LanguagePreferenceUpdate(language)),
        answer = Answer.Wire(LanguagePreferenceResponse.serializer()), operation = "Couldn’t save your language",
    )

    /** The person's signed-in Macs and phones, this one marked (docs/ADMIN.md §5a). */
    val devices = Route(
        "GET", listOf("auth", "devices"), answer = Answer.Wire(OwnerDevicesResponse.serializer()),
        operation = "Couldn’t load devices",
    )

    /** Sign one device out; its tokens are refused from its next request. Answers the devices that remain. */
    fun revokeDevice(deviceId: String): Route<OwnerDevicesResponse> = Route(
        "POST", listOf("auth", "devices", "revoke"), body = json(DeviceRevokeRequest.serializer(), DeviceRevokeRequest(deviceId)),
        answer = Answer.Wire(OwnerDevicesResponse.serializer()), operation = "Couldn’t sign that device out",
    )
}
