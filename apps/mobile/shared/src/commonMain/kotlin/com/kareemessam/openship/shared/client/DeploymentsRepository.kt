package com.kareemessam.openship.shared.client

import com.kareemessam.openship.shared.model.DeploymentDto
import com.kareemessam.openship.shared.model.DeploymentsApiResponse
import com.kareemessam.openship.shared.model.InstanceConfig
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.http.HttpHeaders

/**
 * Fetches and manages a project's deployment history via the OpenShip REST API.
 */
open class DeploymentsRepository(
    private val httpClient: HttpClient,
    private val discoveryService: DiscoveryService
) {

    open suspend fun getDeploymentHistory(
        instance: InstanceConfig,
        projectId: String
    ): Result<List<DeploymentDto>> = runCatching {
        val baseUrl = discoveryService.normalizeUrl(instance.url)
        val response: DeploymentsApiResponse = httpClient.get("$baseUrl/api/deployments") {
            parameter("projectId", projectId)
            parameter("perPage", 100)
            if (instance.pat.isNotBlank()) {
                header(HttpHeaders.Authorization, "Bearer ${instance.pat}")
            }
        }.body()

        sortNewestFirst(response.data)
    }
}

// Server emits UTC ("Z") timestamps, allowing standard descending lexicographical sort.
internal fun sortNewestFirst(deployments: List<DeploymentDto>): List<DeploymentDto> =
    deployments.sortedByDescending { it.createdAt ?: "" }
