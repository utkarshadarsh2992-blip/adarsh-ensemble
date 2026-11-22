
import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

val repoRoot = rootDir.parentFile
val engineDir = layout.buildDirectory.dir("generated/engine")
val uiDir = layout.buildDirectory.dir("generated/ui")

// Fixed signing key. Either adarsh-debug.keystore is uploaded as a file, or its base64 text is pasted into
// adarsh-debug.keystore.b64 (easy from a phone) and decoded here before signing.
val ksFile = file("adarsh-debug.keystore")
val ksB64 = file("adarsh-debug.keystore.b64")
if (!ksFile.exists() && ksB64.exists()) {
    ksFile.writeBytes(Base64.getMimeDecoder().decode(ksB64.readText().trim()))
}

android {
    namespace = "app.adarsh.ensemble"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.adarsh.ensemble"
        minSdk = 26
        targetSdk = 34

        // GitHub run number
        versionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionName = "1.0.0"

        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    signingConfigs {
        getByName("debug") {
            storeFile = file("adarsh-debug.keystore")
            storePassword = "adarsh123456"
            keyAlias = "adarsh"
            keyPassword = "adarsh123456"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets["main"].assets.srcDir(uiDir)
}

chaquopy {
    defaultConfig {
        version = "3.12"

        pip {
            install("httpx>=0.27")
            install("python-dotenv>=1.0")
        }
    }

    sourceSets {
        getByName("main") {
            srcDir(engineDir)
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}

val syncEngine = tasks.register<Copy>("syncEngine") {
    from(repoRoot) {
        include("*.py")
        exclude("main.py")
    }
    into(engineDir)
}

val syncUi = tasks.register<Copy>("syncUi") {
    from(File(repoRoot, "ui/dist/adarsh.html")) {
        rename { "index.html" }
    }
    into(uiDir)

    doFirst {
        if (!File(repoRoot, "ui/dist/adarsh.html").exists()) {
            throw GradleException(
                "ui/dist/adarsh.html missing. Run: python3 ui/build.py"
            )
        }
    }
}

tasks.named("preBuild") {
    dependsOn(syncEngine, syncUi)
}

tasks.matching {
    it.name.endsWith("PythonSources")
}.configureEach {
    dependsOn(syncEngine)
}

tasks.matching {
    it.name.startsWith("merge") && it.name.endsWith("Assets")
}.configureEach {
    dependsOn(syncUi)
}
