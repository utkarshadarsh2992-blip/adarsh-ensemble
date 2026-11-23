package app.adarsh.ensemble

import app.adarsh.ensemble.bnr.BNRGrpc
import app.adarsh.ensemble.bnr.EnhanceAudioConfig
import app.adarsh.ensemble.bnr.EnhanceAudioRequest
import app.adarsh.ensemble.bnr.EnhanceAudioResponse
import com.google.protobuf.ByteString
import io.grpc.ManagedChannel
import io.grpc.Metadata
import io.grpc.okhttp.OkHttpChannelBuilder
import io.grpc.stub.MetadataUtils
import io.grpc.stub.StreamObserver
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** NVIDIA Maxine BNR NVCF gRPC client. Never writes or logs the API key. */
internal object NvidiaBnrClient {
    private const val HOST = "grpc.nvcf.nvidia.com"
    private const val PORT = 443
    private const val RPC_TIMEOUT_S = 120L
    private const val MAX_OUTPUT_BYTES = 32 * 1024 * 1024

    @Volatile private var activeChannel: ManagedChannel? = null

    fun cancel() {
        try { activeChannel?.shutdownNow() } catch (_: Exception) {}
    }

    fun enhance(wav: File, apiKey: String, functionId: String, isCancelled: () -> Boolean): ByteArray {
        require(wav.isFile && wav.length() in 44..8_000_000L) { "Audio clip is missing or too large." }
        require(apiKey.isNotBlank() && apiKey.length <= 4096) { "NVIDIA API key is required." }
        require(functionId.matches(Regex("^[A-Za-z0-9-]{8,80}$"))) { "BNR function ID is invalid." }

        val channel = OkHttpChannelBuilder.forAddress(HOST, PORT).useTransportSecurity().build()
        activeChannel = channel
        val finished = CountDownLatch(1)
        val output = ByteArrayOutputStream()
        val error = AtomicReference<Throwable?>(null)
        val headers = Metadata().apply {
            put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer $apiKey")
            put(Metadata.Key.of("function-id", Metadata.ASCII_STRING_MARSHALLER), functionId)
        }
        val stub = BNRGrpc.newStub(channel)
            .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers))
            .withDeadlineAfter(RPC_TIMEOUT_S, TimeUnit.SECONDS)

        try {
            if (isCancelled()) throw IOException("BNR request stopped.")
            val requests = stub.enhanceAudio(object : StreamObserver<EnhanceAudioResponse> {
                override fun onNext(value: EnhanceAudioResponse) {
                    if (!value.hasAudioStreamData()) return
                    val chunk = value.audioStreamData.toByteArray()
                    synchronized(output) {
                        if (output.size().toLong() + chunk.size > MAX_OUTPUT_BYTES) {
                            error.compareAndSet(null, IOException("BNR output is too large."))
                            channel.shutdownNow()
                        } else {
                            output.write(chunk)
                        }
                    }
                }

                override fun onError(t: Throwable) {
                    error.compareAndSet(null, t)
                    finished.countDown()
                }

                override fun onCompleted() { finished.countDown() }
            })

            requests.onNext(
                EnhanceAudioRequest.newBuilder()
                    .setConfig(EnhanceAudioConfig.newBuilder().setIntensityRatio(1.0f).build())
                    .build()
            )
            FileInputStream(wav).use { input ->
                val chunk = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(chunk)
                    if (count < 0) break
                    if (channel.isShutdown || isCancelled()) throw IOException("BNR request stopped.")
                    requests.onNext(
                        EnhanceAudioRequest.newBuilder()
                            .setAudioStreamData(ByteString.copyFrom(chunk, 0, count))
                            .build()
                    )
                }
            }
            requests.onCompleted()
            if (!finished.await(RPC_TIMEOUT_S + 5, TimeUnit.SECONDS)) {
                channel.shutdownNow()
                throw IOException("BNR request timed out.")
            }
            error.get()?.let { throw IOException("BNR request failed.", it) }
            return synchronized(output) { output.toByteArray() }.also {
                if (it.isEmpty()) throw IOException("BNR returned no cleaned audio.")
            }
        } finally {
            try { channel.shutdownNow(); channel.awaitTermination(2, TimeUnit.SECONDS) } catch (_: Exception) {}
            if (activeChannel === channel) activeChannel = null
        }
    }
}
