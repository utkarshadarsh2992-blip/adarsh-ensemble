
import java.net.URI
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
    id("com.google.protobuf")
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

        // GitHub run number; release metadata and the APK must agree exactly.
        val ciRun = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionCode = ciRun
        versionName = "1.0.$ciRun"

        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
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
            install("httpx==0.28.1")
            install("python-dotenv==1.2.4")
        }
    }

    sourceSets {
        getByName("main") {
            srcDir(engineDir)
        }
    }
}

protobuf {
    protoc { artifact = "com.google.protobuf:protoc:3.25.5" }
    plugins {
        create("grpc") { artifact = "io.grpc:protoc-gen-grpc-java:1.67.1" }
    }
    generateProtoTasks {
        all().configureEach {
            builtins { create("java") { option("lite") } }
            plugins { create("grpc") { option("lite") } }
        }
    }
}

// Offline neural voice runtime (sherpa-onnx, static onnxruntime; arm64 + x86_64 used). Downloaded once, not kept in git.
val sherpaVersion = "1.12.40"
val sherpaAar = file("libs/sherpa-onnx-$sherpaVersion.aar")
val sherpaSha256 = "f6c225258b8528ab7537ff92fbb452df4c68d31632c19f45c8ddb9b56eea238d"
fun sha256File(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
if (!sherpaAar.exists() || sherpaAar.length() < 1_000_000 || sha256File(sherpaAar) != sherpaSha256) {
    if (sherpaAar.exists()) sherpaAar.delete()
    sherpaAar.parentFile.mkdirs()
    val tmp = File(sherpaAar.path + ".part")
    val url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$sherpaVersion/sherpa-onnx-static-link-onnxruntime-$sherpaVersion.aar"
    URI(url).toURL().openStream().use { i -> tmp.outputStream().use { o -> i.copyTo(o) } }
    if (!tmp.renameTo(sherpaAar)) throw GradleException("Could not install downloaded sherpa-onnx AAR")
}
if (sha256File(sherpaAar) != sherpaSha256) {
    sherpaAar.delete()
    throw GradleException("sherpa-onnx AAR SHA-256 mismatch")
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation(files(sherpaAar))
    implementation("io.grpc:grpc-okhttp:1.67.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")   // Adarsh Live WebSocket
    implementation("io.grpc:grpc-protobuf-lite:1.67.1")
    implementation("io.grpc:grpc-stub:1.67.1")
    implementation("com.google.protobuf:protobuf-javalite:3.25.5")
    compileOnly("javax.annotation:javax.annotation-api:1.3.2")
    implementation("org.apache.commons:commons-compress:1.26.2")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}

val syncEngine = tasks.register<Copy>("syncEngine") {
    from(repoRoot) {
        include("*.py")
        include("voice_v6/**/*.py")   // V6 voice layer (package)
        include("actions/**/*.py")    // Standard-mode action parser (local rules, no model)
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
