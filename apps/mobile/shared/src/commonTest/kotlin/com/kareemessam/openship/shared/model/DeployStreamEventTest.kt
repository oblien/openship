package com.kareemessam.openship.shared.model

import com.kareemessam.openship.shared.client.HttpClientFactory
import com.kareemessam.openship.shared.model.sse.DeployStreamEvent
import kotlin.test.Test
import kotlin.test.assertEquals

class DeployStreamEventTest {

    @Test
    fun decode_log_event() {
        val json = """
            {
              "data": "U3RhcnRpbmcgYnVpbGQuLi4=",
              "eventId": 101,
              "step": "BUILD",
              "stepStatus": "running",
              "level": "info"
            }
        """.trimIndent()

        val event = HttpClientFactory.tolerantJson.decodeFromString<DeployStreamEvent.Log>(json)
        assertEquals("U3RhcnRpbmcgYnVpbGQuLi4=", event.data)
        assertEquals(101L, event.eventId)
        assertEquals("BUILD", event.step)
        assertEquals("running", event.stepStatus)
        assertEquals("info", event.level)
    }

    @Test
    fun decode_complete_event() {
        val json = """
            {
              "status": "ready",
              "eventId": 200
            }
        """.trimIndent()

        val event = HttpClientFactory.tolerantJson.decodeFromString<DeployStreamEvent.Complete>(json)
        assertEquals("ready", event.status)
        assertEquals(200L, event.eventId)
    }

    @Test
    fun decode_service_status_event() {
        val json = """
            {
              "serviceName": "api",
              "status": "running",
              "containerId": "cnt_12345",
              "hostPort": 4000,
              "eventId": 305
            }
        """.trimIndent()

        val event = HttpClientFactory.tolerantJson.decodeFromString<DeployStreamEvent.ServiceStatus>(json)
        assertEquals("api", event.serviceName)
        assertEquals("running", event.status)
        assertEquals("cnt_12345", event.containerId)
        assertEquals(4000, event.hostPort)
    }
}
