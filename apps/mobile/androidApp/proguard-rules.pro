# Openship-App release shrink rules (R8 full mode)

-keepattributes SourceFile,LineNumberTable,*Annotation*,InnerClasses,EnclosingMethod,Signature,Exceptions
-renamesourcefileattribute SourceFile

# --- App entry / Compose ---
-keep class com.kareemessam.openship.OpenshipApplication { *; }
-keep class com.kareemessam.openship.MainActivity { *; }
-keep class androidx.compose.runtime.** { *; }

# --- kotlinx.serialization (models + generated serializers) ---
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault
-dontnote kotlinx.serialization.AnnotationsKt

-keep,includedescriptorclasses class com.kareemessam.openship.**$$serializer { *; }
-if @kotlinx.serialization.Serializable class **
-keepclassmembers class <1> {
    static <1>$Companion Companion;
}
-if @kotlinx.serialization.Serializable class ** {
    static **$* *;
}
-keepclassmembers class <2>$<3> {
    kotlinx.serialization.KSerializer serializer(...);
}
-if @kotlinx.serialization.Serializable class ** {
    public static ** INSTANCE;
}
-keepclassmembers class <1> {
    public static <1> INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclassmembers class com.kareemessam.openship.** {
    *** Companion;
}
-keepclasseswithmembers class com.kareemessam.openship.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# --- Ktor / OkHttp / Okio ---
-dontwarn io.ktor.**
-dontwarn kotlinx.coroutines.**
-dontwarn org.slf4j.**
-keepclassmembers class io.ktor.** { *; }
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.internal.publicsuffix.PublicSuffixDatabase

# --- Koin ---
-keep class org.koin.** { *; }
-keepclassmembers class * {
    @org.koin.core.annotation.* <methods>;
}
-keepclassmembers class * extends org.koin.core.module.Module { *; }

# --- MCP SDK ---
-dontwarn io.modelcontextprotocol.**
-keep class io.modelcontextprotocol.** { *; }

# --- Coil 3 ---
-dontwarn coil3.**
-keep class coil3.** { *; }

# --- Coroutines ---
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-keepclassmembers class kotlinx.coroutines.** {
    volatile <fields>;
}

# --- AndroidX Security / Tink (EncryptedSharedPreferences) ---
-dontwarn com.google.crypto.tink.**
-keep class com.google.crypto.tink.** { *; }
-keep class androidx.security.crypto.** { *; }

# --- Enums used in JSON / when ---
-keepclassmembers enum com.kareemessam.openship.** {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
