package com.kareemessam.openship.shared.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

object OpenshipColors {

    // ── Dark Theme Tokens (Hard pure-black #000000) ──────────────────
    object Dark {
        val BgPage = Color(0xFF000000)
        val BgCard = Color(0xFF0A0A0A)
        val BgCardElevated = Color(0xFF141414)
        val BgPill = Color(0xFF161616)
        val BgSubtle = Color(0x06FFFFFF) // 2.5% white
        val BgHover = Color(0x0AFFFFFF) // 4% white
        val BgTerminal = Color(0xFF080808)

        val TextHeading = Color(0xFFFFFFFF)
        val TextTitle = Color(0xF2FFFFFF) // 95% white
        val TextStrong = Color(0xD9FFFFFF) // 85% white
        val TextBody = Color(0xA8FFFFFF) // 66% white
        val TextSecondary = Color(0x94FFFFFF) // 58% white
        val TextMuted = Color(0x80FFFFFF) // 50% white
        val TextHint = Color(0x5CFFFFFF) // 36% white
        val TextGhost = Color(0x38FFFFFF) // 22% white

        val BorderDefault = Color(0x14FFFFFF) // 8% white
        val BorderSubtle = Color(0x0DFFFFFF) // 5% white
        val BorderCard = Color(0x12FFFFFF) // 7% white
        val BorderStrong = Color(0x24FFFFFF) // 14% white

        val InputBorder = Color(0x14FFFFFF)
        val InputBorderFocus = Color(0x2EFFFFFF) // 18% white
        val InputBg = Color(0x08FFFFFF) // 3% white
        val InputBgFocus = Color(0x0DFFFFFF) // 5% white

        val ButtonPrimaryBg = Color(0xFFFFFFFF)
        val ButtonPrimaryText = Color(0xFF000000)
        val ButtonGhostBorder = Color(0x1AFFFFFF) // 10% white

        // Status Tokens
        val StatusSuccessFg = Color(0xFF34D399)
        val StatusSuccessBg = Color(0x1A10B981)
        val StatusSuccessBd = Color(0x3310B981)
        val StatusSuccessSolid = Color(0xFF10B981)

        val StatusDangerFg = Color(0xFFF04848)
        val StatusDangerBg = Color(0x1AEF4444)
        val StatusDangerBd = Color(0x33EF4444)
        val StatusDangerSolid = Color(0xFFEF4444)

        val StatusWarningFg = Color(0xFFFBBF24)
        val StatusWarningBg = Color(0x1AF59E0B)
        val StatusWarningBd = Color(0x33F59E0B)
        val StatusWarningSolid = Color(0xFFF59E0B)

        val StatusInfoFg = Color(0xFF60A5FA)
        val StatusInfoBg = Color(0x1A3B82F6)
        val StatusInfoBd = Color(0x333B82F6)
        val StatusInfoSolid = Color(0xFF3B82F6)

        val StatusNeutralFg = Color(0x80FFFFFF)
        val StatusNeutralBg = Color(0x0DFFFFFF)
        val StatusNeutralBd = Color(0x1AFFFFFF)
        val StatusNeutralSolid = Color(0xFF8B8F98)
    }

    // ── Dim Theme Tokens (Neutral Slate Gray #141414) ───────────────
    object Dim {
        val BgPage = Color(0xFF141414)
        val BgCard = Color(0xFF1E1E1E)
        val BgCardElevated = Color(0xFF282828)
        val BgPill = Color(0xFF262626)
        val BgSubtle = Color(0x08FFFFFF) // 3% white
        val BgHover = Color(0x0DFFFFFF) // 5% white
        val BgTerminal = Color(0xFF121212)

        val TextHeading = Color(0xFFFFFFFF)
        val TextTitle = Color(0xF2FFFFFF) // 95% white
        val TextStrong = Color(0xDBFFFFFF) // 86% white
        val TextBody = Color(0xB8FFFFFF) // 72% white
        val TextSecondary = Color(0xA8FFFFFF) // 66% white
        val TextMuted = Color(0x94FFFFFF) // 58% white
        val TextHint = Color(0x75FFFFFF) // 46% white
        val TextGhost = Color(0x4DFFFFFF) // 30% white

        val BorderDefault = Color(0x14FFFFFF) // 8% white
        val BorderSubtle = Color(0x0FFFFFFF) // 6% white
        val BorderCard = Color(0x14FFFFFF) // 8% white
        val BorderStrong = Color(0x24FFFFFF) // 14% white

        val InputBorder = Color(0x1AFFFFFF) // 10% white
        val InputBorderFocus = Color(0x38FFFFFF) // 22% white
        val InputBg = Color(0x0AFFFFFF) // 4% white
        val InputBgFocus = Color(0x0FFFFFFF) // 6% white

        val ButtonPrimaryBg = Color(0xFFFFFFFF)
        val ButtonPrimaryText = Color(0xFF000000)
        val ButtonGhostBorder = Color(0x24FFFFFF) // 14% white

        // Status Tokens (Dim: softer, warmer)
        val StatusSuccessFg = Color(0xFFD6F586) // hsl(86 82% 74%)
        val StatusSuccessBg = Color(0x269ED43A)
        val StatusSuccessBd = Color(0x47A8D64E)
        val StatusSuccessSolid = Color(0xFFA6D94A)

        val StatusDangerFg = Color(0xFFF77265) // hsl(4 82% 67%)
        val StatusDangerBg = Color(0x33E64333)
        val StatusDangerBd = Color(0x57EC594B)
        val StatusDangerSolid = Color(0xFFE84E40)

        val StatusWarningFg = Color(0xFFF6C25B) // hsl(40 78% 63%)
        val StatusWarningBg = Color(0x29E69619)
        val StatusWarningBd = Color(0x4DEB9E2B)
        val StatusWarningSolid = Color(0xFFE59828)

        val StatusInfoFg = Color(0xFF86B4F5) // hsl(214 72% 72%)
        val StatusInfoBg = Color(0x293D83EB)
        val StatusInfoBd = Color(0x4D5293F0)
        val StatusInfoSolid = Color(0xFF4F8EEB)

        val StatusNeutralFg = Color(0xB3FFFFFF)
        val StatusNeutralBg = Color(0x17FFFFFF)
        val StatusNeutralBd = Color(0x2EFFFFFF)
        val StatusNeutralSolid = Color(0x6BFFFFFF)
    }

    // ── Light Theme Tokens (Clean crisp #F9F9F9 / #FFFFFF) ──────────
    object Light {
        val BgPage = Color(0xFFF9F9F9)
        val BgCard = Color(0xFFFFFFFF)
        val BgCardElevated = Color(0xFFFFFFFF)
        val BgPill = Color(0xFFF3F4F6)
        val BgSubtle = Color(0x05000000) // 2% black
        val BgHover = Color(0x06000000) // 2.5% black
        val BgTerminal = Color(0xFF0D1117)

        val TextHeading = Color(0xFF000000)
        val TextTitle = Color(0xEB000000) // 92% black
        val TextStrong = Color(0xD1000000) // 82% black
        val TextBody = Color(0xA8000000) // 66% black
        val TextSecondary = Color(0x94000000) // 58% black
        val TextMuted = Color(0x85000000) // 52% black
        val TextHint = Color(0x75000000) // 46% black
        val TextGhost = Color(0x38000000) // 22% black

        val BorderDefault = Color(0xFFE8E8E8)
        val BorderSubtle = Color(0xFFF0F0F0)
        val BorderCard = Color(0xFFEAEAEA)
        val BorderStrong = Color(0xFFD0D0D0)

        val InputBorder = Color(0xFFE0E0E0)
        val InputBorderFocus = Color(0xFFB0B0B0)
        val InputBg = Color(0xFFFFFFFF)
        val InputBgFocus = Color(0xFFFFFFFF)

        val ButtonPrimaryBg = Color(0xEB000000) // 92% black
        val ButtonPrimaryText = Color(0xFFFFFFFF)
        val ButtonGhostBorder = Color(0xFFE0E0E0)

        // Status Tokens
        val StatusSuccessFg = Color(0xFF059669)
        val StatusSuccessBg = Color(0x1A10B981)
        val StatusSuccessBd = Color(0x3310B981)
        val StatusSuccessSolid = Color(0xFF10B981)

        val StatusDangerFg = Color(0xFFDC2626)
        val StatusDangerBg = Color(0x1AEF4444)
        val StatusDangerBd = Color(0x33EF4444)
        val StatusDangerSolid = Color(0xFFEF4444)

        val StatusWarningFg = Color(0xFFD97706)
        val StatusWarningBg = Color(0x1AF59E0B)
        val StatusWarningBd = Color(0x33F59E0B)
        val StatusWarningSolid = Color(0xFFF59E0B)

        val StatusInfoFg = Color(0xFF2563EB)
        val StatusInfoBg = Color(0x1A3B82F6)
        val StatusInfoBd = Color(0x333B82F6)
        val StatusInfoSolid = Color(0xFF3B82F6)

        val StatusNeutralFg = Color(0xFF52525B)
        val StatusNeutralBg = Color(0xFFF4F4F5)
        val StatusNeutralBd = Color(0xFFE4E4E7)
        val StatusNeutralSolid = Color(0xFF9CA3AF)
    }
}

@Immutable
data class StatusStyle(
    val fg: Color,
    val bg: Color,
    val border: Color,
    val solid: Color
)

@Immutable
data class OpenshipCustomColors(
    val themeMode: ThemeMode = ThemeMode.DARK,
    val isDark: Boolean = true,
    val bgPage: Color = OpenshipColors.Dark.BgPage,
    val bgCard: Color = OpenshipColors.Dark.BgCard,
    val bgCardElevated: Color = OpenshipColors.Dark.BgCardElevated,
    val bgPill: Color = OpenshipColors.Dark.BgPill,
    val bgSubtle: Color = OpenshipColors.Dark.BgSubtle,
    val bgHover: Color = OpenshipColors.Dark.BgHover,
    val bgTerminal: Color = OpenshipColors.Dark.BgTerminal,
    val borderCard: Color = OpenshipColors.Dark.BorderCard,
    val borderDefault: Color = OpenshipColors.Dark.BorderDefault,
    val borderSubtle: Color = OpenshipColors.Dark.BorderSubtle,
    val borderStrong: Color = OpenshipColors.Dark.BorderStrong,
    val borderInput: Color = OpenshipColors.Dark.InputBorder,
    val borderFocus: Color = OpenshipColors.Dark.InputBorderFocus,
    val inputBg: Color = OpenshipColors.Dark.InputBg,
    val btnPrimaryBg: Color = OpenshipColors.Dark.ButtonPrimaryBg,
    val btnPrimaryText: Color = OpenshipColors.Dark.ButtonPrimaryText,
    val btnGhostBorder: Color = OpenshipColors.Dark.ButtonGhostBorder,
    val textHeading: Color = OpenshipColors.Dark.TextHeading,
    val textPrimary: Color = OpenshipColors.Dark.TextTitle,
    val textStrong: Color = OpenshipColors.Dark.TextStrong,
    val textBody: Color = OpenshipColors.Dark.TextBody,
    val textSecondary: Color = OpenshipColors.Dark.TextSecondary,
    val textMuted: Color = OpenshipColors.Dark.TextMuted,
    val textHint: Color = OpenshipColors.Dark.TextHint,
    val textGhost: Color = OpenshipColors.Dark.TextGhost,
    val statusActive: Color = OpenshipColors.Dark.StatusSuccessSolid,
    val statusFailed: Color = OpenshipColors.Dark.StatusDangerSolid,
    val statusFailedBorder: Color = OpenshipColors.Dark.StatusDangerBd,
    val success: StatusStyle = StatusStyle(
        OpenshipColors.Dark.StatusSuccessFg,
        OpenshipColors.Dark.StatusSuccessBg,
        OpenshipColors.Dark.StatusSuccessBd,
        OpenshipColors.Dark.StatusSuccessSolid
    ),
    val danger: StatusStyle = StatusStyle(
        OpenshipColors.Dark.StatusDangerFg,
        OpenshipColors.Dark.StatusDangerBg,
        OpenshipColors.Dark.StatusDangerBd,
        OpenshipColors.Dark.StatusDangerSolid
    ),
    val warning: StatusStyle = StatusStyle(
        OpenshipColors.Dark.StatusWarningFg,
        OpenshipColors.Dark.StatusWarningBg,
        OpenshipColors.Dark.StatusWarningBd,
        OpenshipColors.Dark.StatusWarningSolid
    ),
    val info: StatusStyle = StatusStyle(
        OpenshipColors.Dark.StatusInfoFg,
        OpenshipColors.Dark.StatusInfoBg,
        OpenshipColors.Dark.StatusInfoBd,
        OpenshipColors.Dark.StatusInfoSolid
    ),
    val neutral: StatusStyle = StatusStyle(
        OpenshipColors.Dark.StatusNeutralFg,
        OpenshipColors.Dark.StatusNeutralBg,
        OpenshipColors.Dark.StatusNeutralBd,
        OpenshipColors.Dark.StatusNeutralSolid
    )
)

fun darkOpenshipColors(): OpenshipCustomColors = OpenshipCustomColors(
    themeMode = ThemeMode.DARK,
    isDark = true,
    bgPage = OpenshipColors.Dark.BgPage,
    bgCard = OpenshipColors.Dark.BgCard,
    bgCardElevated = OpenshipColors.Dark.BgCardElevated,
    bgPill = OpenshipColors.Dark.BgPill,
    bgSubtle = OpenshipColors.Dark.BgSubtle,
    bgHover = OpenshipColors.Dark.BgHover,
    bgTerminal = OpenshipColors.Dark.BgTerminal,
    borderCard = OpenshipColors.Dark.BorderCard,
    borderDefault = OpenshipColors.Dark.BorderDefault,
    borderSubtle = OpenshipColors.Dark.BorderSubtle,
    borderStrong = OpenshipColors.Dark.BorderStrong,
    borderInput = OpenshipColors.Dark.InputBorder,
    borderFocus = OpenshipColors.Dark.InputBorderFocus,
    inputBg = OpenshipColors.Dark.InputBg,
    btnPrimaryBg = OpenshipColors.Dark.ButtonPrimaryBg,
    btnPrimaryText = OpenshipColors.Dark.ButtonPrimaryText,
    btnGhostBorder = OpenshipColors.Dark.ButtonGhostBorder,
    textHeading = OpenshipColors.Dark.TextHeading,
    textPrimary = OpenshipColors.Dark.TextTitle,
    textStrong = OpenshipColors.Dark.TextStrong,
    textBody = OpenshipColors.Dark.TextBody,
    textSecondary = OpenshipColors.Dark.TextSecondary,
    textMuted = OpenshipColors.Dark.TextMuted,
    textHint = OpenshipColors.Dark.TextHint,
    textGhost = OpenshipColors.Dark.TextGhost,
    statusActive = OpenshipColors.Dark.StatusSuccessSolid,
    statusFailed = OpenshipColors.Dark.StatusDangerSolid,
    statusFailedBorder = OpenshipColors.Dark.StatusDangerBd,
    success = StatusStyle(OpenshipColors.Dark.StatusSuccessFg, OpenshipColors.Dark.StatusSuccessBg, OpenshipColors.Dark.StatusSuccessBd, OpenshipColors.Dark.StatusSuccessSolid),
    danger = StatusStyle(OpenshipColors.Dark.StatusDangerFg, OpenshipColors.Dark.StatusDangerBg, OpenshipColors.Dark.StatusDangerBd, OpenshipColors.Dark.StatusDangerSolid),
    warning = StatusStyle(OpenshipColors.Dark.StatusWarningFg, OpenshipColors.Dark.StatusWarningBg, OpenshipColors.Dark.StatusWarningBd, OpenshipColors.Dark.StatusWarningSolid),
    info = StatusStyle(OpenshipColors.Dark.StatusInfoFg, OpenshipColors.Dark.StatusInfoBg, OpenshipColors.Dark.StatusInfoBd, OpenshipColors.Dark.StatusInfoSolid),
    neutral = StatusStyle(OpenshipColors.Dark.StatusNeutralFg, OpenshipColors.Dark.StatusNeutralBg, OpenshipColors.Dark.StatusNeutralBd, OpenshipColors.Dark.StatusNeutralSolid)
)

fun dimOpenshipColors(): OpenshipCustomColors = OpenshipCustomColors(
    themeMode = ThemeMode.DIM,
    isDark = true,
    bgPage = OpenshipColors.Dim.BgPage,
    bgCard = OpenshipColors.Dim.BgCard,
    bgCardElevated = OpenshipColors.Dim.BgCardElevated,
    bgPill = OpenshipColors.Dim.BgPill,
    bgSubtle = OpenshipColors.Dim.BgSubtle,
    bgHover = OpenshipColors.Dim.BgHover,
    bgTerminal = OpenshipColors.Dim.BgTerminal,
    borderCard = OpenshipColors.Dim.BorderCard,
    borderDefault = OpenshipColors.Dim.BorderDefault,
    borderSubtle = OpenshipColors.Dim.BorderSubtle,
    borderStrong = OpenshipColors.Dim.BorderStrong,
    borderInput = OpenshipColors.Dim.InputBorder,
    borderFocus = OpenshipColors.Dim.InputBorderFocus,
    inputBg = OpenshipColors.Dim.InputBg,
    btnPrimaryBg = OpenshipColors.Dim.ButtonPrimaryBg,
    btnPrimaryText = OpenshipColors.Dim.ButtonPrimaryText,
    btnGhostBorder = OpenshipColors.Dim.ButtonGhostBorder,
    textHeading = OpenshipColors.Dim.TextHeading,
    textPrimary = OpenshipColors.Dim.TextTitle,
    textStrong = OpenshipColors.Dim.TextStrong,
    textBody = OpenshipColors.Dim.TextBody,
    textSecondary = OpenshipColors.Dim.TextSecondary,
    textMuted = OpenshipColors.Dim.TextMuted,
    textHint = OpenshipColors.Dim.TextHint,
    textGhost = OpenshipColors.Dim.TextGhost,
    statusActive = OpenshipColors.Dim.StatusSuccessSolid,
    statusFailed = OpenshipColors.Dim.StatusDangerSolid,
    statusFailedBorder = OpenshipColors.Dim.StatusDangerBd,
    success = StatusStyle(OpenshipColors.Dim.StatusSuccessFg, OpenshipColors.Dim.StatusSuccessBg, OpenshipColors.Dim.StatusSuccessBd, OpenshipColors.Dim.StatusSuccessSolid),
    danger = StatusStyle(OpenshipColors.Dim.StatusDangerFg, OpenshipColors.Dim.StatusDangerBg, OpenshipColors.Dim.StatusDangerBd, OpenshipColors.Dim.StatusDangerSolid),
    warning = StatusStyle(OpenshipColors.Dim.StatusWarningFg, OpenshipColors.Dim.StatusWarningBg, OpenshipColors.Dim.StatusWarningBd, OpenshipColors.Dim.StatusWarningSolid),
    info = StatusStyle(OpenshipColors.Dim.StatusInfoFg, OpenshipColors.Dim.StatusInfoBg, OpenshipColors.Dim.StatusInfoBd, OpenshipColors.Dim.StatusInfoSolid),
    neutral = StatusStyle(OpenshipColors.Dim.StatusNeutralFg, OpenshipColors.Dim.StatusNeutralBg, OpenshipColors.Dim.StatusNeutralBd, OpenshipColors.Dim.StatusNeutralSolid)
)

fun lightOpenshipColors(): OpenshipCustomColors = OpenshipCustomColors(
    themeMode = ThemeMode.LIGHT,
    isDark = false,
    bgPage = OpenshipColors.Light.BgPage,
    bgCard = OpenshipColors.Light.BgCard,
    bgCardElevated = OpenshipColors.Light.BgCardElevated,
    bgPill = OpenshipColors.Light.BgPill,
    bgSubtle = OpenshipColors.Light.BgSubtle,
    bgHover = OpenshipColors.Light.BgHover,
    bgTerminal = OpenshipColors.Light.BgTerminal,
    borderCard = OpenshipColors.Light.BorderCard,
    borderDefault = OpenshipColors.Light.BorderDefault,
    borderSubtle = OpenshipColors.Light.BorderSubtle,
    borderStrong = OpenshipColors.Light.BorderStrong,
    borderInput = OpenshipColors.Light.InputBorder,
    borderFocus = OpenshipColors.Light.InputBorderFocus,
    inputBg = OpenshipColors.Light.InputBg,
    btnPrimaryBg = OpenshipColors.Light.ButtonPrimaryBg,
    btnPrimaryText = OpenshipColors.Light.ButtonPrimaryText,
    btnGhostBorder = OpenshipColors.Light.ButtonGhostBorder,
    textHeading = OpenshipColors.Light.TextHeading,
    textPrimary = OpenshipColors.Light.TextTitle,
    textStrong = OpenshipColors.Light.TextStrong,
    textBody = OpenshipColors.Light.TextBody,
    textSecondary = OpenshipColors.Light.TextSecondary,
    textMuted = OpenshipColors.Light.TextMuted,
    textHint = OpenshipColors.Light.TextHint,
    textGhost = OpenshipColors.Light.TextGhost,
    statusActive = OpenshipColors.Light.StatusSuccessSolid,
    statusFailed = OpenshipColors.Light.StatusDangerSolid,
    statusFailedBorder = OpenshipColors.Light.StatusDangerBd,
    success = StatusStyle(OpenshipColors.Light.StatusSuccessFg, OpenshipColors.Light.StatusSuccessBg, OpenshipColors.Light.StatusSuccessBd, OpenshipColors.Light.StatusSuccessSolid),
    danger = StatusStyle(OpenshipColors.Light.StatusDangerFg, OpenshipColors.Light.StatusDangerBg, OpenshipColors.Light.StatusDangerBd, OpenshipColors.Light.StatusDangerSolid),
    warning = StatusStyle(OpenshipColors.Light.StatusWarningFg, OpenshipColors.Light.StatusWarningBg, OpenshipColors.Light.StatusWarningBd, OpenshipColors.Light.StatusWarningSolid),
    info = StatusStyle(OpenshipColors.Light.StatusInfoFg, OpenshipColors.Light.StatusInfoBg, OpenshipColors.Light.StatusInfoBd, OpenshipColors.Light.StatusInfoSolid),
    neutral = StatusStyle(OpenshipColors.Light.StatusNeutralFg, OpenshipColors.Light.StatusNeutralBg, OpenshipColors.Light.StatusNeutralBd, OpenshipColors.Light.StatusNeutralSolid)
)

val LocalOpenshipColors = staticCompositionLocalOf { OpenshipCustomColors() }

