import com.android.build.api.variant.FilterConfiguration
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeCompiler)
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_11
    }
}

dependencies {
    implementation(project(":shared"))

    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.core.ktx)

    implementation(libs.koin.android)
    implementation(libs.koin.compose)
    implementation(libs.koin.compose.viewmodel)

    implementation(libs.compose.uiToolingPreview)
    debugImplementation(libs.compose.uiTooling)
}

fun propOrEnv(name: String): String? =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }
        ?: System.getenv(name)?.takeIf { it.isNotBlank() }

val releaseStoreFile = propOrEnv("OPENSHIP_STORE_FILE")
val releaseStorePassword = propOrEnv("OPENSHIP_STORE_PASSWORD")
val releaseKeyAlias = propOrEnv("OPENSHIP_KEY_ALIAS")
val releaseKeyPassword = propOrEnv("OPENSHIP_KEY_PASSWORD")
val hasReleaseSigning =
    releaseStoreFile != null &&
        releaseStorePassword != null &&
        releaseKeyAlias != null &&
        releaseKeyPassword != null

android {
    namespace = "com.kareemessam.openship"
    compileSdk = libs.versions.android.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.kareemessam.openship"
        minSdk = libs.versions.android.minSdk.get().toInt()
        targetSdk = libs.versions.android.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.2.0"
    }

    if (hasReleaseSigning) {
        signingConfigs {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "/META-INF/LICENSE*",
                "/META-INF/NOTICE*",
                "/META-INF/DEPENDENCIES",
                "/META-INF/*.kotlin_module",
                "/META-INF/*.version",
                "/META-INF/INDEX.LIST",
                "DebugProbesKt.bin",
                "kotlin-tooling-metadata.json",
            )
        }
        jniLibs {
            useLegacyPackaging = false
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            isDebuggable = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    // Per-ABI APKs for sideload / GitHub releases
    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
            isUniversalApk = false
        }
    }

    bundle {
        abi { enableSplit = true }
        language { enableSplit = true }
        density { enableSplit = true }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

// versionCode = base*10 + abi so multi-APK installs upgrade cleanly
val abiVersionCodes = mapOf(
    "armeabi-v7a" to 1,
    "arm64-v8a" to 2,
    "x86" to 3,
    "x86_64" to 4,
)
val baseVersionCode = 1

androidComponents {
    onVariants(selector().all()) { variant ->
        variant.outputs.forEach { output ->
            val abi = output.filters
                .find { it.filterType == FilterConfiguration.FilterType.ABI }
                ?.identifier
            val abiCode = abiVersionCodes[abi] ?: 0
            output.versionCode.set(baseVersionCode * 10 + abiCode)
        }
    }
}

tasks.register("reverseAdbPorts") {
    doLast {
        try {
            ProcessBuilder("adb", "reverse", "tcp:4000", "tcp:4000").start().waitFor()
            ProcessBuilder("adb", "reverse", "tcp:20000", "tcp:20000").start().waitFor()
        } catch (_: Exception) {
        }
    }
}

tasks.matching { it.name.startsWith("install") || it.name.startsWith("connected") }.configureEach {
    finalizedBy("reverseAdbPorts")
}
