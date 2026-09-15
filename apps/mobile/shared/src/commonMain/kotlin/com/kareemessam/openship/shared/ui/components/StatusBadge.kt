package com.kareemessam.openship.shared.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme
import com.kareemessam.openship.shared.ui.theme.StatusStyle

enum class StatusKind {
    SUCCESS,
    DANGER,
    WARNING,
    INFO,
    NEUTRAL
}

@Composable
fun StatusBadge(
    text: String,
    kind: StatusKind,
    modifier: Modifier = Modifier,
    showDot: Boolean = true,
    pulseDot: Boolean = false,
    compact: Boolean = false
) {
    val theme = OpenshipAppTheme.colors
    val style: StatusStyle = when (kind) {
        StatusKind.SUCCESS -> theme.success
        StatusKind.DANGER -> theme.danger
        StatusKind.WARNING -> theme.warning
        StatusKind.INFO -> theme.info
        StatusKind.NEUTRAL -> theme.neutral
    }

    val dotAlpha by if (pulseDot) {
        val infiniteTransition = rememberInfiniteTransition(label = "pulse")
        infiniteTransition.animateFloat(
            initialValue = 0.4f,
            targetValue = 1.0f,
            animationSpec = infiniteRepeatable(
                animation = tween(800, easing = EaseInOut),
                repeatMode = RepeatMode.Reverse
            ),
            label = "dotAlpha"
        )
    } else {
        rememberUpdatedState(1f)
    }

    val hPad = if (compact) 8.dp else 10.dp
    val vPad = if (compact) 3.dp else 5.dp
    val fontSize = if (compact) 11.sp else 12.sp
    val dotSize = if (compact) 5.dp else 6.dp

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(style.bg)
            .border(1.dp, style.border, RoundedCornerShape(999.dp))
            .padding(horizontal = hPad, vertical = vPad),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(if (compact) 5.dp else 6.dp)
    ) {
        if (showDot) {
            Box(
                modifier = Modifier
                    .size(dotSize)
                    .alpha(dotAlpha)
                    .background(style.solid, CircleShape)
            )
        }
        Text(
            text = text,
            color = style.fg,
            fontSize = fontSize,
            fontWeight = FontWeight.SemiBold,
            lineHeight = fontSize
        )
    }
}

