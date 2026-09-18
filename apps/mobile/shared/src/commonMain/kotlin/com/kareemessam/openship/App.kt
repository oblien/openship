package com.kareemessam.openship

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.navigation.compose.rememberNavController
import com.kareemessam.openship.shared.client.McpConnectionManager
import com.kareemessam.openship.shared.storage.TokenStorage
import com.kareemessam.openship.shared.ui.navigation.AppNavHost
import com.kareemessam.openship.shared.ui.navigation.Screen
import com.kareemessam.openship.shared.ui.theme.OpenshipTheme
import com.kareemessam.openship.shared.ui.theme.ThemeMode
import org.koin.compose.koinInject

import androidx.compose.runtime.rememberCoroutineScope
import coil3.ImageLoader
import coil3.compose.setSingletonImageLoaderFactory
import coil3.svg.SvgDecoder
import kotlinx.coroutines.launch

@Composable
fun App(
    tokenStorage: TokenStorage = koinInject(),
    mcpConnectionManager: McpConnectionManager = koinInject()
) {
    setSingletonImageLoaderFactory { context ->
        ImageLoader.Builder(context)
            .components {
                add(SvgDecoder.Factory())
            }
            .build()
    }

    val themeModeState = remember { mutableStateOf(ThemeMode.DARK) }
    var startDestination by remember { mutableStateOf<String?>(null) }
    val coroutineScope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current

    LaunchedEffect(Unit) {
        val active = tokenStorage.getActiveInstance()
        startDestination = if (active != null) Screen.Dashboard.route else Screen.Connect.route
        mcpConnectionManager.connectActive()
    }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> {
                    coroutineScope.launch {
                        mcpConnectionManager.connectActive()
                    }
                }
                Lifecycle.Event.ON_STOP -> {
                    coroutineScope.launch {
                        mcpConnectionManager.disconnect()
                    }
                }
                else -> {}
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    OpenshipTheme(themeModeState = themeModeState) {
        val colors = com.kareemessam.openship.shared.ui.theme.OpenshipAppTheme.colors
        val currentStart = startDestination
        if (currentStart == null) {
            Box(
                modifier = Modifier.fillMaxSize().background(colors.bgPage),
                contentAlignment = Alignment.Center
            ) {
                CircularProgressIndicator(
                    color = colors.btnPrimaryBg,
                    modifier = Modifier.size(36.dp)
                )
            }
        } else {
            val navController = rememberNavController()
            AppNavHost(navController = navController, startDestination = currentStart)
        }
    }
}
