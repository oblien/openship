package com.kareemessam.openship.shared.client

import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.model.ProjectSummary
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

private val DEPLOYMENT_ID_REGEX = Regex("dep_[A-Za-z0-9]+")

/** Field names the redeploy response may use to carry the new deployment id. */
private val DEPLOYMENT_ID_KEYS = listOf("deployment_id", "deploymentId", "id")

/**
 * Wrapper over [McpClient] for remote deployment write actions (redeploy, rollback).
 * Read-only instances degrade naturally: [isRedeployAvailable] and
 * [isRollbackAvailable] are false when MCP is not connected or the token/server
 * lacks the matching tool, so the UI hides the action without extra plumbing.
 */
open class DeployActionsRepository(private val mcpClient: McpClient) {

    /** Is redeploy available for the current token/server? */
    open fun isRedeployAvailable(): Boolean =
        mcpClient.isConnected && (
            mcpClient.hasTool(McpTools.POST_DEPLOYMENTS_BY_ID_REDEPLOY) ||
            mcpClient.hasTool(McpTools.POST_DEPLOYMENTS)
        )

    /**
     * Redeploy an existing project. Returns the new deployment id on success
     * (extracted from the MCP response), or `null` when the id can't be parsed
     * (the UI still shows success + refresh, just won't auto-open logs).
     */
    open suspend fun redeploy(instance: InstanceConfig, project: ProjectSummary): Result<String?> = runCatching {
        val activeDepId = project.activeDeploymentId
        val tool: String
        val args: Map<String, Any?>
        if (mcpClient.hasTool(McpTools.POST_DEPLOYMENTS_BY_ID_REDEPLOY) && !activeDepId.isNullOrBlank()) {
            tool = McpTools.POST_DEPLOYMENTS_BY_ID_REDEPLOY
            args = mapOf<String, Any?>("id" to activeDepId)
        } else {
            tool = McpTools.POST_DEPLOYMENTS
            args = mapOf<String, Any?>("projectId" to project.id)
        }
        val result = mcpClient.callTool(tool, args).getOrThrow()
        extractDeploymentId(result.structuredContent, result.textContent())
    }

    /** Is rollback available for the current token/server? */
    open fun isRollbackAvailable(): Boolean =
        mcpClient.isConnected && mcpClient.hasTool(McpTools.POST_DEPLOYMENTS_BY_ID_ROLLBACK)

    /**
     * Rollback to a prior deployment by id. Returns the new deployment id on
     * success, or `null` when it can't be parsed. [instance] is unused (the MCP
     * client is already connected) — kept for API symmetry with [redeploy].
     */
    open suspend fun rollback(instance: InstanceConfig, deploymentId: String): Result<String?> = runCatching {
        val result = mcpClient.callTool(
            McpTools.POST_DEPLOYMENTS_BY_ID_ROLLBACK,
            mapOf<String, Any?>("id" to deploymentId)
        ).getOrThrow()
        extractDeploymentId(result.structuredContent, result.textContent())
    }
}

/**
 * Extract a deployment id (`dep_…`) from an MCP result, tolerant to the
 * server's JSON shape: top-level `deployment_id`/`deploymentId`/`id`,
 * the same under `data`, else a `dep_…` token in the text content.
 */
internal fun extractDeploymentId(structuredContent: JsonObject?, text: String): String? {
    fun firstId(obj: JsonObject?): String? {
        obj ?: return null
        for (key in DEPLOYMENT_ID_KEYS) {
            val value = obj[key]?.jsonPrimitive?.contentOrNull
            if (!value.isNullOrBlank()) return value
        }
        return null
    }
    firstId(structuredContent)?.let { return it }
    firstId(structuredContent?.get("data") as? JsonObject)?.let { return it }
    return DEPLOYMENT_ID_REGEX.find(text)?.value
}
