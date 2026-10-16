package com.kareemessam.openship.shared.model

import com.kareemessam.openship.shared.client.HttpClientFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MonitorDtoTest {

    @Test
    fun decode_server_item_dto() {
        val json = """
            {
              "id": "srv_primary",
              "name": "Production VPS",
              "isLocal": true,
              "sshHost": "vps.example.com",
              "country": "US",
              "projectCount": 5
            }
        """.trimIndent()

        val srv = HttpClientFactory.tolerantJson.decodeFromString<ServerItemDto>(json)
        assertEquals("srv_primary", srv.id)
        assertEquals("Production VPS", srv.name)
        assertTrue(srv.isLocal == true)
        assertEquals("vps.example.com", srv.sshHost)
        assertEquals("US", srv.country)
        assertEquals(5, srv.projectCount)
    }

    @Test
    fun decode_monitor_stats_dto_and_computed_properties() {
        val json = """
            {
              "cpu": 34.5,
              "memTotal": 8589934592,
              "memUsed": 4294967296,
              "diskTotal": 107374182400,
              "diskUsed": 21474836480,
              "uptime": 864000,
              "load1": 1.25,
              "load5": 0.95,
              "load15": 0.80
            }
        """.trimIndent()

        val stats = HttpClientFactory.tolerantJson.decodeFromString<MonitorStatsDto>(json)
        assertEquals(34.5, stats.cpu)
        assertEquals(8589934592L, stats.memTotal)
        assertEquals(4294967296L, stats.memUsed)
        assertEquals(50.0f, stats.memPercentage)
        assertEquals(20.0f, stats.diskPercentage)
        assertEquals(864000L, stats.uptimeSeconds)
        assertEquals(1.25, stats.load1Val)
        assertEquals(0.95, stats.load5Val)
        assertEquals(0.80, stats.load15Val)
    }
}
