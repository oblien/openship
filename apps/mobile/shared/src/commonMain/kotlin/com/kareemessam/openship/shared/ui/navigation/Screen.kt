package com.kareemessam.openship.shared.ui.navigation

import io.ktor.http.encodeURLPathPart

sealed interface Screen {
    val route: String

    data object Connect : Screen {
        override val route = "connect"
    }

    data object Dashboard : Screen {
        override val route = "dashboard"
    }

    data object Logs : Screen {
        override val route = "logs/{projectId}/{deploymentId}/{projectName}"

        fun createRoute(projectId: String, deploymentId: String, projectName: String): String {
            val encodedName = projectName.encodeURLPathPart()
            return "logs/$projectId/$deploymentId/$encodedName"
        }
    }

    data object DeploymentHistory : Screen {
        override val route = "history/{projectId}/{projectName}/{activeDeploymentId}"

        fun createRoute(projectId: String, projectName: String, activeDeploymentId: String?): String {
            val encodedName = projectName.encodeURLPathPart()
            val depId = activeDeploymentId ?: "none"
            return "history/$projectId/$encodedName/$depId"
        }
    }
}
