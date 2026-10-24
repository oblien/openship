package com.kareemessam.openship.shared.util

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle

object AnsiParser {

    private val ANSI_REGEX = Regex("\u001B\\[([0-9;]*)m")

    // Terminal colors
    private val COLOR_BLACK = Color(0xFF000000)
    private val COLOR_RED = Color(0xFFEF4444)
    private val COLOR_GREEN = Color(0xFF10B981)
    private val COLOR_YELLOW = Color(0xFFF59E0B)
    private val COLOR_BLUE = Color(0xFF3B82F6)
    private val COLOR_MAGENTA = Color(0xFFA855F7)
    private val COLOR_CYAN = Color(0xFF06B6D4)
    private val COLOR_WHITE = Color(0xFFF3F4F6)
    private val COLOR_GRAY = Color(0xFF9CA3AF)

    fun parse(text: String, defaultColor: Color = Color(0xFFE5E7EB)): AnnotatedString {
        if (!text.contains("\u001B[")) {
            return AnnotatedString(text)
        }

        return buildAnnotatedString {
            var currentIndex = 0
            var currentColor = defaultColor
            var isBold = false

            val matches = ANSI_REGEX.findAll(text).toList()
            for (match in matches) {
                if (match.range.first > currentIndex) {
                    val rawChunk = text.substring(currentIndex, match.range.first)
                    if (currentColor != defaultColor || isBold) {
                        withStyle(
                            SpanStyle(
                                color = currentColor,
                                fontWeight = if (isBold) FontWeight.Bold else FontWeight.Normal
                            )
                        ) {
                            append(rawChunk)
                        }
                    } else {
                        append(rawChunk)
                    }
                }

                val codeStr = match.groupValues[1]
                val codes = if (codeStr.isEmpty()) listOf(0) else codeStr.split(";").mapNotNull { it.toIntOrNull() }

                for (code in codes) {
                    when (code) {
                        0 -> {
                            currentColor = defaultColor
                            isBold = false
                        }
                        1 -> isBold = true
                        22 -> isBold = false
                        30 -> currentColor = COLOR_BLACK
                        31 -> currentColor = COLOR_RED
                        32 -> currentColor = COLOR_GREEN
                        33 -> currentColor = COLOR_YELLOW
                        34 -> currentColor = COLOR_BLUE
                        35 -> currentColor = COLOR_MAGENTA
                        36 -> currentColor = COLOR_CYAN
                        37 -> currentColor = COLOR_WHITE
                        39 -> currentColor = defaultColor
                        90 -> currentColor = COLOR_GRAY
                        91 -> currentColor = COLOR_RED
                        92 -> currentColor = COLOR_GREEN
                        93 -> currentColor = COLOR_YELLOW
                        94 -> currentColor = COLOR_BLUE
                        95 -> currentColor = COLOR_MAGENTA
                        96 -> currentColor = COLOR_CYAN
                        97 -> currentColor = COLOR_WHITE
                    }
                }

                currentIndex = match.range.last + 1
            }

            if (currentIndex < text.length) {
                val remaining = text.substring(currentIndex)
                if (currentColor != defaultColor || isBold) {
                    withStyle(
                        SpanStyle(
                            color = currentColor,
                            fontWeight = if (isBold) FontWeight.Bold else FontWeight.Normal
                        )
                    ) {
                        append(remaining)
                    }
                } else {
                    append(remaining)
                }
            }
        }
    }
}
