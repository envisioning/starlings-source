// The commit the APK was built from, for the call log's device line.
val gitCommit = providers.exec {
    commandLine("git", "rev-parse", "--short", "HEAD")
    isIgnoreExitValue = true
}.standardOutput.asText.map { it.trim().ifEmpty { "unknown" } }

// The version is the Apple apps' (scripts/version-env.sh): the name is
// VERSION, the code is `git rev-list --count HEAD`, so one commit is the same
// version and build on every platform. scripts/android-release.sh refuses a
// shallow clone, whose count is wrong.
val appVersion = rootProject.file("../VERSION").readText().trim()
val appBuild = providers.exec {
    commandLine("git", "rev-list", "--count", "HEAD")
    isIgnoreExitValue = true
}.standardOutput.asText.map { it.trim().toIntOrNull()?.coerceAtLeast(1) ?: 1 }

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "work.starlings.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "work.starlings.android"
        // Pilot floor from docs/ANDROID_PORT_PLAN.md §1: ARM64, Android 12+.
        minSdk = 31
        targetSdk = 36
        versionCode = appBuild.get()
        versionName = appVersion
        ndk { abiFilters += listOf("arm64-v8a") }
        buildConfigField("String", "ORIGIN", "\"https://envisioning.starlings.example\"")
        buildConfigField("String", "GIT_COMMIT", "\"${gitCommit.get()}\"")
    }

    // The release key stays on the build host (scripts/android-release-key.sh);
    // scripts/android-release.sh hands its path and password to this build
    // through the environment. Without them a release build is unsigned.
    val releaseStore = System.getenv("STARLINGS_RELEASE_STORE")
    signingConfigs {
        if (releaseStore != null) {
            create("release") {
                storeFile = file(releaseStore)
                storePassword = System.getenv("STARLINGS_RELEASE_PASSWORD")
                keyAlias = "starlings"
                keyPassword = System.getenv("STARLINGS_RELEASE_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (releaseStore != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    // English and pt-BR, the product languages; Android 13+ lists them under
    // the app's own language setting.
    androidResources {
        generateLocaleConfig = true
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        // The shared rule fixtures the Swift and web suites read too.
        unitTests.all {
            it.systemProperty("starlings.fixtures", rootProject.file("../fixtures").absolutePath)
            it.systemProperty("starlings.contracts", rootProject.file("../packages/contracts/src").absolutePath)
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    // Large screens (ui/SizeClass.kt): the window's width and height class, read again on every resize,
    // rotation and multi-window change; the counterpart of iOS horizontalSizeClass. Version from the BOM.
    implementation(libs.androidx.compose.material3.windowsizeclass)
    // Semantic icons (docs/DESIGN.md, Iconography law): the Android counterpart of SF Symbols.
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    // Custom Tabs for the workspace web sign-in (OwnerSignIn.kt); already in the mini's Gradle cache.
    implementation(libs.androidx.browser)
    implementation(libs.livekit.android)
    // Background blur and pictures in calls, as iOS (VirtualBackgroundVideoProcessor, on-device ML Kit segmentation).
    implementation(libs.livekit.android.track.processors)
    // The processor reads the camera through CameraX; the track-processors module ships it at runtime only.
    implementation(libs.livekit.android.camerax)
    // Home-screen widgets (widgets/), the iOS WidgetKit extension's counterpart: Glance draws them,
    // WorkManager redraws them at each moment the answer changes (WidgetKit's timeline has no Android twin).
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.work.runtime.ktx)
    // Google Calendar connect (workspace/calendar/GoogleCalendarConnect.kt): Play services'
    // AuthorizationClient hands back a serverAuthCode for an Android OAuth client, which has no redirect.
    implementation(libs.play.services.auth)
    // Keep's QR scan for one-time codes (keep/ui/KeepQRScanner.kt), as iOS VisionKit: CameraX for the
    // preview and frames (the version LiveKit's CameraX module already brings), ZXing core to read the
    // code on the device, from a frame or a photo. ML Kit's barcode model is not in the build cache.
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.zxing.core)
    // Keep's passkey unlock (keep/KeepPasskey.kt), as iOS AuthenticationServices: Credential Manager runs the
    // WebAuthn ceremony with the PRF extension; the Play services module answers it below Android 14.
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services.auth)
    testImplementation(libs.junit)
}
