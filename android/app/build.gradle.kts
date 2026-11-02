import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
}

// Die Versionsnummer steht nur in der package.json im Hauptordner
val appVersion = findProperty("appVersion") as String? ?: (JsonSlurper().parse(rootDir.resolve("../package.json")) as Map<*, *>)["version"] as String
val versionParts = appVersion.split(".").map { it.toInt() }

android {
    namespace = "com.basaltnotes.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.basaltnotes.app"
        minSdk = 29
        targetSdk = 36
        versionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]
        versionName = appVersion
        // Woher Updates kommen (zum Testen per -P überschreibbar)
        val updateApi = findProperty("updateApi") as String? ?: "https://api.github.com/repos/Poldion/BasaltNotes/releases/latest"
        val updatePrefix = findProperty("updatePrefix") as String? ?: "https://github.com/Poldion/BasaltNotes/releases/download/"
        buildConfigField("String", "UPDATE_API", "\"$updateApi\"")
        buildConfigField("String", "UPDATE_DOWNLOAD_PREFIX", "\"$updatePrefix\"")
    }

    // Signieren nur, wenn ein Schlüssel angegeben ist (BASALT_KEYSTORE, BASALT_KEYSTORE_PASSWORD, BASALT_KEY_ALIAS, BASALT_KEY_PASSWORD)
    val keystore = System.getenv("BASALT_KEYSTORE")
    val release = if (keystore != null) signingConfigs.create("release") {
        storeFile = file(keystore)
        storePassword = System.getenv("BASALT_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("BASALT_KEY_ALIAS")
        keyPassword = System.getenv("BASALT_KEY_PASSWORD")
    } else null

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = release
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
