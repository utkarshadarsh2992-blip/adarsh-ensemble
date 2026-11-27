package app.adarsh.ensemble

import java.util.Locale

/**
 * Pure transcript matcher for "Hey Adarsh". Speech engines spell the name in many ways
 * ("hey adarsh", "hey a darsh", "hi adarsh", "heyadarsh", "hey adash", "हे आदर्श"), so the
 * match is tolerant but still needs a greeting immediately before a name-like token.
 */
internal object WakeWordMatcher {
    private const val NAME = "adarsh"
    private val GREETINGS = setOf(
        "hey", "hay", "hei", "heh", "he", "hi", "hii", "hai", "hello", "helo", "ok", "okay",
        "ae", "ay", "aye", "ey", "हे", "हाय", "है", "ए", "ऐ", "हेलो"
    )
    private val DEVANAGARI_NAMES = setOf("आदर्श", "अदर्श", "आदर्ष", "आदरश")

    fun matches(transcript: String?): Boolean {
        if (transcript.isNullOrBlank()) return false
        val words = transcript.lowercase(Locale.ROOT)
            .replace(Regex("[^\\p{L}\\p{M}\\p{N}]+"), " ")
            .trim()
            .split(Regex("\\s+"))
            .filter { it.isNotEmpty() }
        if (words.isEmpty()) return false
        for (i in words.indices) {
            val w = words[i]
            // Joined forms such as "heyadarsh" / "hiadarsh".
            if (w.length in 7..11 && (w.startsWith("hey") || w.startsWith("hay") || w.startsWith("hi")) &&
                nameLike(w.removePrefix("hey").removePrefix("hay").removePrefix("hi"))
            ) return true
            if (w !in GREETINGS) continue
            val one = words.getOrNull(i + 1) ?: continue
            if (nameLike(one)) return true
            val two = words.getOrNull(i + 2)
            if (two != null && nameLike(one + two)) return true   // "a darsh", "aa darsh"
        }
        return false
    }

    /** Any of the recognizer's alternatives may carry the phrase. */
    fun matchesAny(candidates: List<String>?): Boolean = candidates?.any { matches(it) } == true

    private fun nameLike(token: String): Boolean {
        if (token in DEVANAGARI_NAMES) return true
        if (token.length < 4 || token.length > 9) return false
        return distance(token, NAME) <= 2
    }

    private fun distance(a: String, b: String): Int {
        val prev = IntArray(b.length + 1) { it }
        val cur = IntArray(b.length + 1)
        for (i in 1..a.length) {
            cur[0] = i
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                cur[j] = minOf(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
            }
            System.arraycopy(cur, 0, prev, 0, prev.size)
        }
        return prev[b.length]
    }
}
