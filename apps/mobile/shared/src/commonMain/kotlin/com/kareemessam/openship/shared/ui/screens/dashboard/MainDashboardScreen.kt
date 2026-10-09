package com.kareemessam.openship.shared.ui.screens.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ShowChart
import androidx.compose.material.icons.automirrored.outlined.ShowChart
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kareemessam.openship.shared.model.ProjectSummary
import com.kareemessam.openship.shared.ui.screens.monitor.ServerMonitorScreen
import com.kareemessam.openship.shared.ui.screens.projects.ProjectsScreen
import com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme
import com.kareemessam.openship.shared.viewmodel.ProjectsViewModel
import org.koin.compose.viewmodel.koinViewModel

enum class DashboardTab {
    PROJECTS,
    MONITOR
}

@Composable
fun MainDashboardScreen(
    onAddInstanceClicked: () -> Unit,
    onProjectClicked: (ProjectSummary) -> Unit,
    onOpenDeploymentLogs: (ProjectSummary, String) -> Unit,
    onHistoryClicked: (ProjectSummary) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: ProjectsViewModel = koinViewModel()
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var selectedTab by remember { mutableStateOf(DashboardTab.PROJECTS) }
    val colors = OpenshipAppTheme.colors

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            Column(modifier = Modifier.fillMaxWidth().background(colors.bgPage)) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(colors.borderSubtle)
                )
                NavigationBar(
                    containerColor = colors.bgPage,
                    tonalElevation = 0.dp,
                    windowInsets = NavigationBarDefaults.windowInsets,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    NavigationBarItem(
                        selected = selectedTab == DashboardTab.PROJECTS,
                        onClick = { selectedTab = DashboardTab.PROJECTS },
                        icon = {
                            Icon(
                                imageVector = if (selectedTab == DashboardTab.PROJECTS) Icons.Filled.GridView else Icons.Outlined.GridView,
                                contentDescription = "Projects"
                            )
                        },
                        label = {
                            Text(
                                "Projects",
                                fontSize = 11.sp,
                                fontWeight = if (selectedTab == DashboardTab.PROJECTS) FontWeight.SemiBold else FontWeight.Normal
                            )
                        },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = colors.textHeading,
                            selectedTextColor = colors.textHeading,
                            indicatorColor = colors.bgCard,
                            unselectedIconColor = colors.textMuted,
                            unselectedTextColor = colors.textMuted
                        )
                    )

                    NavigationBarItem(
                        selected = selectedTab == DashboardTab.MONITOR,
                        onClick = { selectedTab = DashboardTab.MONITOR },
                        icon = {
                            Icon(
                                imageVector = if (selectedTab == DashboardTab.MONITOR) Icons.AutoMirrored.Filled.ShowChart else Icons.AutoMirrored.Outlined.ShowChart,
                                contentDescription = "Monitoring"
                            )
                        },
                        label = {
                            Text(
                                "Monitoring",
                                fontSize = 11.sp,
                                fontWeight = if (selectedTab == DashboardTab.MONITOR) FontWeight.SemiBold else FontWeight.Normal
                            )
                        },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = colors.textHeading,
                            selectedTextColor = colors.textHeading,
                            indicatorColor = colors.bgCard,
                            unselectedIconColor = colors.textMuted,
                            unselectedTextColor = colors.textMuted
                        )
                    )
                }
            }
        },
        containerColor = colors.bgPage,
        modifier = modifier
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            when (selectedTab) {
                DashboardTab.PROJECTS -> {
                    ProjectsScreen(
                        state = state,
                        onRefresh = viewModel::refresh,
                        onSearchChanged = viewModel::onSearchQueryChanged,
                        onInstanceSelected = viewModel::switchInstance,
                        onAddInstanceClicked = onAddInstanceClicked,
                        onProjectClicked = onProjectClicked,
                        onRedeployClick = viewModel::onRedeployClick,
                        onRedeployConfirm = viewModel::confirmRedeploy,
                        onRedeployCancel = viewModel::cancelRedeploy,
                        onRedeployResultConsumed = viewModel::consumeRedeployResult,
                        onOpenLogs = onOpenDeploymentLogs,
                        onHistoryClick = onHistoryClicked
                    )
                }
                DashboardTab.MONITOR -> {
                    ServerMonitorScreen(
                        onAddInstanceClicked = onAddInstanceClicked
                    )
                }
            }
        }
    }
}
