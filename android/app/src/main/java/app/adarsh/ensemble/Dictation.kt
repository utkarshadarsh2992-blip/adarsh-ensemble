package app.adarsh.ensemble

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Voice typing with Android's own SpeechRecognizer. The WebView has no Web Speech API, so the page asks for this through
 * AdarshNative.speechStart / speechStop. Everything here runs on the main thread. Results go back to the page as
 * window.__adarshSpeech(type, text): "started" | "partial" | "final" | "state" (reason) | "error" (code).
 */
class Dictation(private val act: MainActivity) {
    private var rec: SpeechRecognizer? = null
    private var gotFinal = false

    fun start(lang: String) {
        if (!SpeechRecognizer.isRecognitionAvailable(act)) { MainActivity.speech("error", "unavailable"); return }
        if (act.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            begin(lang)
        } else {
            act.askMic { ok -> if (ok) begin(lang) else MainActivity.speech("error", "not_granted") }
        }
    }

    private fun begin(lang: String) {
        destroy()
        gotFinal = false
        val r = try { SpeechRecognizer.createSpeechRecognizer(act) } catch (_: Exception) { null }
        if (r == null) { MainActivity.speech("error", "unavailable"); return }
        rec = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}

            override fun onPartialResults(partialResults: Bundle?) {
                val t = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!t.isNullOrBlank()) MainActivity.speech("partial", t)
            }

            override fun onResults(results: Bundle?) {
                val t = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!t.isNullOrBlank()) { gotFinal = true; MainActivity.speech("final", " " + t.trim()) }
                MainActivity.speech("state", if (gotFinal) "final" else "empty")
                destroy()
            }

            override fun onError(error: Int) {
                when (error) {
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> MainActivity.speech("error", "not_granted")
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
                        MainActivity.speech("state", if (gotFinal) "final" else "empty")
                    SpeechRecognizer.ERROR_CLIENT -> {}   // we cancelled it ourselves
                    else -> MainActivity.speech("state", "error")
                }
                destroy()
            }
        })
        val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang.ifBlank { "en-IN" })
        try {
            r.startListening(i)
            MainActivity.speech("started", "")
        } catch (_: Exception) {
            destroy()
            MainActivity.speech("error", "unavailable")
        }
    }

    fun stop() { try { rec?.stopListening() } catch (_: Exception) {} }

    fun destroy() {
        try { rec?.destroy() } catch (_: Exception) {}
        rec = null
    }
}
