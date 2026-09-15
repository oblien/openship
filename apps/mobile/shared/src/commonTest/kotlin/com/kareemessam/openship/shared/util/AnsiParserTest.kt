package com.kareemessam.openship.shared.util

import androidx.compose.ui.graphics.Color
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AnsiParserTest {

    @Test
    fun testPlainTextWithoutAnsiCodes() {
        val plain = "Building project openship-api..."
        val parsed = AnsiParser.parse(plain)
        assertEquals("Building project openship-api...", parsed.text)
        assertTrue(parsed.spanStyles.isEmpty())
    }

    @Test
    fun testColoredAnsiCodesParsing() {
        // Red text ANSI escape sequence: \u001B[31mError occurred\u001B[0m
        val ansiString = "\u001B[31mError occurred\u001B[0m"
        val parsed = AnsiParser.parse(ansiString)

        assertEquals("Error occurred", parsed.text)
        assertEquals(1, parsed.spanStyles.size)
        assertEquals(Color(0xFFEF4444), parsed.spanStyles[0].item.color)
    }

    @Test
    fun testMultipleAnsiColorsInSingleLine() {
        val ansiString = "\u001B[32mSUCCESS:\u001B[0m \u001B[34mContainer started\u001B[0m"
        val parsed = AnsiParser.parse(ansiString)

        assertEquals("SUCCESS: Container started", parsed.text)
        assertEquals(2, parsed.spanStyles.size)
    }
}
