package com.kareemessam.openship.shared.client

import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.model.ProjectStatus
import com.kareemessam.openship.shared.model.ProjectSummary
import io.modelcontextprotocol.kotlin.sdk.client.Client
import io.modelcontextprotocol.kotlin.sdk.types.Implementation
import io.modelcontextprotocol.kotlin.sdk.types.Tool
import io.modelcontextprotocol.kotlin.sdk.types.ToolSchema
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DeployActionsRepositoryTest {

    private fun mcpClient() = McpClient(HttpClientFactory.create(), DiscoveryService(HttpClientFactory.create()))

    private fun tool(name: String) = Tool(
        name = name,
        inputSchema = ToolSchema("object"),
        description = "test"
    )

    private fun connectedWith(vararg toolNames: String): McpClient {
        val mcp = mcpClient()
        mcp.client = Client(Implementation(name = "test", version = "0"))
        mcp.catalog = toolNames.map { it to tool(it) }.toMap()
        return mcp
    }

    private val instance = InstanceConfig(id = "inst_1", label = "x", url = "http://x", pat = "")

    private val project = ProjectSummary(
        id = "proj_1",
        name = "web",
        slug = "web",
        framework = "nextjs",
        gitRepo = "o/r",
        gitBranch = "main",
        port = 8080,
        hostPort = 8080,
        status = ProjectStatus.READY,
        statusText = "Ready",
        activeDeploymentId = "dep_abc",
        commitMessage = null,
        commitShaShort = null,
        updatedAt = null
    )

    @Test
    fun isRedeployAvailable_true_when_connected_and_has_redeploy_tool() {
        val repo = DeployActionsRepository(connectedWith(McpTools.POST_DEPLOYMENTS_BY_ID_REDEPLOY))
        assertTrue(repo.isRedeployAvailable())
    }

    @Test
    fun isRedeployAvailable_true_when_only_post_deployments_fallback() {
        val repo = DeployActionsRepository(connectedWith(McpTools.POST_DEPLOYMENTS))
        assertTrue(repo.isRedeployAvailable())
    }

    @Test
    fun isRedeployAvailable_false_when_not_connected() {
        val repo = DeployActionsRepository(mcpClient())
        assertFalse(repo.isRedeployAvailable())
    }

    @Test
    fun isRedeployAvailable_false_when_connected_but_no_write_tool() {
        val repo = DeployActionsRepository(connectedWith(McpTools.GET_PROJECTS))
        assertFalse(repo.isRedeployAvailable())
    }

    @Test
    fun redeploy_maps_error_when_not_connected() = runBlocking {
        val repo = DeployActionsRepository(mcpClient())
        val result = repo.redeploy(instance, project)
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("not connected"))
    }

    @Test
    fun isRollbackAvailable_true_when_connected_and_has_rollback_tool() {
        val repo = DeployActionsRepository(connectedWith(McpTools.POST_DEPLOYMENTS_BY_ID_ROLLBACK))
        assertTrue(repo.isRollbackAvailable())
    }

    @Test
    fun isRollbackAvailable_false_when_not_connected() {
        val repo = DeployActionsRepository(mcpClient())
        assertFalse(repo.isRollbackAvailable())
    }

    @Test
    fun isRollbackAvailable_false_when_connected_but_no_rollback_tool() {
        val repo = DeployActionsRepository(connectedWith(McpTools.POST_DEPLOYMENTS))
        assertFalse(repo.isRollbackAvailable())
    }

    @Test
    fun rollback_maps_error_when_not_connected() = runBlocking {
        val repo = DeployActionsRepository(mcpClient())
        val result = repo.rollback(instance, "dep_abc")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("not connected"))
    }

    @Test
    fun extractDeploymentId_from_structured_content() {
        val content = buildJsonObject { put("deployment_id", "dep_123") }
        assertEquals("dep_123", extractDeploymentId(content, ""))
    }

    @Test
    fun extractDeploymentId_from_nested_data() {
        val content = buildJsonObject { putJsonObject("data") { put("id", "dep_nested") } }
        assertEquals("dep_nested", extractDeploymentId(content, ""))
    }

    @Test
    fun extractDeploymentId_from_text() {
        assertEquals("dep_text123", extractDeploymentId(null, "ok {\"deployment_id\":\"dep_text123\"} done"))
    }

    @Test
    fun extractDeploymentId_null_when_absent() {
        assertNull(extractDeploymentId(buildJsonObject { put("success", true) }, "no id here"))
    }
}
