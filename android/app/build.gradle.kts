plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

val repoRoot = rootDir.parentFile
val engineDir = layout.buildDirectory.dir("generated/engine")
val uiDir = layout.buildDirectory.dir("generated/ui")

android {
    namespace = "app.adarsh.ensemble"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.adarsh.ensemble"
        minSdk = 26
        targetSdk = 34
        // GitHub run number: goes up with every CI build, so a new APK installs as an update over the old one
        versionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionName = "1.0.0"

        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    // Fixed signing key. Without it every CI run signs the debug APK with a brand-new random key, Android refuses
    // to update the installed app, you must uninstall it, and the saved API keys are deleted with it.
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

// Engine: existing Python files, unchanged, excluding FastAPI server.
val syncEngine = tasks.register<Copy>("syncEngine") {
    from(repoRoot) {
        include("*.py")
        exclude("main.py")
    }
    into(engineDir)
}

// Frontend: single-file page produced by ui/build.py.
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
