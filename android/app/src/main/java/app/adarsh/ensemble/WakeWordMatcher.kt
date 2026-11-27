package app.adarsh.ensemble

import java.util.Locale

/** Pure transcript matcher: callers pass text returned by Android's on-device recognizer only. */
internal object WakeWordMatcher {
    fun matches(transcript: String?): Boolean {
        if (transcript.isNullOrBlank()) return false
        val words = transcript.lowercase(Locale.ROOT)
            .replace(Regex("[^\\p{L}\\p{N}]+"), " ")
            .trim()
            .split(Regex("\\s+"))
        return words.size >= 2 && words[0] == "hey" && words[1] == "adarsh"
    }
}
