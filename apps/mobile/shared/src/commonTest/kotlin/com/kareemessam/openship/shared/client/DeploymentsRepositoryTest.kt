package com.kareemessam.openship.shared.client

import com.kareemessam.openship.shared.model.DeploymentDto
import com.kareemessam.openship.shared.model.DeploymentsApiResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DeploymentsRepositoryTest {

    @Test
    fun decode_deployments_json_maps_fields_and_ignores_unknowns() {
        val json = """
            {
              "data": [
                {
                  "id": "dep_1",
                  "projectId": "proj_1",
                  "branch": "main",
                  "commitSha": "abcdef1234567890",
                  "commitMessage": "fix: rollout",
                  "status": "ready",
                  "createdAt": "2026-08-20T10:00:00.000Z",
                  "brandNewServerField": { "nested": true }
                },
                {
                  "id": "dep_2",
                  "projectId": "proj_1",
                  "status": "building",
                  "createdAt": "2026-08-21T09:00:00.000Z"
                }
              ],
              "total": 2,
              "page": 1,
              "perPage": 100
            }
        """.trimIndent()

        val decoded = HttpClientFactory.tolerantJson.decodeFromString<DeploymentsApiResponse>(json)

        assertEquals(2, decoded.data.size)
        assertEquals("abcdef1234567890", decoded.data[0].commitSha)
        assertEquals("fix: rollout", decoded.data[0].commitMessage)
        assertEquals("proj_1", decoded.data[0].projectId)
        assertEquals("ready", decoded.data[0].status)
        assertEquals(2, decoded.total)
        // missing nullable fields coerce to null, unknown fields are ignored
        assertNull(decoded.data[1].commitSha)
        assertNull(decoded.data[1].commitMessage)
    }

    @Test
    fun sortNewestFirst_orders_by_createdAt_descending() {
        val older = deployment("old", "2026-08-19T10:00:00.000Z")
        val newer = deployment("new", "2026-08-22T10:00:00.000Z")
        val middle = deployment("mid", "2026-08-21T10:00:00.000Z")

        val sorted = sortNewestFirst(listOf(older, newer, middle))

        assertEquals(listOf("new", "mid", "old"), sorted.map { it.id })
    }

    @Test
    fun sortNewestFirst_puts_missing_dates_last() {
        val noDate = deployment("nodate", null)
        val dated = deployment("dated", "2026-08-20T10:00:00.000Z")

        val sorted = sortNewestFirst(listOf(noDate, dated))

        assertEquals(listOf("dated", "nodate"), sorted.map { it.id })
    }

    private fun deployment(id: String, createdAt: String?): DeploymentDto = DeploymentDto(
        id = id,
        projectId = "proj_1",
        commitSha = "abc1234",
        commitMessage = "msg",
        status = "ready",
        createdAt = createdAt
    )
}
