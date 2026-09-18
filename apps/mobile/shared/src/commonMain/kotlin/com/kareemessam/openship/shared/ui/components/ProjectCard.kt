package com.kareemessam.openship.shared.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kareemessam.openship.shared.model.ProjectStatus
import com.kareemessam.openship.shared.model.ProjectSummary
import com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme

@Composable
fun ProjectCard(
    project: ProjectSummary,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    mcpRedeployAvailable: Boolean = false,
    onRedeployClick: () -> Unit = {},
    onHistoryClick: () -> Unit = {}
) {
    val colors = OpenshipAppTheme.colors
    val statusKind = when (project.status) {
        ProjectStatus.READY -> StatusKind.SUCCESS
        ProjectStatus.BUILDING, ProjectStatus.QUEUED -> StatusKind.WARNING
        ProjectStatus.FAILED -> StatusKind.DANGER
        ProjectStatus.STOPPED -> StatusKind.NEUTRAL
        ProjectStatus.UNKNOWN -> StatusKind.INFO
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.bgCard)
            .border(1.dp, colors.borderCard, RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(16.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            // Top Row: Framework Icon Tile + Project Title & Subtitle + Status Badge
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                // Framework Tile
                Box(
                    modifier = Modifier
                        .size(38.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(colors.bgSubtle)
                        .border(1.dp, colors.borderSubtle, RoundedCornerShape(10.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    FrameworkIcon(
                        framework = project.framework,
                        size = 22.dp
                    )
                }

                Column(modifier = Modifier.weight(1f)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Text(
                            text = project.name,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.textHeading,
                            fontSize = 15.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp)
                    ) {
                        Text(
                            text = project.framework.replaceFirstChar { it.uppercase() },
                            fontSize = 11.sp,
                            color = colors.textMuted,
                            fontWeight = FontWeight.Medium
                        )
                        Text(
                            text = "·",
                            fontSize = 11.sp,
                            color = colors.textGhost
                        )
                        Text(
                            text = "Production",
                            fontSize = 11.sp,
                            color = colors.textMuted
                        )
                    }
                }

                StatusBadge(
                    text = project.statusText,
                    kind = statusKind,
                    pulseDot = project.status == ProjectStatus.BUILDING || project.status == ProjectStatus.READY,
                    compact = true
                )
            }

            // Git & Branch Pill
            if (!project.gitRepo.isNullOrBlank() || !project.gitBranch.isNullOrBlank()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(colors.bgSubtle)
                        .border(1.dp, colors.borderSubtle, RoundedCornerShape(8.dp))
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.CallSplit,
                        contentDescription = "Branch",
                        tint = colors.textSecondary,
                        modifier = Modifier.size(13.dp)
                    )
                    Text(
                        text = project.gitBranch ?: "main",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.textStrong,
                        fontFamily = FontFamily.Monospace
                    )
                    if (!project.gitRepo.isNullOrBlank()) {
                        Text(
                            text = "· ${project.gitRepo}",
                            fontSize = 11.sp,
                            color = colors.textMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
            }

            // Bottom Row: Live URL on left, Quick Actions (History, Redeploy, Logs) on right
            val portText = if (project.hostPort != null) ":${project.hostPort}" else ":8080"
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                // Host / Port indicator
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    modifier = Modifier.weight(1f, fill = false)
                ) {
                    Box(
                        modifier = Modifier
                            .size(5.dp)
                            .clip(CircleShape)
                            .background(if (project.status == ProjectStatus.READY) colors.statusActive else colors.textMuted)
                    )
                    Text(
                        text = "localhost$portText",
                        fontSize = 11.sp,
                        color = colors.textSecondary,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                // Action Buttons
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    // History Icon Button
                    IconButton(
                        onClick = onHistoryClick,
                        modifier = Modifier.size(28.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.History,
                            contentDescription = "Deployment history",
                            tint = colors.textMuted,
                            modifier = Modifier.size(15.dp)
                        )
                    }

                    // Redeploy Icon Button (if MCP available)
                    if (mcpRedeployAvailable) {
                        IconButton(
                            onClick = onRedeployClick,
                            modifier = Modifier.size(28.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Refresh,
                                contentDescription = "Redeploy",
                                tint = colors.textMuted,
                                modifier = Modifier.size(15.dp)
                            )
                        }
                    }

                    // View Logs Pill
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .background(colors.bgSubtle)
                            .border(1.dp, colors.borderSubtle, RoundedCornerShape(6.dp))
                            .clickable(onClick = onClick)
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Text(
                            text = "Logs",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.textHeading
                        )
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
                            contentDescription = "View Logs",
                            tint = colors.textMuted,
                            modifier = Modifier.size(11.dp)
                        )
                    }
                }
            }
        }
    }
}

private fun getFrameworkEmoji(framework: String): String {
    return when (framework.lowercase()) {
        "springboot", "spring", "java" -> "🍃"
        "docker", "compose" -> "🐳"
        "nextjs", "next" -> "▲"
        "react" -> "⚛️"
        "vue", "nuxt" -> "💚"
        "svelte", "sveltekit" -> "🟧"
        "nodejs", "node", "express" -> "🟢"
        "python", "django", "fastapi", "flask" -> "🐍"
        "go", "golang" -> "🔵"
        "rust" -> "🦀"
        "ruby", "rails" -> "💎"
        "php", "laravel" -> "🐘"
        "dotnet", "blazor" -> "🟣"
        else -> "📦"
    }
}

