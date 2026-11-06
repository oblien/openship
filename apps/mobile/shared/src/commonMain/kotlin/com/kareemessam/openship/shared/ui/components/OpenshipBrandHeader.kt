package com.kareemessam.openship.shared.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.NightlightRound
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kareemessam.openship.shared.ui.theme.LocalThemeMode
import com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme
import com.kareemessam.openship.shared.ui.theme.ThemeMode
import openship.shared.generated.resources.Res
import openship.shared.generated.resources.app_logo
import openship.shared.generated.resources.app_logo_white
import org.jetbrains.compose.resources.painterResource

@Composable
fun OpenshipBrandLogo(
    modifier: Modifier = Modifier,
    logoSize: Dp = 32.dp,
    titleSize: TextUnit = 18.sp
) {
    val colors = OpenshipAppTheme.colors
    val logoResource = if (colors.isDark) Res.drawable.app_logo_white else Res.drawable.app_logo

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = modifier
    ) {
        Image(
            painter = painterResource(logoResource),
            contentDescription = "Openship Logo",
            modifier = Modifier.size(logoSize)
        )

        Text(
            text = "Openship",
            fontWeight = FontWeight.Bold,
            fontSize = titleSize,
            color = colors.textHeading,
            letterSpacing = (-0.3).sp
        )
    }
}

@Composable
fun TerminalWindowDots(
    modifier: Modifier = Modifier
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(Color(0xFFFF5F56))
        )
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(Color(0xFFFFBD2E))
        )
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(Color(0xFF27C93F))
        )
    }
}

@Composable
fun OpenshipTopBar(
    instanceLabel: String?,
    onSwitchInstance: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = OpenshipAppTheme.colors
    val themeModeState = LocalThemeMode.current

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.bgPage)
            .statusBarsPadding()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            OpenshipBrandLogo()

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                // Theme Cycle Button (Dark -> Dim -> Light)
                IconButton(
                    onClick = {
                        themeModeState.value = when (themeModeState.value) {
                            ThemeMode.DARK -> ThemeMode.DIM
                            ThemeMode.DIM -> ThemeMode.LIGHT
                            ThemeMode.LIGHT, ThemeMode.SYSTEM -> ThemeMode.DARK
                        }
                    },
                    modifier = Modifier
                        .size(32.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(colors.bgSubtle)
                ) {
                    val icon = when (themeModeState.value) {
                        ThemeMode.DARK -> Icons.Default.DarkMode
                        ThemeMode.DIM -> Icons.Default.NightlightRound
                        ThemeMode.LIGHT -> Icons.Default.LightMode
                        ThemeMode.SYSTEM -> if (colors.isDark) Icons.Default.DarkMode else Icons.Default.LightMode
                    }
                    Icon(
                        imageVector = icon,
                        contentDescription = "Theme: ${themeModeState.value.label}",
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp)
                    )
                }

                // Instance Switcher Pill
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(colors.bgCard)
                        .border(1.dp, colors.borderDefault, RoundedCornerShape(999.dp))
                        .clickable(onClick = onSwitchInstance)
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(colors.statusActive)
                    )
                    Text(
                        text = instanceLabel ?: "Localhost",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.textStrong,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(max = 120.dp)
                    )
                    Icon(
                        imageVector = Icons.Default.KeyboardArrowDown,
                        contentDescription = "Switch Instance",
                        tint = colors.textMuted,
                        modifier = Modifier.size(14.dp)
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(colors.borderSubtle)
        )
    }
}

