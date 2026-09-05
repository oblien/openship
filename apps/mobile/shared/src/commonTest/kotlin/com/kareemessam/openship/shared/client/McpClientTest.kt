package com.kareemessam.openship.shared.client

import io.modelcontextprotocol.kotlin.sdk.client.Client
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult
import io.modelcontextprotocol.kotlin.sdk.types.Implementation
import io.modelcontextprotocol.kotlin.sdk.types.TextContent
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class McpClientTest {

    @Test
    fun textContent_concatates_text_blocks() {
        val result = CallToolResult(
            content = listOf(TextContent("hello "), TextContent("world")),
        )
        assertEquals("hello world", result.textContent())
    }

    @Test
    fun textContent_empty_when_no_text_blocks() {
        val result = CallToolResult(content = emptyList())
        assertEquals("", result.textContent())
    }

    @Test
    fun toDomainResult_success_when_not_error() {
        val result = CallToolResult(content = listOf(TextContent("ok")))
        val domain = result.toDomainResult("get_projects")
        assertTrue(domain.isSuccess)
        assertEquals(result, domain.getOrThrow())
    }

    @Test
    fun toDomainResult_failure_when_isError_true() {
        val result = CallToolResult(
            content = listOf(TextContent("project not found")),
            isError = true,
        )
        val domain = result.toDomainResult("get_projects")
        assertTrue(domain.isFailure)
        val ex = domain.exceptionOrNull()
        assertIs<McpToolException>(ex)
        assertEquals("get_projects", ex.toolName)
        assertTrue(ex.message!!.contains("project not found"))
    }

    @Test
    fun toDomainResult_failure_uses_fallback_message_when_error_text_blank() {
        val result = CallToolResult(content = emptyList(), isError = true)
        val domain = result.toDomainResult("post_deployments")
        assertTrue(domain.isFailure)
        assertTrue(domain.exceptionOrNull()!!.message!!.contains("post_deployments"))
    }

    @Test
    fun mcpTools_constants_match_route_derived_names() {
        // Generated from HTTP method + path: lowercase method + segments
        // (minus `api`), `:param` -> `by_<param>`, joined with `_`.
        assertEquals("get_projects", McpTools.GET_PROJECTS)
        assertEquals("get_deployments", McpTools.GET_DEPLOYMENTS)
        assertEquals("get_deployments_by_id", McpTools.GET_DEPLOYMENTS_BY_ID)
        assertEquals("post_deployments", McpTools.POST_DEPLOYMENTS)
        assertEquals("post_deployments_by_id_redeploy", McpTools.POST_DEPLOYMENTS_BY_ID_REDEPLOY)
        assertEquals("post_deployments_by_id_rollback", McpTools.POST_DEPLOYMENTS_BY_ID_ROLLBACK)
        assertEquals("post_deployments_by_id_cancel", McpTools.POST_DEPLOYMENTS_BY_ID_CANCEL)
    }

    @Test
    fun callTool_fails_when_not_connected() = runBlocking {
        val mcp = McpClient(HttpClientFactory.create(), DiscoveryService(HttpClientFactory.create()))
        val result = mcp.callTool(McpTools.GET_PROJECTS)
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("not connected"))
    }

    @Test
    fun callTool_fails_when_tool_absent_from_catalog() = runBlocking {
        val mcp = McpClient(HttpClientFactory.create(), DiscoveryService(HttpClientFactory.create()))
        // Simulate a connected session whose token lacks the redeploy tool.
        mcp.client = Client(Implementation(name = "test", version = "0"))
        mcp.catalog = emptyMap()
        val result = mcp.callTool(McpTools.POST_DEPLOYMENTS_BY_ID_REDEPLOY)
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("not available"))
    }

    @Test
    fun hasTool_and_resolveTool_reflect_catalog() {
        val mcp = McpClient(HttpClientFactory.create(), DiscoveryService(HttpClientFactory.create()))
        // Empty catalog: nothing available (read-only fallback case).
        mcp.client = Client(Implementation(name = "test", version = "0"))
        mcp.catalog = emptyMap()
        assertEquals(false, mcp.hasTool(McpTools.GET_PROJECTS))
        assertNull(mcp.resolveTool(McpTools.GET_PROJECTS))
        assertTrue(mcp.isConnected)
    }
}
