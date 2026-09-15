package com.kareemessam.openship.shared.util

import kotlin.test.Test
import kotlin.test.assertEquals

class Base64DecoderTest {

    @Test
    fun testValidBase64Decode() {
        // "Running build command: ./gradlew assemble" encoded in base64
        val encoded = "UnVubmluZyBidWlsZCBjb21tYW5kOiAuL2dyYWRsZXcgYXNzZW1ibGU="
        val decoded = decodeBase64ToString(encoded)
        assertEquals("Running build command: ./gradlew assemble", decoded)
    }

    @Test
    fun testEmptyAndBlankStrings() {
        assertEquals("", decodeBase64ToString(""))
        assertEquals("", decodeBase64ToString("   "))
    }

    @Test
    fun testMultilineBase64String() {
        // Base64 with carriage returns/newlines should be cleanly decoded
        val multiline = "SGVsbG8g\nV29ybGQ="
        val decoded = decodeBase64ToString(multiline)
        assertEquals("Hello World", decoded)
    }

    @Test
    fun testPlainTextFallback() {
        // If the server accidentally sends plain text, it returns the raw text gracefully
        val plain = "This is not base64 !!! @@@"
        val decoded = decodeBase64ToString(plain)
        assertEquals("This is not base64 !!! @@@", decoded)
    }
}
