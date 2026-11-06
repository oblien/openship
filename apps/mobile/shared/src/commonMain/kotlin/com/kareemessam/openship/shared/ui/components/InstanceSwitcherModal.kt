package com.kareemessam.openship.shared.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme

@Composable
fun InstanceSwitcherModal(
    isOpen: Boolean,
    activeInstance: InstanceConfig?,
    allInstances: List<InstanceConfig>,
    onDismiss: () -> Unit,
    onInstanceSelected: (String) -> Unit,
    onAddInstanceClicked: () -> Unit,
    onDeleteInstance: ((String) -> Unit)? = null
) {
    if (!isOpen) return

    val colors = OpenshipAppTheme.colors

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.Dns,
                        contentDescription = "Instances",
                        tint = colors.textHeading,
                        modifier = Modifier.size(18.dp)
                    )
                    Text(
                        text = "Connected Instances",
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.textHeading
                    )
                }

                IconButton(
                    onClick = onDismiss,
                    modifier = Modifier.size(28.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Close",
                        tint = colors.textMuted,
                        modifier = Modifier.size(16.dp)
                    )
                }
            }
        },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Text(
                    text = "Select an active Openship server to manage:",
                    fontSize = 12.sp,
                    color = colors.textMuted
                )

                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 280.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(allInstances, key = { it.id }) { instance ->
                        val isSelected = instance.id == activeInstance?.id

                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .background(if (isSelected) colors.bgSubtle else colors.bgPage)
                                .border(
                                    1.dp,
                                    if (isSelected) colors.borderFocus else colors.borderSubtle,
                                    RoundedCornerShape(10.dp)
                                )
                                .clickable {
                                    onInstanceSelected(instance.id)
                                    onDismiss()
                                }
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(
                                modifier = Modifier.weight(1f),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp)
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .clip(CircleShape)
                                        .background(if (isSelected) colors.statusActive else colors.textGhost)
                                )

                                Column {
                                    Text(
                                        text = instance.label,
                                        fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                                        fontSize = 13.sp,
                                        color = if (isSelected) colors.textHeading else colors.textPrimary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                    Text(
                                        text = instance.url,
                                        fontSize = 11.sp,
                                        color = colors.textMuted,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                }
                            }

                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp)
                            ) {
                                if (isSelected) {
                                    Icon(
                                        imageVector = Icons.Default.Check,
                                        contentDescription = "Active",
                                        tint = colors.statusActive,
                                        modifier = Modifier.size(16.dp)
                                    )
                                }

                                if (onDeleteInstance != null && allInstances.size > 1) {
                                    IconButton(
                                        onClick = { onDeleteInstance(instance.id) },
                                        modifier = Modifier.size(24.dp)
                                    ) {
                                        Icon(
                                            imageVector = Icons.Default.Delete,
                                            contentDescription = "Delete",
                                            tint = colors.statusFailed.copy(alpha = 0.7f),
                                            modifier = Modifier.size(14.dp)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    onDismiss()
                    onAddInstanceClicked()
                },
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.btnPrimaryBg,
                    contentColor = colors.btnPrimaryText
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Icon(
                    imageVector = Icons.Default.Add,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp)
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = "Connect New Server",
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 13.sp
                )
            }
        },
        containerColor = colors.bgCard,
        shape = RoundedCornerShape(16.dp),
        tonalElevation = 4.dp
    )
}

