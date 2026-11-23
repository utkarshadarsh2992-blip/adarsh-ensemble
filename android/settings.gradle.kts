pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
        maven("https://chaquo.com/maven")
    }
    plugins {
        id("com.android.application") version "8.7.3"
        id("org.jetbrains.kotlin.android") version "2.0.21"
        id("com.chaquo.python") version "16.1.0"
        id("com.google.protobuf") version "0.9.4"
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven("https://chaquo.com/maven")
    }
}
rootProject.name = "adarsh-ensemble-android"
include(":app")
