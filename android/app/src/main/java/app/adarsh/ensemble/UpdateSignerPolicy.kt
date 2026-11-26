package app.adarsh.ensemble

/**
 * APK updater trust policy. This is deliberately pure so a JVM test can exercise it without Android.
 * Only the current rotated signer is accepted as the signer of a downloaded APK; signing history is
 * checked separately by UpdateManager for v3 lineage continuity.
 */
object UpdateSignerPolicy {
    const val CURRENT_CERTIFICATE_SHA256 = "600b196ec2224730ea8d24e83e9f9411bd661329569598e07180cd6b596ea5af"

    fun acceptsCurrentSigner(currentSignerDigests: Set<String>): Boolean =
        currentSignerDigests.size == 1 && CURRENT_CERTIFICATE_SHA256 in currentSignerDigests
}
