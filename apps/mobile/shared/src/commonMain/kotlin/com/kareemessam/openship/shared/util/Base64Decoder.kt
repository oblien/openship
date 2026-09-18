package com.kareemessam.openship.shared.util

import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

@OptIn(ExperimentalEncodingApi::class)
fun decodeBase64ToString(base64Text: String): String {
    if (base64Text.isBlank()) return ""
    return try {
        val clean = base64Text.trim().replace("\n", "").replace("\r", "")
        val bytes = Base64.decode(clean)
        bytes.decodeToString()
    } catch (e: Exception) {
        // Fallback: If not valid base64, return original string
        base64Text
    }
}
