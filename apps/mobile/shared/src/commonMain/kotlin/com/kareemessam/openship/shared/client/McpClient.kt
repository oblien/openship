package com.kareemessam.openship.shared.client

import com.kareemessam.openship.shared.model.InstanceConfig
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.modelcontextprotocol.kotlin.sdk.client.Client
import io.modelcontextprotocol.kotlin.sdk.client.StreamableHttpClientTransport
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult
import io.modelcontextprotocol.kotlin.sdk.types.Implementation
import io.modelcontextprotocol.kotlin.sdk.types.ListToolsRequest
import io.modelcontextprotocol.kotlin.sdk.types.PaginatedRequestParams
import io.modelcontextprotocol.kotlin.sdk.types.TextContent
import io.modelcontextprotocol.kotlin.sdk.types.Tool

/**
 * Known Openship route-derived MCP tool names. The server generates these from
 * HTTP method + route path (see openship/apps/api/src/modules/mcp/mcp-tools.ts):
 * lowercase method + path segments (minus `api`), `:param` → `by_<param>`,
 * joined with `_`. Discover at runtime — these constants only drive resolution.
 */
object McpTools {
    const val GET_PROJECTS = "get_projects"
    const val GET_DEPLOYMENTS = "get_deployments"
    const val GET_DEPLOYMENTS_BY_ID = "get_deployments_by_id"
    const val POST_DEPLOYMENTS = "post_deployments"
    const val POST_DEPLOYMENTS_BY_ID_REDEPLOY = "post_deployments_by_id_redeploy"
    const val POST_DEPLOYMENTS_BY_ID_ROLLBACK = "post_deployments_by_id_rollback"
    const val POST_DEPLOYMENTS_BY_ID_CANCEL = "post_deployments_by_id_cancel"
}

/** Concatenated text content of a [CallToolResult] (the human-readable payload). */
fun CallToolResult.textContent(): String =
    content.filterIsInstance<TextContent>().joinToString("") { it.text }

/** MCP tool returned an error response. */
class McpToolException(val toolName: String, detail: String) :
    Exception("MCP tool '$toolName' failed: $detail")

/**
 * Map a raw [CallToolResult] into a domain [Result], failing when the server
 * flagged `isError`. Extracted as an extension so parsing is unit-testable
 * without a live MCP connection.
 */
fun CallToolResult.toDomainResult(toolName: String): Result<CallToolResult> =
    if (isError == true) {
        Result.failure(McpToolException(toolName, textContent().ifBlank { "unknown error" }))
    } else {
        Result.success(this)
    }

/**
 * MCP client wrapper: connect to `/api/mcp` with PAT auth, discover tools
 * at runtime, cache the catalog in memory for the active session, resolve known
 * route-derived tool names, and map MCP errors into [Result] failures.
 */
class McpClient(
    private val httpClient: HttpClient,
    private val discoveryService: DiscoveryService
) {
    internal var client: Client? = null
    internal var catalog: Map<String, Tool> = emptyMap()

    val isConnected: Boolean get() = client != null

    /** Full catalog of tools available to the current token/server version. */
    val tools: List<Tool> get() = catalog.values.toList()

    suspend fun connect(instance: InstanceConfig): Result<Unit> = runCatching {
        disconnect()
        val baseUrl = discoveryService.normalizeUrl(instance.url)
        val transport = StreamableHttpClientTransport(
            client = httpClient,
            url = "$baseUrl/api/mcp",
            requestBuilder = { header("Authorization", "Bearer ${instance.pat}") }
        )
        val mcp = Client(Implementation(name = "openship-android", version = "0.1.0"))
        mcp.connect(transport)
        client = mcp
        refreshCatalog().getOrThrow()
    }

    /** Re-fetch the full tool catalog, following pagination via [ListToolsResult.nextCursor]. */
    suspend fun refreshCatalog(): Result<List<Tool>> = runCatching {
        val mcp = client ?: error("MCP not connected")
        val tools = mutableListOf<Tool>()
        var cursor: String? = null
        do {
            val res = mcp.listTools(ListToolsRequest(PaginatedRequestParams(cursor)))
            tools.addAll(res.tools)
            cursor = res.nextCursor
        } while (cursor != null)
        catalog = tools.associateBy { it.name }
        tools
    }

    fun hasTool(name: String): Boolean = catalog.containsKey(name)

    fun resolveTool(name: String): Tool? = catalog[name]

    /**
     * Call an MCP tool by resolved name. Fails if not connected or the tool is
     * absent from the catalog (read-only/scoped token or older server). Maps
     * `isError` responses into [Result.failure].
     */
    suspend fun callTool(name: String, arguments: Map<String, Any?> = emptyMap()): Result<CallToolResult> = runCatching {
        val mcp = client ?: error("MCP not connected")
        if (!catalog.containsKey(name)) error("Tool '$name' not available for this token/server")
        mcp.callTool(name, arguments).toDomainResult(name).getOrThrow()
    }

    suspend fun disconnect() {
        client?.close()
        client = null
        catalog = emptyMap()
    }
}
