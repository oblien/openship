package com.kareemessam.openship.shared.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.*

enum class ThemeMode(val label: String) {
    DARK("Dark"),
    DIM("Dim"),
    LIGHT("Light"),
    SYSTEM("System")
}

val LocalThemeMode = staticCompositionLocalOf<MutableState<ThemeMode>> {
    error("LocalThemeMode not provided. Wrap content in OpenshipTheme.")
}

private val OpenshipDarkColorScheme = darkColorScheme(
    background = OpenshipColors.Dark.BgPage,
    surface = OpenshipColors.Dark.BgPage,
    surfaceVariant = OpenshipColors.Dark.BgCard,
    surfaceContainer = OpenshipColors.Dark.BgCard,
    surfaceContainerHigh = OpenshipColors.Dark.BgCardElevated,
    onBackground = OpenshipColors.Dark.TextTitle,
    onSurface = OpenshipColors.Dark.TextTitle,
    onSurfaceVariant = OpenshipColors.Dark.TextBody,
    outline = OpenshipColors.Dark.BorderDefault,
    outlineVariant = OpenshipColors.Dark.BorderSubtle,
    primary = OpenshipColors.Dark.ButtonPrimaryBg,
    onPrimary = OpenshipColors.Dark.ButtonPrimaryText,
    primaryContainer = OpenshipColors.Dark.BgCardElevated,
    onPrimaryContainer = OpenshipColors.Dark.TextHeading,
    secondary = OpenshipColors.Dark.StatusInfoSolid,
    onSecondary = OpenshipColors.Dark.ButtonPrimaryBg,
    secondaryContainer = OpenshipColors.Dark.BgCardElevated,
    onSecondaryContainer = OpenshipColors.Dark.TextTitle,
    error = OpenshipColors.Dark.StatusDangerFg,
    onError = OpenshipColors.Dark.ButtonPrimaryText,
    errorContainer = OpenshipColors.Dark.StatusDangerBg,
    onErrorContainer = OpenshipColors.Dark.StatusDangerFg
)

private val OpenshipDimColorScheme = darkColorScheme(
    background = OpenshipColors.Dim.BgPage,
    surface = OpenshipColors.Dim.BgPage,
    surfaceVariant = OpenshipColors.Dim.BgCard,
    surfaceContainer = OpenshipColors.Dim.BgCard,
    surfaceContainerHigh = OpenshipColors.Dim.BgCardElevated,
    onBackground = OpenshipColors.Dim.TextTitle,
    onSurface = OpenshipColors.Dim.TextTitle,
    onSurfaceVariant = OpenshipColors.Dim.TextBody,
    outline = OpenshipColors.Dim.BorderDefault,
    outlineVariant = OpenshipColors.Dim.BorderSubtle,
    primary = OpenshipColors.Dim.ButtonPrimaryBg,
    onPrimary = OpenshipColors.Dim.ButtonPrimaryText,
    primaryContainer = OpenshipColors.Dim.BgCardElevated,
    onPrimaryContainer = OpenshipColors.Dim.TextHeading,
    secondary = OpenshipColors.Dim.StatusInfoSolid,
    onSecondary = OpenshipColors.Dim.ButtonPrimaryBg,
    secondaryContainer = OpenshipColors.Dim.BgCardElevated,
    onSecondaryContainer = OpenshipColors.Dim.TextTitle,
    error = OpenshipColors.Dim.StatusDangerFg,
    onError = OpenshipColors.Dim.ButtonPrimaryText,
    errorContainer = OpenshipColors.Dim.StatusDangerBg,
    onErrorContainer = OpenshipColors.Dim.StatusDangerFg
)

private val OpenshipLightColorScheme = lightColorScheme(
    background = OpenshipColors.Light.BgPage,
    surface = OpenshipColors.Light.BgPage,
    surfaceVariant = OpenshipColors.Light.BgCard,
    surfaceContainer = OpenshipColors.Light.BgCard,
    surfaceContainerHigh = OpenshipColors.Light.BgCardElevated,
    onBackground = OpenshipColors.Light.TextTitle,
    onSurface = OpenshipColors.Light.TextTitle,
    onSurfaceVariant = OpenshipColors.Light.TextBody,
    outline = OpenshipColors.Light.BorderDefault,
    outlineVariant = OpenshipColors.Light.BorderSubtle,
    primary = OpenshipColors.Light.ButtonPrimaryBg,
    onPrimary = OpenshipColors.Light.ButtonPrimaryText,
    primaryContainer = OpenshipColors.Light.BgCardElevated,
    onPrimaryContainer = OpenshipColors.Light.TextHeading,
    secondary = OpenshipColors.Light.StatusInfoSolid,
    onSecondary = OpenshipColors.Light.ButtonPrimaryBg,
    secondaryContainer = OpenshipColors.Light.BgCardElevated,
    onSecondaryContainer = OpenshipColors.Light.TextTitle,
    error = OpenshipColors.Light.StatusDangerFg,
    onError = OpenshipColors.Light.ButtonPrimaryText,
    errorContainer = OpenshipColors.Light.StatusDangerBg,
    onErrorContainer = OpenshipColors.Light.StatusDangerFg
)

@Composable
fun OpenshipTheme(
    themeModeState: MutableState<ThemeMode> = remember { mutableStateOf(ThemeMode.DARK) },
    content: @Composable () -> Unit
) {
    val isSystemDark = isSystemInDarkTheme()
    val activeMode = when (themeModeState.value) {
        ThemeMode.DARK -> ThemeMode.DARK
        ThemeMode.DIM -> ThemeMode.DIM
        ThemeMode.LIGHT -> ThemeMode.LIGHT
        ThemeMode.SYSTEM -> if (isSystemDark) ThemeMode.DARK else ThemeMode.LIGHT
    }

    val customColors = when (activeMode) {
        ThemeMode.DARK -> darkOpenshipColors()
        ThemeMode.DIM -> dimOpenshipColors()
        ThemeMode.LIGHT, ThemeMode.SYSTEM -> lightOpenshipColors()
    }

    val colorScheme = when (activeMode) {
        ThemeMode.DARK -> OpenshipDarkColorScheme
        ThemeMode.DIM -> OpenshipDimColorScheme
        ThemeMode.LIGHT, ThemeMode.SYSTEM -> OpenshipLightColorScheme
    }

    PlatformSystemBars(isDark = customColors.isDark)

    CompositionLocalProvider(
        LocalOpenshipColors provides customColors,
        LocalThemeMode provides themeModeState
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            content = content
        )
    }
}

object OpenshipAppTheme {
    val colors: OpenshipCustomColors
        @Composable
        @ReadOnlyComposable
        get() = LocalOpenshipColors.current
}

