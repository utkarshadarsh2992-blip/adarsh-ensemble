package app.adarsh.ensemble

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * The only door between the page and the engine. Exposed to JS as `AdarshNative`.
 *
 * M1 (audit): addJavascriptInterface is visible to every frame of the WebView, so every method first checks
 * that the top document is the bundled page (MainActivity.pageTrusted). The page itself sets CSP
 * `frame-src 'none'`, and MainActivity never navigates the main frame away from appassets.androidplatform.net.
 */
class AdarshBridge(
    private val keys: SecureKeys,
    private val progress: (String, String) -> Unit,
    private val deliver: (String, String?, String?) -> Unit
) {
    private fun ok(): Boolean = MainActivity.pageTrusted()
    private val denied = """{"ok":false,"error":"Untrusted page"}"""

    @JavascriptInterface
    fun send(id: String, requestJson: String) {
        if (!ok()) { deliver(id, null, "Untrusted page"); return }
        Engine.submit(id, requestJson, { msg -> progress(id, msg) }) { result, error -> deliver(id, result, error) }
    }

    /** Same as send, but no "working" notification / foreground service: short jobs like the natural voice. */
    @JavascriptInterface
    fun sendQuiet(id: String, requestJson: String) {
        if (!ok()) { deliver(id, null, "Untrusted page"); return }
        Engine.submit(id, requestJson, { msg -> progress(id, msg) }, foreground = false) { result, error -> deliver(id, result, error) }
    }
    @JavascriptInterface
    fun cancel(id: String) { if (ok()) Engine.cancel(id) }
    /** Startup animation (07-splash.js): dark system bars while it is on screen, the normal ones after it. */
    @JavascriptInterface
    fun bootBars(dark: Boolean) { if (ok()) MainActivity.bootBars(dark) }

    @JavascriptInterface
    fun updateStatus(): String = if (ok()) MainActivity.updateStatus() else denied
    /** Installed build ("1.0.123 (123)"), so Settings can show which APK is running. */
    @JavascriptInterface
    fun appVersion(): String = if (ok()) MainActivity.appVersion() else ""
    @JavascriptInterface
    fun updateCheck(force: Boolean): String = if (ok()) MainActivity.updateCheck(force) else denied
    @JavascriptInterface
    fun updateNotify(value: String): String = if (ok()) MainActivity.updateNotify(value) else denied
    @JavascriptInterface
    fun launchTarget(): String = if (ok()) MainActivity.launchTarget() else ""
    @JavascriptInterface
    fun updateDownload(): String = if (ok()) MainActivity.updateDownload() else denied
    @JavascriptInterface
    fun updateInstall(): String = if (ok()) MainActivity.updateInstall() else denied
    @JavascriptInterface
    fun backgroundVoiceStatus(): String = if (ok()) MainActivity.backgroundVoiceStatus() else denied

    /** On-device Hey Adarsh switch/status; payloads contain no keys and no recognized transcript. */
    @JavascriptInterface
    fun wakeWordSet(enabled: Boolean): String = if (ok()) MainActivity.wakeWordSet(enabled) else denied
    @JavascriptInterface
    fun wakeWordStatus(): String = if (ok()) MainActivity.wakeWordStatus() else denied
    @JavascriptInterface
    fun wakeWordPause(reason: String): String = if (ok()) MainActivity.wakeWordPause(reason) else denied
    @JavascriptInterface
    fun wakeWordResume(reason: String): String = if (ok()) MainActivity.wakeWordResume(reason) else denied

    // Adarsh Live: the same Gemini key stays on the phone; only the page's UI talks to these.
    @JavascriptInterface
    fun liveStatus(): String = if (ok()) MainActivity.liveStatus() else denied
    @JavascriptInterface
    fun liveStart(config: String): String = if (ok()) MainActivity.liveStart(config) else denied
    @JavascriptInterface
    fun liveProbe(): String = if (ok()) MainActivity.liveProbe() else denied
    @JavascriptInterface
    fun liveSwitch(role: String): String = if (ok()) MainActivity.liveSwitch(role) else denied
    @JavascriptInterface
    fun liveSendText(text: String): String = if (ok()) MainActivity.liveSendText(text) else denied
    @JavascriptInterface
    fun savePdf(name: String, base64: String): String = if (ok()) MainActivity.savePdf(name, base64) else denied
    /** Source links leave the bundled WebView only through a validated Android ACTION_VIEW intent. */
    @JavascriptInterface
    fun openExternal(url: String): Boolean = ok() && MainActivity.openExternal(url)
    @JavascriptInterface
    fun liveStop(): String = if (ok()) MainActivity.liveStop() else denied
    @JavascriptInterface
    fun backgroundVoiceStart(config: String): String = if (ok()) MainActivity.backgroundVoiceStart(config) else denied
    @JavascriptInterface
    fun backgroundVoiceStop(): String = if (ok()) MainActivity.backgroundVoiceStop() else denied
    /** Live voice open in Standard mode: config for continuing outside the app on Back/Home; blank disarms. */
    @JavascriptInterface
    fun backgroundVoiceArm(config: String): String = if (ok()) MainActivity.backgroundVoiceArm(config) else denied
    @JavascriptInterface
    fun backgroundVoicePeek(): String = if (ok()) MainActivity.backgroundVoicePeek() else denied
    @JavascriptInterface
    fun backgroundVoiceAck(ids: String): String = if (ok()) MainActivity.backgroundVoiceAck(ids) else denied

    // Speech out: the WebView has no speechSynthesis. Events come back via window.__adarshTts(type, id).
    @JavascriptInterface
    fun ttsAvailable(): Boolean = ok() && MainActivity.ttsAvailable()
    @JavascriptInterface
    fun ttsSpeak(id: String, text: String, lang: String, rate: Float) { if (ok()) MainActivity.ttsSpeak(id, text, lang, rate) }
    @JavascriptInterface
    fun ttsPlayFile(id: String, path: String, rate: Float) { if (ok()) MainActivity.ttsPlayFile(id, path, rate) }
    @JavascriptInterface
    fun ttsStop() { if (ok()) MainActivity.ttsStop() }
    /** Phone voices (JSON) and the one the user picked; blank means pick automatically. */
    @JavascriptInterface
    fun ttsVoices(): String = if (ok()) MainActivity.ttsVoices() else "[]"
    @JavascriptInterface
    fun ttsSetVoice(name: String) { if (ok()) MainActivity.ttsSetVoice(name) }

    // V6 offline neural voice (Piper via sherpa-onnx): fallback below the natural voice, above the phone voice.
    @JavascriptInterface
    fun neuralReady(): Boolean = ok() && MainActivity.neuralReady()
    @JavascriptInterface
    fun neuralStatus(): String = if (ok()) MainActivity.neuralStatus() else denied
    @JavascriptInterface
    fun neuralInstall() { if (ok()) MainActivity.neuralInstall() }
    @JavascriptInterface
    fun neuralSpeak(id: String, text: String, lang: String, rate: Float) { if (ok()) MainActivity.neuralSpeak(id, text, lang, rate) }
    @JavascriptInterface
    fun neuralPause() { if (ok()) MainActivity.neuralPause() }
    @JavascriptInterface
    fun neuralResume() { if (ok()) MainActivity.neuralResume() }

    // Standard-mode actions (reminders, notes, apps, status...). Executed natively; never by a model.
    // Calls and message drafts additionally need a native confirmation dialog (audit H5).
    @JavascriptInterface
    fun runActions(json: String): String = if (ok()) MainActivity.runActions(json) else denied
    @JavascriptInterface
    fun listNotes(): String = if (ok()) MainActivity.listNotes() else denied
    @JavascriptInterface
    fun deleteNote(id: String): String = if (ok()) MainActivity.deleteNote(id) else denied
    @JavascriptInterface
    fun recordsList(): String = if (ok()) MainActivity.recordsList() else denied
    @JavascriptInterface
    fun recordsImport(json: String): String = if (ok()) MainActivity.recordsImport(json) else denied
    @JavascriptInterface
    fun recordsDelete(id: String): String = if (ok()) MainActivity.recordsDelete(id) else denied
    @JavascriptInterface
    fun actionInfo(): String = if (ok()) MainActivity.actionInfo() else denied

    // Things a plain WebView cannot do on Android: haptics, clipboard, saving/sharing files, notifications.
    @JavascriptInterface
    fun haptic(ms: Int) { if (ok()) MainActivity.haptic(ms) }
    @JavascriptInterface
    fun copyText(text: String): Boolean = ok() && MainActivity.copyText(text)
    @JavascriptInterface
    fun shareText(text: String) { if (ok()) MainActivity.shareText(text) }
    @JavascriptInterface
    fun saveFile(name: String, text: String) { if (ok()) MainActivity.saveFile(name, text) }
    @JavascriptInterface
    fun setNotify(on: Boolean): String = if (ok()) MainActivity.setNotify(on) else denied
    /** Night briefing (change 1.3): daily notification time; the model call happens only when sir opens it. */
    @JavascriptInterface
    fun briefingSet(json: String): String = if (ok()) MainActivity.briefingSet(json) else denied
    @JavascriptInterface
    fun briefingStatus(): String = if (ok()) MainActivity.briefingStatus() else denied
    @JavascriptInterface
    fun takeOpen(): String = if (ok()) MainActivity.takeOpen() else ""
    @JavascriptInterface
    fun newsStatus(): String = if (ok()) MainActivity.newsStatus() else denied
    @JavascriptInterface
    fun newsCall(id: String, json: String) { if (ok()) MainActivity.newsCall(id, json) }

    @JavascriptInterface
    fun status(): String = if (ok()) Engine.status() else denied

    /** Pair code is accepted only from the in-app linking field; the encrypted token never returns to JS. */
    @JavascriptInterface
    fun controllerPair(id: String, code: String) {
        if (ok()) Engine.controllerPair(id, code) { result, error -> deliver(id, result, error) }
        else deliver(id, null, "Untrusted page")
    }

    @JavascriptInterface
    fun controllerSync(id: String) {
        if (ok()) Engine.controllerSync(id) { result, error -> deliver(id, result, error) }
        else deliver(id, null, "Untrusted page")
    }

    @JavascriptInterface
    fun controllerStatus(): String = if (ok()) Engine.controllerStatus() else denied

    @JavascriptInterface
    fun lessons(opJson: String): String = if (ok()) Engine.lessons(opJson) else denied

    /** Voice typing (Android SpeechRecognizer; the WebView has no Web Speech API). Events come back via window.__adarshSpeech. */
    @JavascriptInterface
    fun bnrSupported(): Boolean = ok() && MainActivity.bnrSupported()

    @JavascriptInterface
    fun speechStart(lang: String, useBnr: Boolean, functionId: String) {
        if (!ok()) return
        // Noise removal uses the first NVIDIA key slot that is set (NVIDIA_API_KEY, _2, _3).
        MainActivity.speechStart(lang, useBnr, functionId, if (useBnr) keys.first("NVIDIA_API_KEY").orEmpty() else "")
    }

    @JavascriptInterface
    fun speechStop() { if (ok()) MainActivity.speechStop() }

    /** The page may migrate its one legacy localStorage value, but never stores the token there again. */
    @JavascriptInterface
    fun backendToken(): String = if (ok()) keys.getBackendToken().orEmpty() else ""

    @JavascriptInterface
    fun saveBackendToken(value: String): String = if (!ok()) denied
    else if (value.isBlank()) err("Backend token is empty.")
    else if (keys.putBackendToken(value)) """{"ok":true}""" else err("Backend token could not be saved.")

    @JavascriptInterface
    fun deleteBackendToken(): String = if (!ok()) denied
    else if (keys.removeBackendToken()) """{"ok":true}""" else err("Backend token could not be deleted.")

    private fun err(msg: String) = JSONObject().put("ok", false).put("error", msg).toString()
}
