package com.kareemessam.openship.shared.ui.screens.logs

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.kareemessam.openship.shared.ui.components.StatusBadge
import com.kareemessam.openship.shared.ui.components.StatusKind
import com.kareemessam.openship.shared.ui.components.TerminalWindowDots
import com.kareemessam.openship.shared.ui.theme.LocalThemeMode
import com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme
import com.kareemessam.openship.shared.ui.theme.ThemeMode
import com.kareemessam.openship.shared.viewmodel.BuildStage
import com.kareemessam.openship.shared.viewmodel.DeployLogsUiState
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeployLogsScreen(
    state: DeployLogsUiState,
    onBack: () -> Unit,
    onSearchChanged: (String) -> Unit,
    onAutoScrollChanged: (Boolean) -> Unit,
    onRetry: () -> Unit,
    onResumeStream: () -> Unit = {},
    onPauseStream: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    val colors = OpenshipAppTheme.colors
    val themeModeState = LocalThemeMode.current
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()

    LifecycleResumeEffect(Unit) {
        onResumeStream()
        onPauseOrDispose {
            onPauseStream()
        }
    }

    val displayedLogs = remember(state.logs, state.searchQuery) {
        if (state.searchQuery.isBlank()) {
            state.logs
        } else {
            state.logs.filter {
                it.rawText.contains(state.searchQuery, ignoreCase = true) ||
                (it.serviceName?.contains(state.searchQuery, ignoreCase = true) == true)
            }
        }
    }

    // Auto-scroll effect controlled strictly by autoScroll flag
    LaunchedEffect(displayedLogs.size, state.autoScroll) {
        if (state.autoScroll && displayedLogs.isNotEmpty()) {
            listState.scrollToItem(displayedLogs.size - 1)
        }
    }

    Scaffold(
        topBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgPage)
                    .statusBarsPadding()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.weight(1f)
                    ) {
                        IconButton(
                            onClick = onBack,
                            modifier = Modifier.size(32.dp)
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = "Back",
                                tint = colors.textHeading,
                                modifier = Modifier.size(18.dp)
                            )
                        }

                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = state.projectName.ifBlank { "Deployment Logs" },
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 15.sp,
                                color = colors.textHeading,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            Text(
                                text = state.deploymentId.ifBlank { "Live Stream" },
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace,
                                color = colors.textMuted
                            )
                        }
                    }

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        // Auto-Scroll Toggle Button
                        IconButton(
                            onClick = { onAutoScrollChanged(!state.autoScroll) },
                            modifier = Modifier.size(32.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.VerticalAlignBottom,
                                contentDescription = "Auto Scroll",
                                tint = if (state.autoScroll) colors.statusActive else colors.textMuted,
                                modifier = Modifier.size(16.dp)
                            )
                        }

                        // Status Badge
                        val statusKind = when (state.finalStatus?.lowercase()) {
                            "ready", "active", "success" -> StatusKind.SUCCESS
                            "failed", "error" -> StatusKind.DANGER
                            "cancelled" -> StatusKind.NEUTRAL
                            else -> if (state.isStreaming) StatusKind.WARNING else StatusKind.INFO
                        }
                        val statusText = when {
                            state.finalStatus != null -> state.finalStatus.replaceFirstChar { it.uppercase() }
                            state.isStreaming -> "Live"
                            else -> "Connected"
                        }
                        StatusBadge(
                            text = statusText,
                            kind = statusKind,
                            pulseDot = state.isStreaming,
                            compact = true
                        )
                    }
                }

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(colors.borderSubtle)
                )
            }
        },
        containerColor = colors.bgPage,
        modifier = modifier
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            // Build Stage Stepper Header
            BuildStageStepper(
                currentStage = state.currentStage,
                isStreaming = state.isStreaming
            )

            // Search Bar & Stats
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedTextField(
                    value = state.searchQuery,
                    onValueChange = onSearchChanged,
                    placeholder = {
                        Text("Filter logs...", fontSize = 12.sp, color = colors.textMuted)
                    },
                    leadingIcon = {
                        Icon(
                            imageVector = Icons.Default.Search,
                            contentDescription = "Search",
                            tint = colors.textMuted,
                            modifier = Modifier.size(14.dp)
                        )
                    },
                    trailingIcon = {
                        if (state.searchQuery.isNotEmpty()) {
                            IconButton(onClick = { onSearchChanged("") }) {
                                Icon(
                                    imageVector = Icons.Default.Clear,
                                    contentDescription = "Clear",
                                    tint = colors.textMuted,
                                    modifier = Modifier.size(14.dp)
                                )
                            }
                        }
                    },
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(8.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = colors.inputBg,
                        unfocusedContainerColor = colors.inputBg,
                        focusedBorderColor = colors.borderFocus,
                        unfocusedBorderColor = colors.borderInput,
                        focusedTextColor = colors.textHeading,
                        unfocusedTextColor = colors.textPrimary
                    ),
                    singleLine = true
                )

                // Log line counter pill
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(colors.bgSubtle)
                        .border(1.dp, colors.borderSubtle, RoundedCornerShape(8.dp))
                        .padding(horizontal = 10.dp, vertical = 8.dp)
                ) {
                    Text(
                        text = "${displayedLogs.size} lines",
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                        color = colors.textMuted
                    )
                }
            }

            // Developer Terminal Window
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(colors.bgTerminal)
                    .border(1.dp, colors.borderCard, RoundedCornerShape(12.dp))
            ) {
                // Titlebar Header
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(if (colors.isDark) Color(0xFF0C0C0C) else Color(0xFF18181B))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    TerminalWindowDots()

                    Text(
                        text = "terminal · build output",
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        color = Color(0xFF9CA3AF)
                    )

                    Spacer(modifier = Modifier.width(32.dp))
                }

                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                ) {
                    if (displayedLogs.isEmpty() && !state.isStreaming) {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Terminal,
                                    contentDescription = "Terminal",
                                    tint = colors.textMuted,
                                    modifier = Modifier.size(32.dp)
                                )
                                Text(
                                    text = if (state.error != null) "Log Stream Offline" else "Waiting for container stream...",
                                    color = Color(0xFF9CA3AF),
                                    fontSize = 12.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                                if (state.error != null) {
                                    Text(
                                        text = state.error,
                                        color = colors.statusFailed,
                                        fontSize = 11.sp
                                    )
                                    Button(
                                        onClick = onRetry,
                                        colors = ButtonDefaults.buttonColors(
                                            containerColor = colors.btnPrimaryBg,
                                            contentColor = colors.btnPrimaryText
                                        ),
                                        shape = RoundedCornerShape(6.dp)
                                    ) {
                                        Text("Reconnect", fontSize = 11.sp)
                                    }
                                }
                            }
                        }
                    } else {
                        LazyColumn(
                            state = listState,
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(3.dp)
                        ) {
                            itemsIndexed(
                                items = displayedLogs,
                                key = { _, item -> item.id }
                            ) { index, item ->
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalAlignment = Alignment.Top
                                ) {
                                    // Line Number
                                    Text(
                                        text = "${index + 1}".padStart(4, ' '),
                                        fontSize = 11.sp,
                                        fontFamily = FontFamily.Monospace,
                                        color = Color(0xFF4B5563),
                                        modifier = Modifier.width(32.dp)
                                    )

                                    // Log Text with ANSI Colors
                                    Text(
                                        text = item.parsedText,
                                        fontSize = 11.sp,
                                        fontFamily = FontFamily.Monospace,
                                        lineHeight = 16.sp,
                                        color = Color(0xFFE5E7EB),
                                        modifier = Modifier.weight(1f)
                                    )
                                }
                            }
                        }
                    }

                    // Floating Auto-Scroll Resume Button
                    if (!state.autoScroll && displayedLogs.isNotEmpty()) {
                        FloatingActionButton(
                            onClick = {
                                onAutoScrollChanged(true)
                                coroutineScope.launch {
                                    listState.animateScrollToItem(displayedLogs.size - 1)
                                }
                            },
                            containerColor = colors.bgCardElevated,
                            contentColor = colors.textHeading,
                            shape = CircleShape,
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .padding(14.dp)
                                .size(36.dp)
                                .border(1.dp, colors.borderSubtle, CircleShape)
                        ) {
                            Icon(
                                imageVector = Icons.Default.KeyboardArrowDown,
                                contentDescription = "Scroll to bottom",
                                modifier = Modifier.size(18.dp)
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BuildStageStepper(
    currentStage: BuildStage,
    isStreaming: Boolean,
    modifier: Modifier = Modifier
) {
    val colors = OpenshipAppTheme.colors
    val stages = listOf(
        BuildStage.CLONE to "Clone",
        BuildStage.INSTALL to "Install",
        BuildStage.BUILD to "Build",
        BuildStage.DEPLOY to "Deploy",
        BuildStage.READY to "Ready"
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(colors.bgCard)
            .border(1.dp, colors.borderCard, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        stages.forEachIndexed { index, (stage, label) ->
            val isPassed = stage.ordinal < currentStage.ordinal
            val isCurrent = stage == currentStage

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(
                            when {
                                isPassed -> colors.statusActive
                                isCurrent -> if (isStreaming) colors.warning.solid else colors.statusActive
                                else -> colors.neutral.solid
                            }
                        )
                )
                Text(
                    text = label,
                    fontSize = 11.sp,
                    fontWeight = if (isCurrent) FontWeight.Bold else FontWeight.Normal,
                    color = when {
                        isPassed || isCurrent -> colors.textHeading
                        else -> colors.textMuted
                    }
                )
            }

            if (index < stages.size - 1) {
                Text(
                    text = "→",
                    fontSize = 11.sp,
                    color = colors.textGhost
                )
            }
        }
    }
}

