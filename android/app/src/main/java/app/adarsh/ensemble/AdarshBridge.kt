package app.adarsh.ensemble

import android.webkit.JavascriptInterface
import org.json.JSONObject

/** The only door between the page and the engine. Exposed to JS as `AdarshNative`. */
class AdarshBridge(
    private val keys: SecureKeys,
    private val progress: (String, String) -> Unit,
    private val deliver: (String, String?, String?) -> Unit
) {

    @JavascriptInterface
    fun send(id: String, requestJson: String) {
        Engine.submit(id, requestJson, { msg -> progress(id, msg) }) { result, error -> deliver(id, result, error) }
    }

    /** Same as send, but no "working" notification / foreground service: short jobs like the natural voice. */
    @JavascriptInterface
    fun sendQuiet(id: String, requestJson: String) {
        Engine.submit(id, requestJson, { msg -> progress(id, msg) }, foreground = false) { result, error -> deliver(id, result, error) }
    }
    @JavascriptInterface
    fun cancel(id: String) = Engine.cancel(id)

    // Speech out: the WebView has no speechSynthesis. Events come back via window.__adarshTts(type, id).
    @JavascriptInterface
    fun ttsAvailable(): Boolean = MainActivity.ttsAvailable()
    @JavascriptInterface
    fun ttsSpeak(id: String, text: String, lang: String, rate: Float) = MainActivity.ttsSpeak(id, text, lang, rate)
    @JavascriptInterface
    fun ttsPlayFile(id: String, path: String, rate: Float) = MainActivity.ttsPlayFile(id, path, rate)
    @JavascriptInterface
    fun ttsStop() = MainActivity.ttsStop()

    // Things a plain WebView cannot do on Android: haptics, clipboard, saving/sharing files, notifications.
    @JavascriptInterface
    fun haptic(ms: Int) = MainActivity.haptic(ms)
    @JavascriptInterface
    fun copyText(text: String): Boolean = MainActivity.copyText(text)
    @JavascriptInterface
    fun shareText(text: String) = MainActivity.shareText(text)
    @JavascriptInterface
    fun saveFile(name: String, text: String) = MainActivity.saveFile(name, text)
    @JavascriptInterface
    fun setNotify(on: Boolean): String = MainActivity.setNotify(on)

    @JavascriptInterface
    fun status(): String = Engine.status()

    @JavascriptInterface
    fun lessons(opJson: String): String = Engine.lessons(opJson)

    /** Voice typing (Android SpeechRecognizer; the WebView has no Web Speech API). Events come back via window.__adarshSpeech. */
    @JavascriptInterface
    fun speechStart(lang: String) = MainActivity.speechStart(lang)

    @JavascriptInterface
    fun speechStop() = MainActivity.speechStop()

    @JavascriptInterface
    fun keyStatus(): String {
        val o = JSONObject()
        for (n in SecureKeys.NAMES) {
            o.put(n, JSONObject().put("set", keys.get(n) != null).put("hint", keys.hint(n)))
        }
        return o.toString()
    }

    @JavascriptInterface
    fun saveKey(name: String, value: String): String {
        if (!keys.put(name, value)) return err("That key could not be saved.")
        Engine.setKey(name, value.trim())
        return """{"ok":true}"""
    }

    @JavascriptInterface
    fun deleteKey(name: String): String {
        if (!keys.remove(name)) return err("That key could not be deleted.")
        Engine.setKey(name, "")
        return """{"ok":true}"""
    }

    private fun err(msg: String) = JSONObject().put("ok", false).put("error", msg).toString()
}
