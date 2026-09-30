package com.kareemessam.openship.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ProjectsApiResponse(
    val data: List<ProjectDto> = emptyList(),
    val total: Int? = null,
    val page: Int? = null,
    val perPage: Int? = null
)

@Serializable
data class ProjectDto(
    val id: String,
    val name: String,
    val slug: String? = null,
    val framework: String? = null,
    @SerialName("packageManager")
    val packageManager: String? = null,
    @SerialName("gitOwner")
    val gitOwner: String? = null,
    @SerialName("gitRepo")
    val gitRepo: String? = null,
    @SerialName("gitBranch")
    val gitBranch: String? = null,
    @SerialName("gitUrl")
    val gitUrl: String? = null,
    val port: Int? = null,
    @SerialName("hostPort")
    val hostPort: Int? = null,
    @SerialName("activeDeploymentId")
    val activeDeploymentId: String? = null,
    @SerialName("runtimeMode")
    val runtimeMode: String? = null,
    @SerialName("environmentName")
    val environmentName: String? = null,
    val disabledAt: String? = null,
    val deletedAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class DeploymentsApiResponse(
    val data: List<DeploymentDto> = emptyList(),
    val total: Int? = null,
    val page: Int? = null,
    val perPage: Int? = null
)

@Serializable
data class DeploymentDto(
    val id: String,
    @SerialName("projectId")
    val projectId: String,
    val branch: String? = null,
    @SerialName("commitSha")
    val commitSha: String? = null,
    @SerialName("commitMessage")
    val commitMessage: String? = null,
    val status: String? = null, // "ready", "building", "failed", "stopped", "queued"
    val framework: String? = null,
    val url: String? = null,
    val trigger: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

enum class ProjectStatus {
    READY,
    BUILDING,
    FAILED,
    STOPPED,
    QUEUED,
    UNKNOWN
}

data class ProjectSummary(
    val id: String,
    val name: String,
    val slug: String,
    val framework: String,
    val gitRepo: String?,
    val gitBranch: String?,
    val port: Int?,
    val hostPort: Int?,
    val status: ProjectStatus,
    val statusText: String,
    val activeDeploymentId: String?,
    val commitMessage: String?,
    val commitShaShort: String?,
    val updatedAt: String?
)
