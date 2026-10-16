package com.kareemessam.openship.shared.ui.screens.deployments

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kareemessam.openship.shared.model.DeploymentDto
import com.kareemessam.openship.shared.ui.components.StatusBadge
import com.kareemessam.openship.shared.ui.components.StatusKind
import com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme
import com.kareemessam.openship.shared.viewmodel.DeploymentHistoryUiState
import com.kareemessam.openship.shared.viewmodel.formatRelativeAge
import com.kareemessam.openship.shared.viewmodel.isRollbackEligible

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeploymentHistoryScreen(
    state: DeploymentHistoryUiState,
    onBack: () -> Unit,
    onSelect: (String) -> Unit,
    onRollback: (DeploymentDto) -> Unit,
    onRollbackConfirm: () -> Unit,
    onRollbackCancel: () -> Unit,
    onRollbackResultConsumed: () -> Unit,
    onOpenLogs: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = OpenshipAppTheme.colors

    // Route to the new deployment's logs once a rollback returns an id.
    LaunchedEffect(state.rollbackResultDeploymentId) {
        val deploymentId = state.rollbackResultDeploymentId
        if (deploymentId != null) {
            onOpenLogs(deploymentId)
            onRollbackResultConsumed()
        }
    }

    state.rollbackTarget?.let { target ->
        if (state.rollbackResultDeploymentId == null) {
            val activeDeployment = state.deployments.firstOrNull { it.id == state.activeDeploymentId }
            RollbackConfirmDialog(
                target = target,
                activeDeployment = activeDeployment,
                isLoading = state.rollbackLoading,
                error = state.rollbackError,
                onConfirm = onRollbackConfirm,
                onCancel = onRollbackCancel
            )
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

                        Column {
                            Text(
                                text = "Deployment History",
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 15.sp,
                                color = colors.textHeading
                            )
                            Text(
                                text = "${state.deployments.size} deployment${if (state.deployments.size == 1) "" else "s"}",
                                fontSize = 11.sp,
                                color = colors.textMuted
                            )
                        }
                    }

                    if (state.selectedDeploymentId != null) {
                        TextButton(onClick = onDismiss) {
                            Text("Clear", color = colors.textSecondary, fontSize = 12.sp)
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
        },
        containerColor = colors.bgPage,
        modifier = modifier
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            when {
                state.isLoading -> {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center
                    ) {
                        CircularProgressIndicator(
                            color = colors.btnPrimaryBg,
                            modifier = Modifier.size(32.dp)
                        )
                    }
                }
                state.error != null -> {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .background(colors.bgCard)
                            .border(1.dp, colors.statusFailedBorder, RoundedCornerShape(14.dp))
                            .padding(20.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.ErrorOutline,
                                contentDescription = "Error",
                                tint = colors.statusFailed,
                                modifier = Modifier.size(32.dp)
                            )
                            Text(
                                text = "Failed to load history",
                                fontWeight = FontWeight.Bold,
                                color = colors.textHeading,
                                fontSize = 15.sp
                            )
                            Text(
                                text = state.error,
                                color = colors.textSecondary,
                                fontSize = 12.sp
                            )
                        }
                    }
                }
                state.deployments.isEmpty() -> {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .background(colors.bgCard)
                            .border(1.dp, colors.borderCard, RoundedCornerShape(14.dp))
                            .padding(28.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.History,
                                contentDescription = "Empty",
                                tint = colors.textGhost,
                                modifier = Modifier.size(36.dp)
                            )
                            Text(
                                text = "No prior deployments",
                                fontWeight = FontWeight.SemiBold,
                                color = colors.textHeading,
                                fontSize = 14.sp
                            )
                            Text(
                                text = "Deployments for this project will appear here.",
                                color = colors.textMuted,
                                fontSize = 12.sp
                            )
                        }
                    }
                }
                else -> {
                    LazyColumn(
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        contentPadding = PaddingValues(bottom = 20.dp),
                        modifier = Modifier.fillMaxSize()
                    ) {
                        items(
                            items = state.deployments,
                            key = { it.id }
                        ) { deployment ->
                            DeploymentHistoryRow(
                                deployment = deployment,
                                isSelected = state.selectedDeploymentId == deployment.id,
                                canRollback = state.rollbackAvailable &&
                                    isRollbackEligible(deployment, state.activeDeploymentId),
                                onClick = { onSelect(deployment.id) },
                                onRollback = { onRollback(deployment) }
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RollbackConfirmDialog(
    target: DeploymentDto,
    activeDeployment: DeploymentDto?,
    isLoading: Boolean,
    error: String?,
    onConfirm: () -> Unit,
    onCancel: () -> Unit
) {
    val colors = OpenshipAppTheme.colors
    AlertDialog(
        onDismissRequest = onCancel,
        title = {
            Text("Rollback deployment?", fontWeight = FontWeight.Bold, fontSize = 16.sp, color = colors.warning.solid)
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "Rollback to ${target.commitSha?.take(7) ?: "—"} — " +
                        "${target.commitMessage ?: "no message"} · ${formatRelativeAge(target.createdAt)}",
                    fontSize = 13.sp,
                    color = colors.textHeading
                )
                Text(
                    text = if (activeDeployment != null) {
                        "This will replace the current active deployment (${activeDeployment.commitSha?.take(7) ?: "—"})."
                    } else {
                        "This will replace the current active deployment."
                    },
                    fontSize = 12.sp,
                    color = colors.warning.solid
                )
                Text(
                    text = "This action will trigger a new build from this commit.",
                    fontSize = 12.sp,
                    color = colors.textSecondary
                )
                if (error != null) {
                    Text(
                        text = error,
                        fontSize = 12.sp,
                        color = colors.statusFailed
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                enabled = !isLoading,
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.warning.solid,
                    contentColor = colors.bgPage
                )
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        color = colors.bgPage,
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(16.dp)
                    )
                } else {
                    Text("Rollback", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel, enabled = !isLoading) {
                Text("Cancel", fontSize = 12.sp, color = colors.textSecondary)
            }
        },
        containerColor = colors.bgCard,
        shape = RoundedCornerShape(16.dp)
    )
}

@Composable
private fun DeploymentHistoryRow(
    deployment: DeploymentDto,
    isSelected: Boolean,
    canRollback: Boolean,
    onClick: () -> Unit,
    onRollback: () -> Unit
) {
    val colors = OpenshipAppTheme.colors

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.bgCard)
            .border(
                1.dp,
                if (isSelected) colors.borderFocus else colors.borderCard,
                RoundedCornerShape(14.dp)
            )
            .clickable(onClick = onClick)
            .padding(14.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                StatusBadge(
                    text = (deployment.status ?: "unknown").replaceFirstChar { it.uppercase() },
                    kind = statusToKind(deployment.status),
                    pulseDot = false,
                    compact = true
                )
                Text(
                    text = formatRelativeAge(deployment.createdAt),
                    fontSize = 11.sp,
                    color = colors.textMuted,
                    fontFamily = FontFamily.Monospace
                )
            }

            // Git info chip
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(6.dp))
                    .background(colors.bgSubtle)
                    .border(1.dp, colors.borderSubtle, RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.CallSplit,
                    contentDescription = null,
                    tint = colors.textSecondary,
                    modifier = Modifier.size(12.dp)
                )
                Text(
                    text = deployment.commitSha?.take(7) ?: "—",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.textHeading,
                    fontFamily = FontFamily.Monospace
                )
                if (!deployment.branch.isNullOrBlank()) {
                    Text(
                        text = "· ${deployment.branch}",
                        fontSize = 11.sp,
                        color = colors.textMuted
                    )
                }
            }

            if (!deployment.commitMessage.isNullOrBlank()) {
                Text(
                    text = deployment.commitMessage,
                    fontSize = 12.sp,
                    color = colors.textSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }

            if (canRollback) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End
                ) {
                    Button(
                        onClick = onRollback,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.btnPrimaryBg,
                            contentColor = colors.btnPrimaryText
                        ),
                        shape = RoundedCornerShape(6.dp),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Restore,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp)
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("Rollback", fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

private fun statusToKind(status: String?): StatusKind = when (status?.lowercase()) {
    "ready", "success", "active", "healthy", "up" -> StatusKind.SUCCESS
    "building", "deploying", "queued" -> StatusKind.WARNING
    "failed", "error", "crashed" -> StatusKind.DANGER
    "cancelled", "stopped" -> StatusKind.NEUTRAL
    else -> StatusKind.INFO
}

