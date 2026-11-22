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

    @JavascriptInterface
    fun cancel(id: String) = Engine.cancel(id)

    @JavascriptInterface
    fun status(): String = Engine.status()

    @JavascriptInterface
    fun lessons(opJson: String): String = Engine.lessons(opJson)

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
