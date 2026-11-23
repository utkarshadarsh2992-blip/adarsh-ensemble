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

    @JavascriptInterface
    fun updateStatus(): String = if (ok()) MainActivity.updateStatus() else denied
    @JavascriptInterface
    fun updateCheck(force: Boolean): String = if (ok()) MainActivity.updateCheck(force) else denied
    @JavascriptInterface
    fun updateDownload(): String = if (ok()) MainActivity.updateDownload() else denied
    @JavascriptInterface
    fun updateInstall(): String = if (ok()) MainActivity.updateInstall() else denied
    @JavascriptInterface
    fun backgroundVoiceStatus(): String = if (ok()) MainActivity.backgroundVoiceStatus() else denied
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

    @JavascriptInterface
    fun status(): String = if (ok()) Engine.status() else denied

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

    @JavascriptInterface
    fun keyStatus(): String {
        if (!ok()) return denied
        val o = JSONObject()
        for (n in SecureKeys.NAMES) {
            o.put(n, JSONObject().put("set", keys.get(n) != null).put("hint", keys.hint(n)))
        }
        // L5: if the encrypted key store had to be reset, tell the page once so the user can re-enter keys.
        keys.takeResetNotice()?.let { o.put("_notice", it) }
        return o.toString()
    }

    @JavascriptInterface
    fun saveKey(name: String, value: String): String {
        if (!ok()) return denied
        if (!keys.put(name, value)) return err("That key could not be saved.")
        Engine.setKey(name, value.trim())
        return """{"ok":true}"""
    }

    @JavascriptInterface
    fun deleteKey(name: String): String {
        if (!ok()) return denied
        if (!keys.remove(name)) return err("That key could not be deleted.")
        Engine.setKey(name, "")
        return """{"ok":true}"""
    }

    private fun err(msg: String) = JSONObject().put("ok", false).put("error", msg).toString()
}
