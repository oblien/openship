package com.kareemessam.openship.shared.client

import com.kareemessam.openship.shared.model.ProjectDto
import com.kareemessam.openship.shared.model.ProjectsApiResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ProjectsRepositoryTest {

    @Test
    fun decode_projects_json_parses_all_fields_with_tolerant_json() {
        val json = """
            {
              "data": [
                {
                  "id": "proj_next",
                  "name": "Frontend Web",
                  "slug": "frontend-web",
                  "framework": "nextjs",
                  "gitOwner": "oblien",
                  "gitRepo": "web-ui",
                  "gitBranch": "main",
                  "port": 3000,
                  "hostPort": 3001,
                  "activeDeploymentId": "dep_active_1",
                  "extraFutureField": "ignored"
                },
                {
                  "id": "proj_docker",
                  "name": "Worker Service",
                  "framework": "dockerfile",
                  "port": 8080
                }
              ],
              "total": 2,
              "page": 1,
              "perPage": 50
            }
        """.trimIndent()

        val response = HttpClientFactory.tolerantJson.decodeFromString<ProjectsApiResponse>(json)

        assertEquals(2, response.data.size)
        val p1 = response.data[0]
        assertEquals("proj_next", p1.id)
        assertEquals("Frontend Web", p1.name)
        assertEquals("frontend-web", p1.slug)
        assertEquals("nextjs", p1.framework)
        assertEquals("oblien", p1.gitOwner)
        assertEquals("web-ui", p1.gitRepo)
        assertEquals(3000, p1.port)
        assertEquals(3001, p1.hostPort)
        assertEquals("dep_active_1", p1.activeDeploymentId)

        val p2 = response.data[1]
        assertEquals("proj_docker", p2.id)
        assertEquals("dockerfile", p2.framework)
        assertNull(p2.slug)
        assertNull(p2.gitOwner)
    }
}
