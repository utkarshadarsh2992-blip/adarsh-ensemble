plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

val repoRoot = rootDir.parentFile                       // the Python engine lives here
val engineDir = layout.buildDirectory.dir("generated/engine")
val uiDir = layout.buildDirectory.dir("generated/ui")

android {
    namespace = "app.adarsh.ensemble"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.adarsh.ensemble"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].assets.srcDir(uiDir)
}

chaquopy {
    defaultConfig {
        version = "3.12"          // build machine must have python3.12 on PATH (CI does)
        pip {
            install("httpx>=0.27")
            install("python-dotenv>=1.0")
        }
    }
    sourceSets {
        getByName("main") { srcDir(engineDir) }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}

// Engine: the existing Python files, unchanged, minus the FastAPI server (not used on Android).
val syncEngine = tasks.register<Copy>("syncEngine") {
    from(repoRoot) {
        include("*.py")
        exclude("main.py")
    }
    into(engineDir)
}
// Frontend: the single-file page produced by `python3 ui/build.py`.
val syncUi = tasks.register<Copy>("syncUi") {
    from(File(repoRoot, "ui/dist/adarsh.html")) { rename { "index.html" } }
    into(uiDir)
    doFirst {
        if (!File(repoRoot, "ui/dist/adarsh.html").exists())
            throw GradleException("ui/dist/adarsh.html missing. Run: python3 ui/build.py")
    }
}
tasks.named("preBuild") { dependsOn(syncEngine, syncUi) }
tasks.matching { it.name.endsWith("PythonSources") }.configureEach { dependsOn(syncEngine) }
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(syncUi) }
