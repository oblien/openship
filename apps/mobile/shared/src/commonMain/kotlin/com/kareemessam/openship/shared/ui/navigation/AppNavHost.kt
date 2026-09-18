package com.kareemessam.openship.shared.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import com.kareemessam.openship.shared.storage.TokenStorage
import com.kareemessam.openship.shared.ui.screens.connect.ConnectScreen
import com.kareemessam.openship.shared.ui.screens.dashboard.MainDashboardScreen
import com.kareemessam.openship.shared.ui.screens.deployments.DeploymentHistoryScreen
import com.kareemessam.openship.shared.ui.screens.logs.DeployLogsScreen
import com.kareemessam.openship.shared.viewmodel.ConnectViewModel
import com.kareemessam.openship.shared.viewmodel.DeployLogsViewModel
import com.kareemessam.openship.shared.viewmodel.DeploymentHistoryViewModel
import io.ktor.http.decodeURLPart
import org.koin.compose.koinInject
import org.koin.compose.viewmodel.koinViewModel

@Composable
fun AppNavHost(
    navController: NavHostController,
    startDestination: String,
    modifier: Modifier = Modifier
) {
    NavHost(
        navController = navController,
        startDestination = startDestination,
        modifier = modifier
    ) {
        composable(Screen.Connect.route) {
            val viewModel: ConnectViewModel = koinViewModel()
            val state by viewModel.state.collectAsStateWithLifecycle()

            ConnectScreen(
                state = state,
                onUrlChanged = viewModel::onUrlChanged,
                onLabelChanged = viewModel::onLabelChanged,
                onPatChanged = viewModel::onPatChanged,
                onProbeClicked = viewModel::probeUrl,
                onConnectClicked = viewModel::connect,
                onSuccess = {
                    navController.navigate(Screen.Dashboard.route) {
                        popUpTo(Screen.Connect.route) { inclusive = true }
                    }
                }
            )
        }

        composable(Screen.Dashboard.route) {
            MainDashboardScreen(
                onAddInstanceClicked = {
                    navController.navigate(Screen.Connect.route)
                },
                onProjectClicked = { project ->
                    val depId = project.activeDeploymentId ?: "live"
                    navController.navigate(Screen.Logs.createRoute(project.id, depId, project.name))
                },
                onOpenDeploymentLogs = { project, deploymentId ->
                    navController.navigate(Screen.Logs.createRoute(project.id, deploymentId, project.name))
                },
                onHistoryClicked = { project ->
                    navController.navigate(
                        Screen.DeploymentHistory.createRoute(project.id, project.name, project.activeDeploymentId)
                    )
                }
            )
        }

        composable(
            route = Screen.Logs.route,
            arguments = listOf(
                navArgument("projectId") { type = NavType.StringType },
                navArgument("deploymentId") { type = NavType.StringType },
                navArgument("projectName") { type = NavType.StringType }
            )
        ) { backStackEntry ->
            val deploymentId = backStackEntry.arguments?.getString("deploymentId") ?: ""
            val rawName = backStackEntry.arguments?.getString("projectName") ?: ""
            val projectName = rawName.decodeURLPart()

            val viewModel: DeployLogsViewModel = koinViewModel()
            val state by viewModel.state.collectAsStateWithLifecycle()

            LaunchedEffect(deploymentId) {
                viewModel.initDeployment(projectName, deploymentId)
            }

            DeployLogsScreen(
                state = state,
                onBack = { navController.popBackStack() },
                onSearchChanged = viewModel::onSearchQueryChanged,
                onAutoScrollChanged = viewModel::setAutoScroll,
                onRetry = viewModel::retry,
                onResumeStream = viewModel::resumeStream,
                onPauseStream = viewModel::pauseStream
            )
        }

        composable(
            route = Screen.DeploymentHistory.route,
            arguments = listOf(
                navArgument("projectId") { type = NavType.StringType },
                navArgument("projectName") { type = NavType.StringType },
                navArgument("activeDeploymentId") { type = NavType.StringType }
            )
        ) { backStackEntry ->
            val projectId = backStackEntry.arguments?.getString("projectId") ?: ""
            val rawName = backStackEntry.arguments?.getString("projectName") ?: ""
            val projectName = rawName.decodeURLPart()
            val activeDeploymentId = backStackEntry.arguments
                ?.getString("activeDeploymentId")
                ?.takeIf { it != "none" }

            val tokenStorage: TokenStorage = koinInject()
            val viewModel: DeploymentHistoryViewModel = koinViewModel()
            val state by viewModel.state.collectAsStateWithLifecycle()

            LaunchedEffect(projectId) {
                val instance = tokenStorage.getActiveInstance() ?: tokenStorage.loadInstances().firstOrNull()
                if (instance != null) {
                    viewModel.loadHistory(instance, projectId, activeDeploymentId)
                }
            }

            DeploymentHistoryScreen(
                state = state,
                onBack = { navController.popBackStack() },
                onSelect = viewModel::selectDeployment,
                onRollback = viewModel::onRollbackClick,
                onRollbackConfirm = viewModel::confirmRollback,
                onRollbackCancel = viewModel::cancelRollback,
                onRollbackResultConsumed = viewModel::consumeRollbackResult,
                onOpenLogs = { deploymentId ->
                    navController.navigate(Screen.Logs.createRoute(projectId, deploymentId, projectName))
                },
                onDismiss = viewModel::clearSelection
            )
        }
    }
}
