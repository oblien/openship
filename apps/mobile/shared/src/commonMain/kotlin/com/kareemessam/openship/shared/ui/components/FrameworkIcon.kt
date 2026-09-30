package com.kareemessam.openship.shared.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme

private const val DEVICON_BASE = "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons"

/**
 * Official OpenShip stack icon registry matching @repo/core STACK_ICONS.
 */
val STACK_ICONS: Map<String, String> = mapOf(
    // Java / Kotlin
    "springboot" to "$DEVICON_BASE/spring/spring-original.svg",
    "spring" to "$DEVICON_BASE/spring/spring-original.svg",
    "java" to "$DEVICON_BASE/java/java-original.svg",
    "kotlin" to "$DEVICON_BASE/kotlin/kotlin-original.svg",
    "quarkus" to "$DEVICON_BASE/quarkus/quarkus-original.svg",

    // JS/TS - Frontend & Fullstack
    "nextjs" to "$DEVICON_BASE/nextjs/nextjs-original.svg",
    "next" to "$DEVICON_BASE/nextjs/nextjs-original.svg",
    "nuxt" to "$DEVICON_BASE/nuxtjs/nuxtjs-original.svg",
    "nuxtjs" to "$DEVICON_BASE/nuxtjs/nuxtjs-original.svg",
    "sveltekit" to "$DEVICON_BASE/svelte/svelte-original.svg",
    "svelte" to "$DEVICON_BASE/svelte/svelte-original.svg",
    "remix" to "$DEVICON_BASE/react/react-original.svg",
    "tanstack-start" to "$DEVICON_BASE/react/react-original.svg",
    "astro" to "$DEVICON_BASE/astro/astro-original.svg",
    "vite" to "$DEVICON_BASE/vitejs/vitejs-original.svg",
    "vitejs" to "$DEVICON_BASE/vitejs/vitejs-original.svg",
    "angular" to "$DEVICON_BASE/angular/angular-original.svg",
    "gatsby" to "$DEVICON_BASE/gatsby/gatsby-original.svg",
    "cra" to "$DEVICON_BASE/react/react-original.svg",
    "vue" to "$DEVICON_BASE/vuejs/vuejs-original.svg",
    "vuejs" to "$DEVICON_BASE/vuejs/vuejs-original.svg",
    "react" to "$DEVICON_BASE/react/react-original.svg",

    // JS/TS - Backend
    "express" to "$DEVICON_BASE/express/express-original.svg",
    "fastify" to "$DEVICON_BASE/fastify/fastify-original.svg",
    "nestjs" to "$DEVICON_BASE/nestjs/nestjs-original.svg",
    "koa" to "$DEVICON_BASE/nodejs/nodejs-original.svg",
    "adonis" to "$DEVICON_BASE/adonisjs/adonisjs-original.svg",
    "node" to "$DEVICON_BASE/nodejs/nodejs-original.svg",
    "nodejs" to "$DEVICON_BASE/nodejs/nodejs-original.svg",
    "bun" to "$DEVICON_BASE/bun/bun-original.svg",
    "deno" to "$DEVICON_BASE/denojs/denojs-original.svg",

    // Go
    "go" to "$DEVICON_BASE/go/go-original.svg",
    "golang" to "$DEVICON_BASE/go/go-original.svg",
    "gin" to "$DEVICON_BASE/go/go-original.svg",
    "fiber" to "$DEVICON_BASE/go/go-original.svg",
    "echo" to "$DEVICON_BASE/go/go-original.svg",

    // Rust
    "rust" to "$DEVICON_BASE/rust/rust-original.svg",
    "actix" to "$DEVICON_BASE/rust/rust-original.svg",
    "axum" to "$DEVICON_BASE/rust/rust-original.svg",
    "rocket" to "$DEVICON_BASE/rust/rust-original.svg",

    // Python
    "python" to "$DEVICON_BASE/python/python-original.svg",
    "django" to "$DEVICON_BASE/django/django-plain.svg",
    "flask" to "$DEVICON_BASE/flask/flask-original.svg",
    "fastapi" to "$DEVICON_BASE/fastapi/fastapi-original.svg",

    // Ruby
    "rails" to "$DEVICON_BASE/rails/rails-plain.svg",
    "ruby" to "$DEVICON_BASE/ruby/ruby-original.svg",
    "sinatra" to "$DEVICON_BASE/ruby/ruby-original.svg",

    // PHP
    "laravel" to "$DEVICON_BASE/laravel/laravel-original.svg",
    "symfony" to "$DEVICON_BASE/symfony/symfony-original.svg",
    "php" to "$DEVICON_BASE/php/php-original.svg",

    // C# / .NET
    "dotnet" to "$DEVICON_BASE/dotnetcore/dotnetcore-original.svg",
    "csharp" to "$DEVICON_BASE/csharp/csharp-original.svg",
    "blazor" to "$DEVICON_BASE/dotnetcore/dotnetcore-original.svg",

    // Elixir
    "elixir" to "$DEVICON_BASE/elixir/elixir-original.svg",
    "phoenix" to "$DEVICON_BASE/phoenix/phoenix-original.svg",

    // Containers & Infrastructure
    "docker" to "$DEVICON_BASE/docker/docker-original.svg",
    "docker-compose" to "$DEVICON_BASE/docker/docker-original.svg",
    "kubernetes" to "$DEVICON_BASE/kubernetes/kubernetes-original.svg",
    "nginx" to "$DEVICON_BASE/nginx/nginx-original.svg",
    "static" to "$DEVICON_BASE/html5/html5-original.svg"
)

fun getStackIconUrl(framework: String?): String? {
    if (framework.isNullOrBlank()) return null
    val key = framework.lowercase().trim()
    return STACK_ICONS[key] ?: STACK_ICONS.entries.firstOrNull { key.contains(it.key) }?.value
}

@Composable
fun FrameworkIcon(
    framework: String?,
    modifier: Modifier = Modifier,
    size: Dp = 22.dp
) {
    val colors = OpenshipAppTheme.colors
    val iconUrl = getStackIconUrl(framework)

    if (iconUrl != null) {
        AsyncImage(
            model = iconUrl,
            contentDescription = "$framework icon",
            contentScale = ContentScale.Fit,
            modifier = modifier.size(size)
        )
    } else {
        val initial = (framework?.takeIf { it.isNotBlank() } ?: "P").take(2).uppercase()
        Box(
            modifier = modifier
                .size(size)
                .clip(RoundedCornerShape(6.dp))
                .background(colors.bgSubtle),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = initial,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = colors.textHeading
            )
        }
    }
}
