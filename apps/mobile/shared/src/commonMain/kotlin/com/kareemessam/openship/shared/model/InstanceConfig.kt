package com.kareemessam.openship.shared.model

import kotlinx.serialization.Serializable

@Serializable
data class InstanceConfig(
    val id: String,
    val label: String,
    val url: String,
    val pat: String,
    val authMode: String = "local",
    val version: String? = null,
    val isDefault: Boolean = false,
    val createdAt: Long = 0L
) {
    override fun toString(): String =
        "InstanceConfig(id=$id, label=$label, url=$url, pat=${if (pat.isBlank()) "empty" else "[REDACTED]"}, authMode=$authMode, version=$version, isDefault=$isDefault, createdAt=$createdAt)"
}
