package com.kareemessam.openship.shared.ui.screens.connect

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kareemessam.openship.shared.ui.components.OpenshipBrandLogo
import com.kareemessam.openship.shared.ui.components.StatusBadge
import com.kareemessam.openship.shared.ui.components.StatusKind
import com.kareemessam.openship.shared.ui.theme.LocalThemeMode
import com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme
import com.kareemessam.openship.shared.ui.theme.ThemeMode
import com.kareemessam.openship.shared.viewmodel.ConnectUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectScreen(
    state: ConnectUiState,
    onUrlChanged: (String) -> Unit,
    onLabelChanged: (String) -> Unit,
    onPatChanged: (String) -> Unit,
    onProbeClicked: () -> Unit,
    onConnectClicked: () -> Unit,
    onSuccess: () -> Unit,
    modifier: Modifier = Modifier
) {
    var showPat by remember { mutableStateOf(false) }
    val colors = OpenshipAppTheme.colors
    val themeModeState = LocalThemeMode.current

    LaunchedEffect(state.isSuccess) {
        if (state.isSuccess) {
            onSuccess()
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
                        .padding(horizontal = 18.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OpenshipBrandLogo()

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
                            contentDescription = "Toggle Theme",
                            tint = colors.textSecondary,
                            modifier = Modifier.size(16.dp)
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
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Hero Card
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(colors.bgCard)
                    .border(1.dp, colors.borderCard, RoundedCornerShape(14.dp))
                    .padding(18.dp)
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "Connect Server",
                        fontWeight = FontWeight.Bold,
                        fontSize = 17.sp,
                        color = colors.textHeading
                    )
                    Text(
                        text = "Connect to your self-hosted Openship instance to manage deployments and monitor server telemetry.",
                        fontSize = 12.sp,
                        color = colors.textSecondary,
                        lineHeight = 17.sp
                    )
                }
            }

            // Connection Form Card
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(colors.bgCard)
                    .border(1.dp, colors.borderCard, RoundedCornerShape(14.dp))
                    .padding(18.dp)
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    // Instance URL Field
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            text = "INSTANCE URL",
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            color = colors.textMuted,
                            letterSpacing = 0.5.sp
                        )
                        OutlinedTextField(
                            value = state.url,
                            onValueChange = onUrlChanged,
                            placeholder = { Text("http://localhost:4000", color = colors.textGhost, fontSize = 13.sp) },
                            trailingIcon = {
                                IconButton(onClick = onProbeClicked) {
                                    if (state.isProbing) {
                                        CircularProgressIndicator(
                                            color = colors.btnPrimaryBg,
                                            modifier = Modifier.size(16.dp)
                                        )
                                    } else {
                                        Icon(
                                            imageVector = Icons.Default.Refresh,
                                            contentDescription = "Test connection",
                                            tint = colors.textSecondary,
                                            modifier = Modifier.size(16.dp)
                                        )
                                    }
                                }
                            },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth(),
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

                        // Quick Connection Presets
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            ConnectionPresetPill(
                                label = "Localhost :4000",
                                onClick = {
                                    onUrlChanged("http://localhost:4000")
                                    onProbeClicked()
                                },
                                modifier = Modifier.weight(1f)
                            )
                            ConnectionPresetPill(
                                label = "Localhost :3000",
                                onClick = {
                                    onUrlChanged("http://localhost:3000")
                                    onProbeClicked()
                                },
                                modifier = Modifier.weight(1f)
                            )
                            ConnectionPresetPill(
                                label = "10.0.2.2 :4000",
                                onClick = {
                                    onUrlChanged("http://10.0.2.2:4000")
                                    onProbeClicked()
                                },
                                modifier = Modifier.weight(1f)
                            )
                        }
                    }

                    // Live Discovery Result Pill
                    if (state.discoveredEnv != null) {
                        val env = state.discoveredEnv
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(colors.bgSubtle)
                                .border(1.dp, colors.borderSubtle, RoundedCornerShape(8.dp))
                                .padding(10.dp)
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(
                                        text = "Openship v${env.version}",
                                        fontWeight = FontWeight.SemiBold,
                                        fontSize = 12.sp,
                                        color = colors.textHeading
                                    )
                                    Text(
                                        text = "${env.deployMode?.replaceFirstChar { it.uppercase() } ?: "Docker"} · ${env.authMode}",
                                        fontSize = 11.sp,
                                        color = colors.textMuted
                                    )
                                }
                                StatusBadge(text = "Online", kind = StatusKind.SUCCESS, pulseDot = true, compact = true)
                            }
                        }
                    }

                    // Server Label Field
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            text = "SERVER LABEL",
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            color = colors.textMuted,
                            letterSpacing = 0.5.sp
                        )
                        OutlinedTextField(
                            value = state.label,
                            onValueChange = onLabelChanged,
                            placeholder = { Text("Local Server", color = colors.textGhost, fontSize = 13.sp) },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth(),
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
                    }

                    // Personal Access Token (PAT) Field
                    AnimatedVisibility(visible = state.discoveredEnv?.authMode != "none") {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                text = "PERSONAL ACCESS TOKEN (PAT)",
                                fontSize = 10.sp,
                                fontWeight = FontWeight.Bold,
                                color = colors.textMuted,
                                letterSpacing = 0.5.sp
                            )
                            OutlinedTextField(
                                value = state.pat,
                                onValueChange = onPatChanged,
                                placeholder = { Text("opsh_pat_...", color = colors.textGhost, fontSize = 13.sp) },
                                visualTransformation = if (showPat) VisualTransformation.None else PasswordVisualTransformation(),
                                trailingIcon = {
                                    IconButton(onClick = { showPat = !showPat }) {
                                        Icon(
                                            imageVector = if (showPat) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                            contentDescription = "Toggle PAT Visibility",
                                            tint = colors.textMuted,
                                            modifier = Modifier.size(16.dp)
                                        )
                                    }
                                },
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.fillMaxWidth(),
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
                        }
                    }

                    // Error Message
                    if (state.probeError != null || state.connectError != null) {
                        Text(
                            text = state.probeError ?: state.connectError ?: "",
                            color = colors.statusFailed,
                            fontSize = 11.sp
                        )
                    }

                    // Connect Action Button
                    Button(
                        onClick = onConnectClicked,
                        enabled = !state.isConnecting,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(44.dp),
                        shape = RoundedCornerShape(8.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.btnPrimaryBg,
                            contentColor = colors.btnPrimaryText
                        )
                    ) {
                        if (state.isConnecting) {
                            CircularProgressIndicator(
                                color = colors.btnPrimaryText,
                                modifier = Modifier.size(18.dp)
                            )
                        } else {
                            Text(
                                text = "Connect Instance",
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 13.sp
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectionPresetPill(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = OpenshipAppTheme.colors

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(colors.bgSubtle)
            .border(1.dp, colors.borderSubtle, RoundedCornerShape(6.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = label,
            fontSize = 10.sp,
            fontWeight = FontWeight.Medium,
            color = colors.textSecondary,
            fontFamily = FontFamily.Monospace,
            maxLines = 1
        )
    }
}

