package app.adarsh.ensemble

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.Process
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.sqrt

/**
 * Foreground voice typing. Default path is Android SpeechRecognizer. When the user opts in to BNR,
 * ADARSH captures one short utterance, sends float32 WAV to NVIDIA's BNR NVCF function, converts the
 * cleaned WAV to PCM16, then supplies it to Android SpeechRecognizer (API 33+ custom audio input).
 * Temporary raw and clean audio files are kept in cache only and deleted at completion/cancel.
 */
class Dictation(private val act: MainActivity) {
    private var rec: SpeechRecognizer? = null
    private var audioSource: ParcelFileDescriptor? = null
    private var gotFinal = false
    private val generation = AtomicLong(0)
    private val startGeneration = AtomicLong(0)
    private var awaitingMicPermission = false
    @Volatile private var bnrJob: BnrJob? = null

    private class BnrJob(
        val token: Long,
        val lang: String,
        val apiKey: String,
        val functionId: String,
        val input: File,
        val cleaned: File
    ) {
        @Volatile var stopRequested = false
        @Volatile var cancelled = false
        @Volatile var recording = true
        @Volatile var processing = false
        @Volatile var transcribing = false
        @Volatile var recorder: AudioRecord? = null
    }

    fun start(lang: String, useBnr: Boolean = false, functionId: String = "", apiKey: String = "") {
        destroy()
        gotFinal = false
        val startToken = startGeneration.incrementAndGet()
        if (!SpeechRecognizer.isRecognitionAvailable(act)) {
            MainActivity.speech("error", "unavailable")
            return
        }
        if (useBnr && Build.VERSION.SDK_INT < 33) {
            MainActivity.speech("error", "bnr_unsupported")
            return
        }
        if (useBnr && (apiKey.isBlank() || !functionId.matches(Regex("^[A-Za-z0-9-]{8,80}$")))) {
            MainActivity.speech("error", "bnr_config")
            return
        }
        if (act.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            begin(lang, useBnr, functionId, apiKey)
        } else {
            act.askMic { ok ->
                awaitingMicPermission = false
                if (startGeneration.get() != startToken) return@askMic
                if (ok) begin(lang, useBnr, functionId, apiKey)
                else MainActivity.speech("error", "not_granted")
            }
            awaitingMicPermission = true
        }
    }

    private fun begin(lang: String, useBnr: Boolean, functionId: String, apiKey: String) {
        if (useBnr) startBnr(lang, functionId, apiKey) else beginRecognizer(lang)
    }

    private fun startBnr(lang: String, functionId: String, apiKey: String) {
        val dir = File(act.cacheDir, "voice-bnr")
        dir.mkdirs()
        dir.listFiles()?.forEach { try { it.delete() } catch (_: Exception) {} }
        val token = generation.incrementAndGet()
        val job = BnrJob(
            token, lang.ifBlank { "en-IN" }, apiKey, functionId,
            File(dir, "input-$token.wav"), File(dir, "clean-$token.pcm")
        )
        bnrJob = job
        MainActivity.speech("started", "")
        Thread({ captureAndTranscribe(job) }, "adarsh-bnr-capture").start()
    }

    private fun isCurrent(job: BnrJob): Boolean = bnrJob === job && generation.get() == job.token && !job.cancelled

    private fun captureAndTranscribe(job: BnrJob) {
        var recorder: AudioRecord? = null
        try {
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
            val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (min <= 0) throw IOException("Microphone setup failed.")
            recorder = AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                maxOf(min * 2, FRAME_SAMPLES * 4)
            )
            if (recorder.state != AudioRecord.STATE_INITIALIZED) throw IOException("Microphone is unavailable.")
            job.recorder = recorder
            recorder.startRecording()

            val pcm16 = ByteArrayOutputStream()
            val frame = ShortArray(FRAME_SAMPLES)
            var elapsedMs = 0L
            var lastVoiceMs = -1L
            var speechFrames = 0
            while (isCurrent(job) && !job.stopRequested && elapsedMs < MAX_RECORDING_MS) {
                val count = recorder.read(frame, 0, frame.size, AudioRecord.READ_BLOCKING)
                if (count < 0) throw IOException("Microphone audio could not be read.")
                if (count == 0) continue
                for (i in 0 until count) {
                    val sample = frame[i].toInt()
                    pcm16.write(sample and 0xff)
                    pcm16.write((sample shr 8) and 0xff)
                }
                var squares = 0.0
                for (i in 0 until count) {
                    val sample = frame[i].toDouble()
                    squares += sample * sample
                }
                val rms = sqrt(squares / count)
                elapsedMs += count * 1000L / SAMPLE_RATE
                if (rms >= VOICE_RMS_THRESHOLD) {
                    lastVoiceMs = elapsedMs
                    speechFrames++
                } else if (lastVoiceMs >= 0 && elapsedMs - lastVoiceMs >= SILENCE_END_MS) {
                    break
                } else if (lastVoiceMs < 0 && elapsedMs >= NO_SPEECH_TIMEOUT_MS) {
                    throw IOException("No speech detected.")
                }
            }
            if (!isCurrent(job)) return
            if (speechFrames < MIN_SPEECH_FRAMES) throw IOException("No speech detected.")

            job.recording = false
            job.processing = true
            MainActivity.speech("processing", "")
            job.input.writeBytes(pcm16ToFloatWav(pcm16.toByteArray()))
            try { recorder.stop() } catch (_: Exception) {}
            recorder.release()
            recorder = null
            job.recorder = null

            if (!isCurrent(job)) return
            val enhancedWav = NvidiaBnrClient.enhance(job.input, job.apiKey, job.functionId) { !isCurrent(job) }
            if (!isCurrent(job)) return
            job.cleaned.writeBytes(floatOrPcmWavToPcm16(enhancedWav))
            job.input.delete()
            job.processing = false
            job.transcribing = true
            act.runOnUiThread { if (isCurrent(job)) startRecognizerWithAudio(job) }
        } catch (e: Exception) {
            if (isCurrent(job)) act.runOnUiThread {
                if (isCurrent(job)) finishBnrError(job, if (e.message == "No speech detected.") "bnr_empty" else "bnr_failed")
            }
        } finally {
            try { recorder?.stop() } catch (_: Exception) {}
            try { recorder?.release() } catch (_: Exception) {}
            if (job.recorder === recorder) job.recorder = null
        }
    }

    private fun startRecognizerWithAudio(job: BnrJob) {
        if (!isCurrent(job)) return
        destroyRecognizer()
        val r = try { SpeechRecognizer.createSpeechRecognizer(act) } catch (_: Exception) { null }
        if (r == null) { finishBnrError(job, "unavailable"); return }
        rec = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partialResults: Bundle?) {}

            override fun onResults(results: Bundle?) {
                if (!isCurrent(job)) return
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
                if (text.isNotBlank()) { gotFinal = true; MainActivity.speech("final", " $text") }
                MainActivity.speech("state", if (gotFinal) "final" else "empty")
                finishBnr(job)
            }

            override fun onError(error: Int) {
                if (!isCurrent(job)) return
                if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) MainActivity.speech("error", "not_granted")
                else MainActivity.speech("state", if (gotFinal) "final" else "recognition_error")
                finishBnr(job)
            }
        })
        try {
            val pfd = ParcelFileDescriptor.open(job.cleaned, ParcelFileDescriptor.MODE_READ_ONLY)
            audioSource = pfd
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, job.lang)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pfd)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, SAMPLE_RATE)
            r.startListening(intent)
        } catch (_: Exception) {
            finishBnrError(job, "recognition_error")
        }
    }

    private fun finishBnrError(job: BnrJob, code: String) {
        if (!isCurrent(job)) return
        MainActivity.speech("error", code)
        finishBnr(job)
    }

    private fun finishBnr(job: BnrJob) {
        if (bnrJob !== job) return
        bnrJob = null
        generation.incrementAndGet()
        destroyRecognizer()
        job.input.delete()
        job.cleaned.delete()
    }

    private fun beginRecognizer(lang: String) {
        destroyRecognizer()
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
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!text.isNullOrBlank()) MainActivity.speech("partial", text)
            }
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!text.isNullOrBlank()) { gotFinal = true; MainActivity.speech("final", " ${text.trim()}") }
                MainActivity.speech("state", if (gotFinal) "final" else "empty")
                destroyRecognizer()
            }
            override fun onError(error: Int) {
                when (error) {
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> MainActivity.speech("error", "not_granted")
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
                        MainActivity.speech("state", if (gotFinal) "final" else "empty")
                    SpeechRecognizer.ERROR_CLIENT -> {}
                    else -> MainActivity.speech("state", "error")
                }
                destroyRecognizer()
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang.ifBlank { "en-IN" })
        try {
            r.startListening(intent)
            MainActivity.speech("started", "")
        } catch (_: Exception) {
            destroyRecognizer()
            MainActivity.speech("error", "unavailable")
        }
    }

    fun stop() {
        if (awaitingMicPermission) {
            awaitingMicPermission = false
            startGeneration.incrementAndGet()
            MainActivity.speech("state", "cancelled")
            return
        }
        val job = bnrJob
        if (job != null) {
            if (job.recording) {
                job.stopRequested = true
            } else if (job.processing) {
                job.cancelled = true
                generation.incrementAndGet()
                NvidiaBnrClient.cancel()
                job.input.delete(); job.cleaned.delete()
                bnrJob = null
                MainActivity.speech("state", "cancelled")
            } else if (job.transcribing) {
                try { rec?.stopListening() } catch (_: Exception) {}
            }
            return
        }
        try { rec?.stopListening() } catch (_: Exception) {}
    }

    fun destroy() {
        generation.incrementAndGet()
        startGeneration.incrementAndGet()
        awaitingMicPermission = false
        val job = bnrJob
        bnrJob = null
        if (job != null) {
            job.cancelled = true
            job.stopRequested = true
            try { job.recorder?.stop() } catch (_: Exception) {}
            try { job.recorder?.release() } catch (_: Exception) {}
            if (job.processing) NvidiaBnrClient.cancel()
            job.input.delete(); job.cleaned.delete()
        }
        destroyRecognizer()
    }

    /** BNR is a foreground-only option; leaving the activity cancels capture/upload, unlike the separate voice service. */
    fun cancelBnrForBackground() {
        if (bnrJob == null) return
        destroy()
        MainActivity.speech("state", "cancelled")
    }

    private fun destroyRecognizer() {
        try { rec?.destroy() } catch (_: Exception) {}
        rec = null
        try { audioSource?.close() } catch (_: Exception) {}
        audioSource = null
    }

    private fun pcm16ToFloatWav(pcm: ByteArray): ByteArray {
        if (pcm.isEmpty() || pcm.size % 2 != 0) throw IOException("No audio was recorded.")
        val samples = pcm.size / 2
        val dataSize = samples * 4
        val out = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
        out.put("RIFF".toByteArray(Charsets.US_ASCII)); out.putInt(36 + dataSize)
        out.put("WAVEfmt ".toByteArray(Charsets.US_ASCII)); out.putInt(16)
        out.putShort(3); out.putShort(1); out.putInt(SAMPLE_RATE); out.putInt(SAMPLE_RATE * 4)
        out.putShort(4); out.putShort(32); out.put("data".toByteArray(Charsets.US_ASCII)); out.putInt(dataSize)
        val src = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN)
        while (src.remaining() >= 2) out.putFloat(src.short.toFloat() / 32768.0f)
        return out.array()
    }

    private fun floatOrPcmWavToPcm16(wav: ByteArray): ByteArray {
        if (wav.size < 44 || wav.copyOfRange(0, 4).toString(Charsets.US_ASCII) != "RIFF" ||
            wav.copyOfRange(8, 12).toString(Charsets.US_ASCII) != "WAVE") throw IOException("BNR returned invalid WAV audio.")
        var offset = 12
        var format = -1
        var channels = 0
        var rate = 0
        var bits = 0
        var dataOffset = -1
        var dataLength = 0
        while (offset + 8 <= wav.size) {
            val id = wav.copyOfRange(offset, offset + 4).toString(Charsets.US_ASCII)
            val length = ByteBuffer.wrap(wav, offset + 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
            if (length < 0 || offset + 8L + length > wav.size) throw IOException("BNR WAV chunk is malformed.")
            val start = offset + 8
            if (id == "fmt ") {
                if (length < 16) throw IOException("BNR WAV format is invalid.")
                val fmt = ByteBuffer.wrap(wav, start, length).order(ByteOrder.LITTLE_ENDIAN)
                format = fmt.short.toInt() and 0xffff
                channels = fmt.short.toInt() and 0xffff
                rate = fmt.int
                fmt.int // byte rate
                fmt.short // block alignment
                bits = fmt.short.toInt() and 0xffff
            } else if (id == "data") {
                dataOffset = start; dataLength = length
            }
            offset = start + length + (length and 1)
        }
        if (channels != 1 || rate != SAMPLE_RATE || dataOffset < 0) throw IOException("BNR WAV format is not supported.")
        if (format == 1 && bits == 16 && dataLength % 2 == 0) return wav.copyOfRange(dataOffset, dataOffset + dataLength)
        if (format != 3 || bits != 32 || dataLength % 4 != 0) throw IOException("BNR WAV must contain mono 16 kHz PCM audio.")
        val src = ByteBuffer.wrap(wav, dataOffset, dataLength).order(ByteOrder.LITTLE_ENDIAN)
        val out = ByteBuffer.allocate(dataLength / 2).order(ByteOrder.LITTLE_ENDIAN)
        while (src.remaining() >= 4) {
            val sample = src.float
            if (!sample.isFinite()) throw IOException("BNR WAV contains invalid samples.")
            out.putShort((sample.coerceIn(-1.0f, 1.0f) * 32767.0f).toInt().toShort())
        }
        return out.array()
    }

    companion object {
        private const val SAMPLE_RATE = 16_000
        private const val FRAME_SAMPLES = 320 // 20 ms
        private const val VOICE_RMS_THRESHOLD = 350.0
        private const val MIN_SPEECH_FRAMES = 2
        private const val SILENCE_END_MS = 1_400L
        private const val NO_SPEECH_TIMEOUT_MS = 8_000L
        private const val MAX_RECORDING_MS = 20_000L
    }
}
