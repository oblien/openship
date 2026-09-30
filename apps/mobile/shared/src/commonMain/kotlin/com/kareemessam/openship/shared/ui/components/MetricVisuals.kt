package com.kareemessam.openship.shared.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme

@Composable
fun CircularMetricGauge(
    percentage: Float,
    label: String,
    valueSubtext: String,
    modifier: Modifier = Modifier
) {
    val colors = OpenshipAppTheme.colors
    val animatedPercent by animateFloatAsState(
        targetValue = percentage.coerceIn(0f, 100f),
        animationSpec = tween(durationMillis = 600)
    )

    val gaugeColor = when {
        animatedPercent >= 90f -> colors.danger.solid
        animatedPercent >= 75f -> colors.warning.solid
        else -> colors.statusActive
    }

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(14.dp))
            .background(colors.bgCard)
            .border(1.dp, colors.borderCard, RoundedCornerShape(14.dp))
            .padding(14.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                text = label.uppercase(),
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = colors.textMuted,
                letterSpacing = 0.5.sp
            )

            // Circular Gauge Canvas
            Box(
                modifier = Modifier.size(86.dp),
                contentAlignment = Alignment.Center
            ) {
                Canvas(modifier = Modifier.fillMaxSize()) {
                    val strokeWidth = 7.dp.toPx()
                    val diameter = size.minDimension - strokeWidth
                    val topLeft = Offset((size.width - diameter) / 2, (size.height - diameter) / 2)

                    // Track Background Arc (240 degrees)
                    drawArc(
                        color = if (colors.isDark) Color(0x14FFFFFF) else Color(0x10000000),
                        startAngle = 150f,
                        sweepAngle = 240f,
                        useCenter = false,
                        topLeft = topLeft,
                        size = Size(diameter, diameter),
                        style = Stroke(width = strokeWidth, cap = StrokeCap.Round)
                    )

                    // Active Progress Arc
                    val sweep = (animatedPercent / 100f) * 240f
                    if (sweep > 0f) {
                        drawArc(
                            color = gaugeColor,
                            startAngle = 150f,
                            sweepAngle = sweep,
                            useCenter = false,
                            topLeft = topLeft,
                            size = Size(diameter, diameter),
                            style = Stroke(width = strokeWidth, cap = StrokeCap.Round)
                        )
                    }
                }

                Column(
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "${animatedPercent.toInt()}%",
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.textHeading,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }

            Text(
                text = valueSubtext,
                fontSize = 10.sp,
                color = colors.textSecondary,
                fontFamily = FontFamily.Monospace,
                maxLines = 1
            )
        }
    }
}

@Composable
fun SparklineTrendCard(
    title: String,
    currentValue: String,
    history: List<Float>,
    lineColor: Color,
    modifier: Modifier = Modifier
) {
    val colors = OpenshipAppTheme.colors

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.bgCard)
            .border(1.dp, colors.borderCard, RoundedCornerShape(14.dp))
            .padding(16.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = title,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.textMuted
                    )
                    Text(
                        text = currentValue,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.textHeading,
                        fontFamily = FontFamily.Monospace
                    )
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    modifier = Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(colors.bgSubtle)
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(5.dp)
                            .clip(CircleShape)
                            .background(lineColor)
                    )
                    Text(
                        text = "Live",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.textMuted
                    )
                }
            }

            // Canvas Line Sparkline
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp)
            ) {
                if (history.size >= 2) {
                    Canvas(modifier = Modifier.fillMaxSize()) {
                        val width = size.width
                        val height = size.height
                        val stepX = width / (history.size - 1)

                        val path = Path()
                        val fillPath = Path()

                        val maxVal = 100f
                        val minVal = 0f

                        history.forEachIndexed { index, value ->
                            val x = index * stepX
                            val normalized = (value - minVal) / (maxVal - minVal)
                            val y = height - (normalized * (height - 8.dp.toPx())) - 4.dp.toPx()

                            if (index == 0) {
                                path.moveTo(x, y)
                                fillPath.moveTo(x, height)
                                fillPath.lineTo(x, y)
                            } else {
                                path.lineTo(x, y)
                                fillPath.lineTo(x, y)
                            }
                        }

                        fillPath.lineTo(width, height)
                        fillPath.close()

                        // Draw Gradient Fill under line
                        drawPath(
                            path = fillPath,
                            brush = Brush.verticalGradient(
                                listOf(lineColor.copy(alpha = 0.22f), lineColor.copy(alpha = 0.0f))
                            )
                        )

                        // Draw Stroke Line
                        drawPath(
                            path = path,
                            color = lineColor,
                            style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
                        )
                    }
                } else {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = "Awaiting telemetry samples...",
                            fontSize = 11.sp,
                            color = colors.textMuted,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                }
            }
        }
    }
}

